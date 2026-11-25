-- Rollback of 0096: back to numeric(6,2) without the whole-cent check. Safe at any time: every value the 0096 check
-- allows (whole cents, below 10000) fits numeric(6,2) exactly, so nothing is rounded on the way back.
alter table clubs drop constraint if exists clubs_service_fee_whole_cents;
alter table clubs alter column service_fee_usd type numeric(6,2);
