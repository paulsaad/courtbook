# Phase I-2a — reception calendar on desktop (built 21 Nov 2026, for review; not merged)

Branch `phase-i-2a` `73ab673`; staging preview via `m3-dev` (same commit):
https://courtbook-git-m3-dev-paul-bc50.vercel.app → Profile → Staff calendar.

## What changed (`src/app/staff/[slug]/DayCalendar.tsx`)

Desktop (≥ 1024 px)
- **Panel beside the calendar, not blocking it** (non-modal dialog, title, ×). Nothing open: the Now
  summary for today (free courts, on court now, next three hours); another day: a short hint.
- **Calendar column scrolls on its own**: court names stay at the top and times at the left; columns at
  least 9 rem, sideways scrolling only when the courts do not fit.
- **Readability**: booking names 15 px, booking text 14 px, times 13 px, court names 15 px; each booking
  shows time · app / desk / being paid, and the phone number; the open booking is outlined.
- Date field to jump to a day; "Updated hh:mm".

All widths
- Automatic refresh every 60 s while the page is visible, and on returning to it.
- Enter in a text field never saves a booking or closes courts; only the button does.
- Keyboard ← / → (day, or week in Week view) and T (today).

Phones keep the modal bottom sheet; tapping outside closes it as before.

## Safety requirements → how they are met

| Requirement | Implementation | Test |
| --- | --- | --- |
| Refresh never closes the panel, overwrites typed details or changes the date | refresh only re-reads rows; panel state, form state and URL untouched | "automatic refresh keeps the open panel and its typed details…" |
| No stale answer replaces newer data | day reads numbered (only the newest may change state); week reads cancelled on re-run | existing "ignores a day response that arrives after a newer one", "never shows the previous court's week…" |
| Refresh failure: say it may be outdated, keep the add fail-safe | failure sets the existing "Couldn't load the latest bookings… adding is off" banner; free slots disabled until a read succeeds | same test (slot disabled after a failed refresh) |
| Calendar usable while the panel is open | non-modal panel; slots and bookings stay clickable | "non-modal panel … calendar stays usable" |
| Switching slots never silently discards typed details | switching slot, × / Esc, changing day (keys, date field, any link) ask "Discard the booking details you have typed?" | three tests; removing the question fails them |
| Conflict keeps details, clear error, no automatic retry | the save runs once; on error the panel stays with the details and a red message (role="alert") | "a conflict keeps the typed details…" (one `staff_book` call) |
| Shortcuts never interfere with typing, customer search or the date field; Enter never books | shortcuts ignored in inputs, the panel, length choices, with modifiers, while saving; Enter in a field is cancelled | keyboard tests; Enter test (removing the guard fails it) |
| Booking rules, permissions, payments, phone booking actions unchanged | no change to `staff_book`, `move_booking`, `cancel_booking`, `mark_no_show`, blocks or `close_club`; same reads | layout-only guard (only approved navigation lines allow-listed) |

## Checks

Website typecheck; 182/182 tests (20 calendar tests, 8 new); layout-only guard; layout check run
44924715826 (public pages identical at 390 px).

## Not in I-2a

"Find a free court" helper (deferred), I-2b keyboard-first add (recent customers by keyboard), I-2c
Week/List readability and the owner's phone summary.

## Review corrections (21 Nov 2026, `f7ea2c3`)

- **Typed details survive crossing 1024 px:** the bottom sheet and the side panel are now one container,
  restyled at the breakpoint instead of replaced, so the add form is never rebuilt by a resize. Test:
  resizing phone → desktop → phone and back keeps name and phone (fails when the form is rebuilt).
- **Arrow shortcuts only when no control has focus:** ← / → / T act only when focus is on the page
  itself; a focused slot, link, field, length choice or the panel keeps its own keys. Test added.
- Checks: 185/185 tests; layout-only guard; layout run 44925538087 (phone width identical).
