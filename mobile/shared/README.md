# Shared with the web app — copies, checked

These files are byte-for-byte copies of the web app's `src/lib` files of the same name. The app
imports them as `@shared/*`.

They are copies, not imports from `../src/lib`, because the app must build from `mobile/` alone:
an EAS build whose project root is `mobile/` (for example a Git repository created inside `mobile/`)
uploads nothing outside it, and Metro then fails before bundling anything (the 2026-11-14 build
failure: "Cannot read properties of undefined (reading 'transformFile')").

Never edit them here. Change `src/lib/<file>` and copy it over; `npm run check:shared` (run by the
Mobile checks workflow) fails whenever a copy differs from its source.
