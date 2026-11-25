-- Pilot configuration check (master checklist PR-1, payment-free pilot approved 25 Nov). READ-ONLY: selects only.
-- The pilot rule: every club players can book (published, not a demo club) takes payment at its desk, and nothing
-- is being paid online through CourtBook.
--
-- One row per finding: slug | published | payment_mode | level | issue, then a final RESULT row.
--   level "block": the pilot must not start (or continue) while this holds;
--   level "warn":  allowed, but worth a look before inviting players.
-- Findings:
--   not_at_desk            (block) a bookable club is in 'simulated' or 'fee_online' mode: players would be sent to
--                          an online payment;
--   open_online_payment    (block) an online payment at a non-demo club is still pending (someone may pay);
--   online_payment_recent  (warn)  an online payment at a non-demo club in the last 30 days, in any status;
--   fee_set_at_desk        (warn)  a bookable at-desk club has a non-zero CourtBook fee. Nothing is charged at the
--                          desk, but switching its mode would start charging that fee;
--   no_bookable_club       (warn)  no club is published yet.
-- Needs clubs.is_demo (0063) and payment_mode (0051): live and staging both have them.
with bookable as (
  select c.id, c.slug, c.active, c.payment_mode, c.service_fee_usd
  from clubs c
  where c.active and not c.is_demo
),
findings as (
  select b.slug, b.active, b.payment_mode, 'block' as level, 'not_at_desk' as issue
  from bookable b where b.payment_mode <> 'at_desk'
  union all
  select c.slug, c.active, c.payment_mode, 'block', 'open_online_payment'
  from clubs c where not c.is_demo and exists (select 1 from payments p where p.club_id = c.id and p.status = 'pending')
  union all
  select c.slug, c.active, c.payment_mode, 'warn', 'online_payment_recent'
  from clubs c where not c.is_demo
    and exists (select 1 from payments p where p.club_id = c.id and p.created_at > now() - interval '30 days')
  union all
  select b.slug, b.active, b.payment_mode, 'warn', 'fee_set_at_desk'
  from bookable b where b.payment_mode = 'at_desk' and b.service_fee_usd > 0
  union all
  select null, null, null, 'warn', 'no_bookable_club'
  where not exists (select 1 from bookable)
)
select slug, published, payment_mode, level, issue from (
  select slug, active as published, payment_mode, level, issue, 0 as k from findings
  union all
  select 'RESULT', null, null,
         case when exists (select 1 from findings where level = 'block') then 'block' else 'ok' end,
         format('%s block, %s warn, %s bookable clubs',
                (select count(*) from findings where level = 'block'),
                (select count(*) from findings where level = 'warn'),
                (select count(*) from bookable)),
         1
) r
order by k, level, slug;
