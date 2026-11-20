# Open question — second staging account with Paul's personal email (`966f79cf`)

Recorded 20 Nov 2026. **Leave the account untouched until this is investigated.**

- Staging has three accounts: `02111629` (Paul, personal email, code sign-in, the only admin since run
  44769046561), `6138b979` (Paul Tester, `paul.tester@courtbook.test`) and `966f79cf`.
- Paul checked Authentication → Users in the staging project: `966f79cf` also shows his personal email.
  It has never signed in and has the `player` role only. It was used as a helper account in the
  temporary test games of 20 Nov (a join request, removed with those games).
- Supabase normally allows one account per email, so two rows with the same visible address suggest a
  difference not obvious in the list (letter case, a `+` alias, a dot in a Gmail address, or an account
  created through the admin API). Nothing depends on it.
- To decide later, with Paul: find how and when it was created (auth logs / `created_at`, identities),
  whether anything references it, then keep, rename or delete it — deletion only with Paul's approval.
