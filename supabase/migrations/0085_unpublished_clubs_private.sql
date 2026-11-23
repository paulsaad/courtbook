-- 0085 — An unpublished club is not readable by visitors or ordinary players, including through the API (decided
-- 23 Nov, after the staging website acceptance run showed that a hidden club's row — name, address, contact — could
-- still be read directly).
--
-- Before: "unpublished" (clubs.active = false) closed the club's page, discovery, slots and booking, but the read rules
-- on clubs, courts, prices and photos only looked at demo hiding (0078). Now the one function those rules and the read
-- functions share, club_visible_to_me, also requires the club to be published:
--   - visitors and ordinary players: published clubs only (and demo clubs only while the demo switch is off, as before);
--   - the club's staff and admins: every club, published or not (unchanged);
--   - a player with history at the club (a booking, a game, a coach link) keeps reading it through
--     club_readable_by_me (unchanged), so past bookings and games still show their club, courts and prices.
--     Known and accepted for now (23 Nov review): that access is to the club's CURRENT rows, not a snapshot — such a
--     player can see the club's present name, address, contact, courts, prices and photos while it is unpublished,
--     including changes made after their booking or game. Narrowing it is a separate decision.
-- Through the existing rules this covers: clubs, courts, price_rules, club_media and open games (read policies);
-- club_discovery, club_day_slots, next_free_slot, quote_price, club_sports, match_board, match_detail, open_matches,
-- coaches_at_club, coach_card, coaches_directory, and new games and price quotes at the club (refused as before for a
-- hidden demo club).
-- The signed-in `occupancy` view (busy times on a club's page; it runs with its owner's rights) now leaves out clubs
-- the reader cannot see, except the reader's own bookings. `public_occupancy` already lists published clubs only.
-- Server work (no signed-in user: the SQL editor, seeds, service jobs) is unaffected. No booking, price, payment or
-- publishing rule changes. Re-runnable.

create or replace function club_visible_to_me(p_club uuid, p_is_demo boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select (coalesce((select c.active from clubs c where c.id = p_club), false)            -- 0085: published only
          and (not coalesce(p_is_demo, false) or not demo_clubs_hidden()))
      or (auth.uid() is not null and (is_staff_of(p_club) or is_admin()));
$$;
revoke all on function club_visible_to_me(uuid, boolean) from public, anon, authenticated;
grant execute on function club_visible_to_me(uuid, boolean) to authenticated, service_role;

create or replace view occupancy as
 SELECT
        CASE
            WHEN (bookings.player_id = auth.uid()) THEN bookings.id
            ELSE NULL::uuid
        END AS id,
    bookings.club_id,
    bookings.court_id,
    bookings.coach_id,
    bookings.start_at,
    bookings.end_at,
    bookings.status,
    (bookings.player_id = auth.uid()) AS mine,
    'booking'::text AS kind
   FROM bookings
  WHERE ((bookings.status = 'confirmed'::booking_status) OR ((bookings.status = 'pending'::booking_status) AND (bookings.hold_expires_at > now())))
    AND (bookings.player_id = auth.uid() OR club_id_visible_to_me(bookings.club_id))          -- 0085
UNION ALL
 SELECT NULL::uuid AS id,
    blocks.club_id,
    blocks.court_id,
    NULL::uuid AS coach_id,
    blocks.start_at,
    blocks.end_at,
    'confirmed'::booking_status AS status,
    false AS mine,
    'block'::text AS kind
   FROM blocks
  WHERE club_id_visible_to_me(blocks.club_id);                                                  -- 0085
