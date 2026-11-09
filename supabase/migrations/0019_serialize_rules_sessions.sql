-- Phase 3 review round 2.
-- #2 price-rule overlap check serialized per club (club row lock inside the trigger).
-- #1 payment session creation: atomic claim so only one request calls the gateway.

create or replace function price_rules_no_overlap() returns trigger
language plpgsql as $$
begin
  perform 1 from clubs where id = new.club_id for update;   -- serialize rule changes per club
  if exists (
    select 1 from price_rules r
    where r.club_id = new.club_id
      and r.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000')
      and r.court_id is not distinct from new.court_id
      and (r.weekday_mask & new.weekday_mask) <> 0
      and r.start_time < new.end_time and new.start_time < r.end_time
  ) then
    raise exception 'price_rule_overlap';
  end if;
  return new;
end $$;

-- Claim the right to create the gateway session. Returns true for exactly one caller while
-- no session exists; others get false and should wait for session_url. Service role only.
create or replace function claim_payment_session(p_payment uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update payments set session_ref = 'claim:' || p_payment::text
  where id = p_payment and status = 'pending' and session_ref is null;
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke execute on function claim_payment_session(uuid) from public, anon, authenticated;
grant execute on function claim_payment_session(uuid) to service_role;

-- Release a claim when the gateway call failed, so the player can retry.
create or replace function release_payment_session_claim(p_payment uuid) returns void
language sql security definer set search_path = public as $$
  update payments set session_ref = null where id = p_payment and session_ref = 'claim:' || p_payment::text and session_url is null;
$$;
revoke execute on function release_payment_session_claim(uuid) from public, anon, authenticated;
grant execute on function release_payment_session_claim(uuid) to service_role;
