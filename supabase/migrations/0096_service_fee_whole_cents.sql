-- 0096: the CourtBook service fee is refused, not rounded, unless it is a whole number of cents (review 25 Nov:
-- enforce it in the database before real payments, not only in the admin form).
--
-- Why a type change: clubs.service_fee_usd was numeric(6,2). Postgres rounds a value to the column's scale while
-- building the row, before any check constraint or trigger sees it, so 0.255 was silently stored as 0.26 by any
-- writer (the admin form already refuses it; a direct API write by an admin did not). As plain numeric the value
-- reaches the check exactly as written, and the check refuses anything with fractions of a cent.
--
-- The range is unchanged: numeric(6,2) allowed up to 9999.99; the existing check keeps >= 0.
-- Binary-compatible change (typmod relaxed): no table rewrite; no view depends on the column (checked on the
-- release tree). Every existing value already has at most 2 decimals, so validation cannot fail on old rows.
-- Functions that read the fee are unchanged (they declare numeric). Bookings and payments keep numeric(6,2)/(8,2):
-- their fee is copied from this column, which can now only hold whole cents, so nothing is rounded there either.

alter table clubs alter column service_fee_usd type numeric;

alter table clubs drop constraint if exists clubs_service_fee_whole_cents;
alter table clubs add constraint clubs_service_fee_whole_cents
  check (service_fee_usd = round(service_fee_usd, 2) and service_fee_usd < 10000);
