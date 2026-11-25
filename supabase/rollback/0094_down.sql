-- Rollback of 0094 (M12.2 payment reconciliation): back to exactly the 0093 schema. STAGING ONLY, and only while
-- reconciliation has recorded nothing: it refuses (and changes nothing) if a starting point (watermark) has been set or
-- any reconciliation issue exists — those are financial evidence and are never dropped by a rollback.
-- 0094 replaced no function, so nothing is restored; its own tables and functions are removed.
-- Run as ONE transaction (psql -1). Verified locally: 0001–0093 → 0094 → this script gives a schema fingerprint
-- identical to 0001–0093 (supabase/tests/payments/rollback_0094.sh).
do $$
begin
  if exists (select 1 from payment_reconciliation) then raise exception 'rollback refused: a reconciliation starting point is set'; end if;
  if exists (select 1 from payment_reconciliation_issues) then raise exception 'rollback refused: reconciliation issues exist'; end if;
end $$;

drop function if exists initialise_reconciliation_watermark(text, timestamptz);
drop function if exists advance_reconciliation_watermark(text, timestamptz);
drop function if exists rewind_reconciliation_watermark(text, timestamptz);
drop function if exists record_reconciliation_issue(text, text, text, numeric, text, text);
drop function if exists resolve_reconciliation_issue(uuid, text);
drop function if exists payment_reconciliation_health(text, interval);
drop table if exists payment_reconciliation_issues;
drop table if exists payment_reconciliation;
