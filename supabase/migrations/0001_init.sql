-- CourtBook v0.1 — initial schema
-- Source of truth: "Court booking app — product spec v0.1" (Data model section).
-- Times are stored in UTC (timestamptz) and displayed in the club's timezone.

create extension if not exists btree_gist;   -- uuid equality inside gist exclusion constraints
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type app_role        as enum ('player', 'coach', 'staff', 'admin');
create type sport           as enum ('padel', 'tennis', 'other');
create type player_level    as enum ('beginner', 'intermediate', 'advanced');
create type booking_status  as enum ('confirmed', 'cancelled', 'no_show');
create type booking_source  as enum ('app', 'staff');
create type credit_kind     as enum ('purchase', 'booking', 'refund', 'admin_adjust');
create type match_status    as enum ('open', 'closed', 'cancelled');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  phone       text unique,
  name        text,
  level       player_level,
  sports      sport[] not null default '{}',
  roles       app_role[] not null default '{player}',
  created_at  timestamptz not null default now()
);

create table clubs (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  slug                 text not null unique check (slug ~ '^[a-z0-9-]+$'),
  location_url         text,
  timezone             text not null default 'Asia/Beirut',
  slot_minutes         int  not null default 90 check (slot_minutes in (60, 90)),
  cancel_cutoff_hours  int  not null default 12 check (cancel_cutoff_hours >= 0),
  open_time            time not null default '08:00',
  close_time           time not null default '23:00',
  active               boolean not null default true,
  created_at           timestamptz not null default now()
);

create table club_staff (
  club_id     uuid not null references clubs(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  role        text not null default 'staff' check (role in ('staff', 'manager')),
  primary key (club_id, profile_id)
);

create table courts (
  id        uuid primary key default gen_random_uuid(),
  club_id   uuid not null references clubs(id) on delete cascade,
  name      text not null,
  sport     sport not null,
  surface   text,
  active    boolean not null default true,
  sort      int not null default 0,
  unique (club_id, name)
);

create table price_rules (
  id            uuid primary key default gen_random_uuid(),
  club_id       uuid not null references clubs(id) on delete cascade,
  court_id      uuid references courts(id) on delete cascade,   -- null = whole club
  weekday_mask  int  not null default 127 check (weekday_mask between 1 and 127), -- bit0 = Monday ... bit6 = Sunday
  start_time    time not null,
  end_time      time not null,
  price_usd     numeric(8,2) not null check (price_usd >= 0),
  label         text,                                             -- 'peak' / 'off-peak'
  check (start_time < end_time)
);

create table coaches (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null unique references profiles(id) on delete cascade,
  sports      sport[] not null default '{}',
  price_usd   numeric(8,2) not null default 0 check (price_usd >= 0),
  bio         text,
  approved    boolean not null default false,
  club_ids    uuid[] not null default '{}',
  created_at  timestamptz not null default now()
);

create table availability_rules (
  id          uuid primary key default gen_random_uuid(),
  coach_id    uuid not null references coaches(id) on delete cascade,
  weekday     int  not null check (weekday between 0 and 6),   -- 0 = Monday ... 6 = Sunday
  start_time  time not null,
  end_time    time not null,
  check (start_time < end_time)
);

create table availability_exceptions (
  id          uuid primary key default gen_random_uuid(),
  coach_id    uuid not null references coaches(id) on delete cascade,
  date        date not null,
  start_time  time,
  end_time    time,
  available   boolean not null,
  check ((start_time is null) = (end_time is null)),
  check (start_time is null or start_time < end_time)
);

create table credit_packs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  credits    int  not null check (credits > 0),
  price_usd  numeric(8,2) not null check (price_usd > 0),
  active     boolean not null default true,
  sort       int not null default 0
);

create table bookings (
  id            uuid primary key default gen_random_uuid(),
  club_id       uuid not null references clubs(id),
  court_id      uuid references courts(id),
  coach_id      uuid references coaches(id),
  player_id     uuid references profiles(id),
  guest_name    text,
  guest_phone   text,
  start_at      timestamptz not null,
  end_at        timestamptz not null,
  period        tstzrange generated always as (tstzrange(start_at, end_at, '[)')) stored,
  status        booking_status not null default 'confirmed',
  source        booking_source not null,
  credit_tx_id  uuid,                                  -- fk added after credit_transactions
  created_by    uuid not null references profiles(id),
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  check (start_at < end_at),
  check ((court_id is null) <> (coach_id is null)),    -- exactly one of court / coach
  check (player_id is not null or guest_name is not null)
);

create table blocks (
  id          uuid primary key default gen_random_uuid(),
  club_id     uuid not null references clubs(id),
  court_id    uuid not null references courts(id) on delete cascade,
  start_at    timestamptz not null,
  end_at      timestamptz not null,
  period      tstzrange generated always as (tstzrange(start_at, end_at, '[)')) stored,
  reason      text,
  created_by  uuid not null references profiles(id),
  created_at  timestamptz not null default now(),
  check (start_at < end_at)
);

create table credit_transactions (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references profiles(id),
  delta        int  not null check (delta <> 0),
  kind         credit_kind not null,
  booking_id   uuid references bookings(id),
  pack_id      uuid references credit_packs(id),
  payment_ref  text,
  note         text,
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now()
);

alter table bookings
  add constraint bookings_credit_tx_fk foreign key (credit_tx_id) references credit_transactions(id);

create table matches (
  id              uuid primary key default gen_random_uuid(),
  club_id         uuid references clubs(id),
  sport           sport not null,
  organizer_id    uuid not null references profiles(id),
  start_at        timestamptz not null,
  level           player_level,
  players_needed  int not null check (players_needed between 1 and 20),
  status          match_status not null default 'open',
  booking_id      uuid references bookings(id),
  note            text,
  created_at      timestamptz not null default now()
);

create table match_players (
  match_id    uuid not null references matches(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (match_id, profile_id)
);

-- Indexes for the calendar queries
create index bookings_court_start_idx on bookings (court_id, start_at) where status = 'confirmed';
create index bookings_coach_start_idx on bookings (coach_id, start_at) where status = 'confirmed';
create index bookings_player_idx      on bookings (player_id, start_at);
create index blocks_court_start_idx   on blocks (court_id, start_at);
create index credit_tx_profile_idx    on credit_transactions (profile_id);
create index matches_club_start_idx   on matches (club_id, start_at) where status = 'open';

-- ---------------------------------------------------------------------------
-- Double-booking guard — enforced in the database, not the UI
-- ---------------------------------------------------------------------------
alter table bookings add constraint no_double_booking_court
  exclude using gist (court_id with =, period with &&)
  where (status = 'confirmed' and court_id is not null);

alter table bookings add constraint no_double_booking_coach
  exclude using gist (coach_id with =, period with &&)
  where (status = 'confirmed' and coach_id is not null);

alter table blocks add constraint no_overlapping_blocks
  exclude using gist (court_id with =, period with &&);

-- Bookings vs blocks: two tables, so a trigger. NOTE: new.period is NOT yet computed
-- in a BEFORE trigger (generated column), so the range is rebuilt from start/end. Both triggers lock the court row
-- first, which serializes concurrent booking/block writes on the same court and
-- closes the race between the two checks.
create or replace function reject_booking_over_block() returns trigger
language plpgsql as $$
begin
  if new.court_id is null or new.status <> 'confirmed' then
    return new;
  end if;
  perform 1 from courts where id = new.court_id for update;
  if exists (
    select 1 from blocks b
    where b.court_id = new.court_id and b.period && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception 'slot_blocked' using errcode = '23P01';
  end if;
  return new;
end $$;

create trigger bookings_block_check
  before insert or update of court_id, start_at, end_at, status on bookings
  for each row execute function reject_booking_over_block();

create or replace function reject_block_over_booking() returns trigger
language plpgsql as $$
begin
  perform 1 from courts where id = new.court_id for update;
  if exists (
    select 1 from bookings k
    where k.court_id = new.court_id and k.status = 'confirmed' and k.period && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception 'block_overlaps_booking' using errcode = '23P01';
  end if;
  return new;
end $$;

create trigger blocks_booking_check
  before insert or update of court_id, start_at, end_at on blocks
  for each row execute function reject_block_over_booking();

-- ---------------------------------------------------------------------------
-- Profiles: auto-create on signup; only admins may change roles
-- ---------------------------------------------------------------------------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, phone, name)
  values (new.id, new.phone, coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name'))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- Role helpers (security definer so RLS policies do not recurse)
-- ---------------------------------------------------------------------------
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select 'admin' = any(roles) from profiles where id = auth.uid()), false);
$$;

create or replace function is_staff_of(p_club uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or exists (
    select 1 from club_staff where club_id = p_club and profile_id = auth.uid()
  );
$$;

create or replace function my_coach_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from coaches where profile_id = auth.uid();
$$;

create or replace function credit_balance(p_profile uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(delta), 0)::int from credit_transactions where profile_id = p_profile;
$$;

create or replace function protect_profile_roles() returns trigger
language plpgsql as $$
begin
  -- auth.uid() is null for the SQL editor and the service role: those are trusted.
  if new.roles is distinct from old.roles and auth.uid() is not null and not is_admin() then
    new.roles := old.roles;
  end if;
  return new;
end $$;

create trigger profiles_protect_roles
  before update on profiles
  for each row execute function protect_profile_roles();

create or replace function protect_coach_approval() returns trigger
language plpgsql as $$
begin
  if new.approved is distinct from old.approved and auth.uid() is not null and not is_admin() then
    new.approved := old.approved;
  end if;
  return new;
end $$;

create trigger coaches_protect_approval
  before update on coaches
  for each row execute function protect_coach_approval();

-- ---------------------------------------------------------------------------
-- Atomic booking functions. The app never inserts into bookings directly for
-- players; it calls these. Exclusion constraint + credit ledger in one transaction.
-- ---------------------------------------------------------------------------
create or replace function book_slot(
  p_club uuid, p_court uuid, p_coach uuid, p_start timestamptz, p_end timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_player uuid := auth.uid();
  v_tx uuid;
  v_booking uuid;
begin
  if v_player is null then
    raise exception 'not_authenticated';
  end if;
  if p_start <= now() then
    raise exception 'slot_in_past';
  end if;
  if credit_balance(v_player) < 1 then
    raise exception 'insufficient_credits';
  end if;

  v_booking := gen_random_uuid();

  insert into credit_transactions (id, profile_id, delta, kind, booking_id, created_by)
  values (gen_random_uuid(), v_player, -1, 'booking', null, v_player)
  returning id into v_tx;

  insert into bookings (id, club_id, court_id, coach_id, player_id, start_at, end_at, source, credit_tx_id, created_by)
  values (v_booking, p_club, p_court, p_coach, v_player, p_start, p_end, 'app', v_tx, v_player);

  update credit_transactions set booking_id = v_booking where id = v_tx;
  return v_booking;
exception
  when exclusion_violation then
    raise exception 'slot_taken';            -- whole transaction rolls back: no credit spent
end $$;

create or replace function cancel_booking(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  b bookings%rowtype;
  cutoff int;
  is_staff boolean;
begin
  select * into b from bookings where id = p_booking for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'confirmed' then raise exception 'not_confirmed'; end if;

  is_staff := is_staff_of(b.club_id);
  if b.player_id is distinct from auth.uid() and not is_staff then
    raise exception 'forbidden';
  end if;

  select cancel_cutoff_hours into cutoff from clubs where id = b.club_id;

  update bookings set status = 'cancelled', cancelled_at = now() where id = p_booking;

  -- refund only app bookings that spent a credit, and only before the cutoff
  -- (staff cancelling on the club's behalf always refunds)
  if b.credit_tx_id is not null and (is_staff or b.start_at - make_interval(hours => cutoff) > now()) then
    insert into credit_transactions (profile_id, delta, kind, booking_id, created_by)
    values (b.player_id, +1, 'refund', b.id, auth.uid());
  end if;
end $$;

grant execute on function book_slot(uuid, uuid, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function cancel_booking(uuid) to authenticated;
grant execute on function credit_balance(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table profiles                enable row level security;
alter table clubs                   enable row level security;
alter table club_staff              enable row level security;
alter table courts                  enable row level security;
alter table price_rules             enable row level security;
alter table coaches                 enable row level security;
alter table availability_rules      enable row level security;
alter table availability_exceptions enable row level security;
alter table credit_packs            enable row level security;
alter table bookings                enable row level security;
alter table blocks                  enable row level security;
alter table credit_transactions     enable row level security;
alter table matches                 enable row level security;
alter table match_players           enable row level security;

-- profiles
create policy "profiles: read own"      on profiles for select using (id = auth.uid() or is_admin());
create policy "profiles: update own"    on profiles for update using (id = auth.uid() or is_admin());
create policy "profiles: insert own"    on profiles for insert with check (id = auth.uid());

-- public catalogue: anyone signed in reads; admin writes
create policy "clubs: read"             on clubs for select using (true);
create policy "clubs: admin write"      on clubs for all using (is_admin()) with check (is_admin());
create policy "courts: read"            on courts for select using (true);
create policy "courts: staff write"     on courts for all using (is_staff_of(club_id)) with check (is_staff_of(club_id));
create policy "price_rules: read"       on price_rules for select using (true);
create policy "price_rules: staff write" on price_rules for all using (is_staff_of(club_id)) with check (is_staff_of(club_id));
create policy "credit_packs: read"      on credit_packs for select using (true);
create policy "credit_packs: admin"     on credit_packs for all using (is_admin()) with check (is_admin());

-- club_staff: staff see their own club's roster; admin manages
create policy "club_staff: read"        on club_staff for select using (profile_id = auth.uid() or is_staff_of(club_id));
create policy "club_staff: admin"       on club_staff for all using (is_admin()) with check (is_admin());

-- coaches: approved coaches are public; a coach edits own row (approved flag protected by trigger above)
create policy "coaches: read approved"  on coaches for select using (approved or profile_id = auth.uid() or is_admin());
create policy "coaches: apply"          on coaches for insert with check (profile_id = auth.uid() and approved = false);
create policy "coaches: edit own"       on coaches for update using (profile_id = auth.uid() or is_admin());
create policy "coaches: admin delete"   on coaches for delete using (is_admin());

create policy "avail_rules: read"       on availability_rules for select using (true);
create policy "avail_rules: own"        on availability_rules for all using (coach_id = my_coach_id() or is_admin()) with check (coach_id = my_coach_id() or is_admin());
create policy "avail_exc: read"         on availability_exceptions for select using (true);
create policy "avail_exc: own"          on availability_exceptions for all using (coach_id = my_coach_id() or is_admin()) with check (coach_id = my_coach_id() or is_admin());

-- bookings: a player sees only own rows; staff see their club's. The availability
-- grid reads the `occupancy` view below (no names/phones). Players create only
-- through book_slot (security definer), so no direct insert policy for players.
create policy "bookings: read"          on bookings for select using (player_id = auth.uid() or is_staff_of(club_id));
create policy "bookings: staff insert"  on bookings for insert with check (is_staff_of(club_id) and source = 'staff' and created_by = auth.uid());
create policy "bookings: staff update"  on bookings for update using (is_staff_of(club_id));
create policy "bookings: staff delete"  on bookings for delete using (is_admin());

-- blocks
create policy "blocks: read"            on blocks for select using (true);
create policy "blocks: staff write"     on blocks for all using (is_staff_of(club_id)) with check (is_staff_of(club_id) and created_by = auth.uid());

-- credits: own ledger read-only; writes only via functions or admin
create policy "credit_tx: read own"     on credit_transactions for select using (profile_id = auth.uid() or is_admin());
create policy "credit_tx: admin write"  on credit_transactions for insert with check (is_admin());

-- match board
create policy "matches: read"           on matches for select using (true);
create policy "matches: organizer"      on matches for all using (organizer_id = auth.uid() or is_admin()) with check (organizer_id = auth.uid() or is_admin());
create policy "match_players: read"     on match_players for select using (true);
create policy "match_players: join"     on match_players for insert with check (profile_id = auth.uid());
create policy "match_players: leave"    on match_players for delete using (profile_id = auth.uid() or is_admin());

-- Column exposure: the grid needs start/end/court/status of all bookings, but not
-- other players' names or phones. This view runs with the owner's rights (so it
-- sees all rows) and exposes only the occupancy columns. Intentional.
create view occupancy with (security_invoker = false) as
  select id, club_id, court_id, coach_id, start_at, end_at, status,
         (player_id = auth.uid()) as mine
  from bookings where status = 'confirmed'
  union all
  select id, club_id, court_id, null, start_at, end_at, 'confirmed'::booking_status, false
  from blocks;

grant select on occupancy to authenticated, anon;
