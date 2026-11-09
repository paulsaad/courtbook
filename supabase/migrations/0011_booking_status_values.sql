-- Phase 2 (payments model). New booking states. Postgres cannot use a new enum value in the
-- same transaction that adds it, so this file is applied on its own before 0012.
alter type booking_status add value if not exists 'pending';   -- slot held while the player pays
alter type booking_status add value if not exists 'expired';   -- hold ran out before payment
