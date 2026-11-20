-- M3 stage 1: game detail for the app (docs/m3/07-roadmap.md §7.2–7.3, step 1).
-- Promoted unchanged from docs/m3/sql/0067_match_detail.draft.sql (validated 8 roles x 7 states,
-- field review S6). 0067 was reserved for this migration; it is the one number applied out of order,
-- after 0068-0071. Additive only: one nullable column and one check value that nothing writes yet,
-- and one read-only function. Not applied to staging or live without Paul's separate approval.
--
-- Who sees a game (GR-2): the organiser and accepted or pending players always; club staff and admins
-- always; any other signed-in user only while the game is open and has not started. Anonymous callers
-- cannot execute it. Identifiers (organizer_id, booking_id) only for insiders; the request count only
-- for the organiser. Tests: supabase/tests/m3/match_detail_0067.sh (T-MD1-MD6, mutation-checked).
--
-- Safe to re-run.

-- Court-lost state (03-journeys.md GR-9). Nothing writes these until the hardening migration's
-- booking trigger; they are added now so match_detail's shape never changes and the first native
-- slice can show the state. Widening the check allows a value no existing code writes.
alter table matches add column if not exists court_lost_at timestamptz;
alter table matches drop constraint if exists matches_closed_reason_check;
alter table matches add constraint matches_closed_reason_check
  check (closed_reason in ('full', 'organizer', 'no_court'));

create or replace function match_detail(p_match uuid)
returns table (
  match_id uuid, club_id uuid, club_name text, club_slug text, club_timezone text, town text,
  sport sport, start_at timestamptz, end_at timestamptz,
  level_min int, level_max int, level_legacy boolean, my_level int,
  players_needed int, joined int, pending int,
  status match_status, closed_reason text, court_lost boolean,
  note text, join_mode text, organizer_id uuid, organizer_name text,
  my_status text, i_organize boolean, has_court boolean, booking_id uuid, court_name text,
  started boolean, finished boolean, hidden boolean)
language sql stable security definer set search_path = public as $$
  select m.id, m.club_id, c.name, c.slug, c.timezone, t.name_en,
         m.sport, m.start_at, m.end_at,
         (match_level_bounds(m))[1], (match_level_bounds(m))[2], m.level_min is null and m.level is not null,
         (select pl.level from player_levels pl where pl.profile_id = auth.uid() and pl.sport = m.sport),
         m.players_needed,
         (select count(*) from match_players x where x.match_id = m.id and x.status = 'accepted')::int,
         -- request count only for the organiser
         case when m.organizer_id = auth.uid() then
           (select count(*) from match_players x where x.match_id = m.id and x.status = 'pending')::int end,
         m.status, m.closed_reason, m.court_lost_at is not null,
         m.note,                      -- organiser's public description: already on the board (open_matches)
         m.join_mode,
         -- identifiers only for insiders (organiser, accepted players, club staff, admin); others get
         -- null. Discovery needs neither (field review, docs/m3/02-safety-review.md S6).
         case when insider then m.organizer_id end,
         o.name,
         me.status, m.organizer_id = auth.uid(),
         m.booking_id is not null,
         case when insider then m.booking_id end,
         k.name,
         m.start_at <= now(),
         coalesce(m.end_at, m.start_at + interval '3 hours') <= now(),   -- same rule as hide_match
         exists (select 1 from match_hidden h where h.match_id = m.id and h.profile_id = auth.uid())
  from matches m
  left join clubs c on c.id = m.club_id
  left join towns t on t.id = c.town_id
  left join profiles o on o.id = m.organizer_id
  left join bookings b on b.id = m.booking_id
  left join courts k on k.id = b.court_id
  left join match_players me on me.match_id = m.id and me.profile_id = auth.uid()
  cross join lateral (select (m.organizer_id = auth.uid() or me.status = 'accepted'
                              or is_staff_of(m.club_id) or is_admin()) as insider) i
  where m.id = p_match
    and auth.uid() is not null
    and (
         m.organizer_id = auth.uid()                                   -- organiser: always
      or me.status in ('accepted', 'pending')                          -- member or requester: always
      or (m.status = 'open' and m.start_at > now())                    -- anyone signed in (incl. declined,
                                                                       --   removed, left): only while joinable
      or is_staff_of(m.club_id)                                        -- club staff (web staff pages)
      or is_admin()
    );
$$;
revoke all on function match_detail(uuid) from public, anon;
grant execute on function match_detail(uuid) to authenticated;
