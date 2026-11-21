# Phase I-1 — desktop shell (built 21 Nov 2026, for review; not merged)

Branch `phase-i-1`; staging preview via `m3-dev` (same commit):
https://courtbook-git-m3-dev-paul-bc50.vercel.app

## What changed (layout only)

| Width | Navigation | Pages |
| --- | --- | --- |
| phone < 768 px | bottom tab bar, unchanged | unchanged (`max-w-md`) |
| tablet 768–1023 px | bottom tab bar, unchanged | 672 px column (`md:max-w-2xl`) |
| desktop ≥ 1024 px | top bar (player) or club/admin bar (staff, admin); no bottom bar | reading pages 720 px, browse pages 768 px (grids come in I-3) |

- **Player top bar:** CourtBook · Home · Courts · Find a game · Bookings · Profile · bell with unread
  count; signed out: Home · Courts · Find a game · Sign in. Hidden on sign-in and payment pages
  (focused flows); shown on the coach page. Skip-to-content link; current page marked for screen readers.
- **Staff bar:** club name · Calendar · Payments · Settings · My bookings · Profile.
- **Admin bar:** Admin · Clubs · Payments · Reports · Staff calendar · My bookings · Profile.
- **Sheets:** level, area picker and Courts booking → centred dialog; staff calendar booking → right side
  panel; club-page booking card → floating panel beside the grid (not modal). Esc closes (not while
  saving); on desktop, modal ones keep keyboard focus inside and return it on close.
- Staff calendar width, grids and two-column pages are later stages (I-2 to I-5).

## Reachability by role (desktop)

Every one of the 27 pages is linked from somewhere reachable: player pages from the top bar and their
existing links; staff calendar / payments / settings from Profile → Staff calendar and the staff bar;
admin pages from Profile → Admin and the admin bar; coach page from Profile; staff and admin bars lead
back to the player side (CourtBook, My bookings, Profile).

## Checks

- Website typecheck; 167/167 tests (20 new: navigation by page and sign-in state, staff/admin bars,
  Esc and focus, every phone container also has tablet and desktop widths).
- `scripts/check-layout-only.sh`: no file under `supabase/`, `src/lib/`, `src/app/api/`,
  `src/app/auth/`; no line reaching Supabase or the server added or removed. Shown to catch a planted
  query line.
- Workflow "Website layout check (Phase I)" (run 44919491304): builds main and this branch against
  **staging**, public pages at 390 px **pixel-identical** (Home changes between loads by itself, also on
  main), screenshots at 768 / 1280 / 1440 px kept 14 days as an artifact.

## Pre-existing fault found (not Phase I)

`/club/[slug]/info` fails on the server in a production build ("FACILITIES.map is not a function"):
the page imports the facilities list from a browser-only component file (`ClubVenue.tsx`, "use client")
since Phase 11b (13 Nov). Same error on main and on this branch. Proposed separate fix: move the list to
a plain module imported by both. Needs its own approval (not layout).

## Review corrections (21 Nov 2026)

| Point | Done |
| --- | --- |
| 1. Admin open-reports count | Admin bar shows "Reports (N open)" via the same `admin_reports` read the admin home makes; no count if unknown or zero. The one read is allow-listed in the layout-only guard with its reason (`scripts/layout-only-allow.txt`). |
| 2. No dismissal while saving | Backdrop, Close and Cancel do nothing while saving: level sheet, Courts booking sheet, club booking card (the staff calendar backdrop was already guarded); Esc as before. Applies at every width (also a phone safety fix). |
| 3. Dialog semantics and focus | `role="dialog"`, `aria-modal` and a label on every sheet. Modal sheets at every width: focus moves in, Tab/Shift+Tab wrap, focus landing behind the panel is brought back, focus returns on close. Club booking card: non-modal (`aria-modal="false"`), Esc only. Checked in the browser on the staging preview (area picker at 1280 px: focus inside after 25 Tabs; Esc closes and returns focus). |
| 4. Calendar header | Staff calendar sticky header at `lg:top-16`, directly under the 64 px desktop bar. |
| 5. Club Info page | Separate commit `10484bc`: `FACILITIES` moved unchanged to `src/components/facilities.ts`. New test: no server file imports a plain value from a "use client" file (fails on the old code). Layout check: the page errors on main and renders on this branch; staging preview renders it. |

Checks: website typecheck; 172/172 tests; layout-only guard; layout check run 44920621655 (phone width
identical; Info page fixed; no server errors in the new build).
