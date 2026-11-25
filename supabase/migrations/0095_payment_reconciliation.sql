-- 0095 — M12.2: nothing in payment reconciliation may disappear silently (review of PR #36). NOT APPLIED ANYWHERE.
--
-- 1. A watermark per provider: how far the provider's own charge list has been reconciled completely. Each run reads
--    from the watermark (minus an overlap) instead of a fixed look-back, and moves it forward only when its whole
--    window was processed. A runner that was down for days catches up window by window (backfill); a window that
--    failed is read again. rewind_reconciliation_watermark moves it back by hand for recovery.
--    There is NO default starting point (review of PR #36): until a person sets one with
--    initialise_reconciliation_watermark, the runner reads no charge list and reports that it is not initialised. The
--    starting point must be verified against the provider account: at or before the first real charge, and inside the
--    provider's transaction-history retention.
-- 2. Reconciliation issues: provider evidence that contradicts what is recorded is kept until a person resolves it,
--    so it is alerted on every run, not once.
-- 3. One health reading for the runner: unresolved attempts of another provider than the runner's (misconfiguration),
--    unresolved attempts past the overdue age, open issues, the watermark.
-- Server only, except resolving an issue (admins). Nothing here changes a booking or a payment.

create table if not exists payment_reconciliation (
  provider         text primary key check (provider in ('simulated', 'whish', 'areeba')),
  reconciled_until timestamptz not null,
  updated_at       timestamptz not null default now()
);

create table if not exists payment_reconciliation_issues (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null check (provider in ('simulated', 'whish', 'areeba')),
  provider_ref text not null,
  external_ref text,
  amount       numeric(8,2),
  currency     text,
  code         text not null check (code in ('charge_evidence_conflict', 'attempt_evidence_conflict', 'duplicate_provider_ref')),
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  seen         int not null default 1,
  resolved_at  timestamptz,
  resolved_by  uuid references profiles(id) on delete set null,
  resolution   text,
  reopened     int not null default 0,     -- times new evidence reopened it after a resolution
  last_resolution text,                     -- the resolution that new evidence overturned (kept for the record)
  unique (provider, provider_ref, code),
  check ((resolved_at is null) = (resolution is null))
);

alter table payment_reconciliation enable row level security;
alter table payment_reconciliation_issues enable row level security;
revoke all on payment_reconciliation, payment_reconciliation_issues from public, anon, authenticated;
grant select on payment_reconciliation_issues to authenticated;
grant all on payment_reconciliation, payment_reconciliation_issues to service_role;
drop policy if exists "reconciliation issues: admin" on payment_reconciliation_issues;
create policy "reconciliation issues: admin" on payment_reconciliation_issues for select to authenticated using (is_admin());

-- the explicit, verified starting point, set once by hand (service key) before real payments are reconciled
create or replace function initialise_reconciliation_watermark(p_provider text, p_from timestamptz) returns timestamptz
language plpgsql security definer set search_path = public as $$
begin
  if p_from is null or p_from > now() then raise exception 'bad_watermark'; end if;
  if exists (select 1 from payment_reconciliation where provider = p_provider) then raise exception 'already_initialised'; end if;
  insert into payment_reconciliation (provider, reconciled_until) values (p_provider, p_from);
  return p_from;
end $$;

-- the watermark moves forward only, never into the future, and only once initialised
create or replace function advance_reconciliation_watermark(p_provider text, p_until timestamptz) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v timestamptz;
begin
  if p_until is null or p_until > now() + interval '5 minutes' then raise exception 'bad_watermark'; end if;
  update payment_reconciliation set reconciled_until = greatest(reconciled_until, p_until), updated_at = now()
  where provider = p_provider returning reconciled_until into v;
  if v is null then raise exception 'not_initialised'; end if;
  return v;
end $$;

-- recovery by hand (service key): read the provider's list again from p_to; moves back only
create or replace function rewind_reconciliation_watermark(p_provider text, p_to timestamptz) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v timestamptz;
begin
  if p_to is null then raise exception 'bad_watermark'; end if;
  update payment_reconciliation set reconciled_until = least(reconciled_until, p_to), updated_at = now()
  where provider = p_provider returning reconciled_until into v;
  if v is null then raise exception 'not_initialised'; end if;
  return v;
end $$;

-- Contradictory evidence, kept until resolved. Returns 'open' (needs a person) or 'resolved'.
-- Seen again with the SAME evidence (amount, currency, external reference) as an issue a person already resolved: it
-- stays resolved and is only counted. Seen with DIFFERENT evidence for the same provider transaction: that is new
-- contradictory evidence the resolution did not cover — the issue is reopened with the new evidence (review of PR #36).
drop function if exists record_reconciliation_issue(text, text, text, numeric, text, text);
create or replace function record_reconciliation_issue(p_provider text, p_provider_ref text, p_external_ref text,
                                                       p_amount numeric, p_currency text, p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare v_resolved timestamptz;
begin
  insert into payment_reconciliation_issues (provider, provider_ref, external_ref, amount, currency, code)
  values (p_provider, btrim(p_provider_ref), left(p_external_ref, 120), p_amount, upper(btrim(p_currency)), p_code)
  on conflict (provider, provider_ref, code) do update set
    last_seen = now(),
    seen = payment_reconciliation_issues.seen + 1,
    amount = excluded.amount, currency = excluded.currency, external_ref = excluded.external_ref,
    reopened = payment_reconciliation_issues.reopened
      + case when payment_reconciliation_issues.resolved_at is not null and not (
               payment_reconciliation_issues.amount is not distinct from excluded.amount
           and payment_reconciliation_issues.currency is not distinct from excluded.currency
           and payment_reconciliation_issues.external_ref is not distinct from excluded.external_ref) then 1 else 0 end,
    last_resolution = case when payment_reconciliation_issues.resolved_at is not null and not (
               payment_reconciliation_issues.amount is not distinct from excluded.amount
           and payment_reconciliation_issues.currency is not distinct from excluded.currency
           and payment_reconciliation_issues.external_ref is not distinct from excluded.external_ref)
      then payment_reconciliation_issues.resolution else payment_reconciliation_issues.last_resolution end,
    resolved_by = case when payment_reconciliation_issues.amount is not distinct from excluded.amount
           and payment_reconciliation_issues.currency is not distinct from excluded.currency
           and payment_reconciliation_issues.external_ref is not distinct from excluded.external_ref
      then payment_reconciliation_issues.resolved_by end,
    resolution = case when payment_reconciliation_issues.amount is not distinct from excluded.amount
           and payment_reconciliation_issues.currency is not distinct from excluded.currency
           and payment_reconciliation_issues.external_ref is not distinct from excluded.external_ref
      then payment_reconciliation_issues.resolution end,
    resolved_at = case when payment_reconciliation_issues.amount is not distinct from excluded.amount
           and payment_reconciliation_issues.currency is not distinct from excluded.currency
           and payment_reconciliation_issues.external_ref is not distinct from excluded.external_ref
      then payment_reconciliation_issues.resolved_at end
  returning resolved_at into v_resolved;
  return case when v_resolved is null then 'open' else 'resolved' end;
end $$;

create or replace function resolve_reconciliation_issue(p_issue uuid, p_resolution text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_resolution is null or btrim(p_resolution) = '' then raise exception 'resolution_required'; end if;
  update payment_reconciliation_issues set resolved_at = now(), resolved_by = auth.uid(), resolution = left(btrim(p_resolution), 500)
  where id = p_issue and resolved_at is null;
  if not found then
    if exists (select 1 from payment_reconciliation_issues where id = p_issue) then return 'already_resolved'; end if;
    raise exception 'not_found';
  end if;
  return 'resolved';
end $$;

create or replace function payment_reconciliation_health(p_provider text, p_overdue interval)
returns table (other_provider_attempts int, overdue_attempts int, oldest_unresolved timestamptz, open_issues int, reconciled_until timestamptz)
language sql stable security definer set search_path = public as $$
  select
    -- attempts this runner cannot ask about: unresolved ones of another provider, or any made recently by one (a
    -- runner configured for the wrong provider would otherwise skip them and report success)
    (select count(*) from payment_attempts
      where provider <> p_provider and (status in ('starting', 'open') or created_at > now() - p_overdue))::int,
    (select count(*) from payment_attempts where status in ('starting', 'open') and created_at < now() - p_overdue)::int,
    (select min(created_at) from payment_attempts where status in ('starting', 'open')),
    (select count(*) from payment_reconciliation_issues where resolved_at is null)::int,
    (select r.reconciled_until from payment_reconciliation r where r.provider = p_provider);
$$;

revoke all on function initialise_reconciliation_watermark(text, timestamptz) from public, anon, authenticated;
revoke all on function advance_reconciliation_watermark(text, timestamptz) from public, anon, authenticated;
revoke all on function rewind_reconciliation_watermark(text, timestamptz) from public, anon, authenticated;
revoke all on function record_reconciliation_issue(text, text, text, numeric, text, text) from public, anon, authenticated;
revoke all on function payment_reconciliation_health(text, interval) from public, anon, authenticated;
grant execute on function initialise_reconciliation_watermark(text, timestamptz), advance_reconciliation_watermark(text, timestamptz), rewind_reconciliation_watermark(text, timestamptz),
  record_reconciliation_issue(text, text, text, numeric, text, text), payment_reconciliation_health(text, interval) to service_role;
revoke all on function resolve_reconciliation_issue(uuid, text) from public, anon;
grant execute on function resolve_reconciliation_issue(uuid, text) to authenticated;
