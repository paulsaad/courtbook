# CourtBook — Court Lines design system

The source of truth for how CourtBook looks. Written for people and for design tools (for example,
Google Stitch accepts a DESIGN.md). The code's single token file is `lib/theme.ts`; if this file and
the code disagree, the code wins and this file is corrected.

## Identity

- **Court Lines.** Surfaces echo a court seen from above: night-green panels, thin white court
  markings, and numbers set like a scoreboard. Lebanese, sporty and calm, never loud.
- **Lebanese colours, used with restraint.** Cedar green carries every action. Red is a brand accent
  only. White and limestone give the space.
- **The ticket.** A booking is shown as a ticket: red top edge, night-green band with the date and
  the time in scoreboard numbers, red perforation, details on white.
- **The cedar mark.** A green cedar on a white tile edged red top and bottom — a nod to the flag,
  not a copy of it.

## Colour

| Token | Hex | Use |
| --- | --- | --- |
| night | #062B1C | hero surfaces, tickets, the "Book a court" card |
| cedar | #0F7A47 | primary buttons, free times, selected time, success |
| cedarDeep | #0A5C36 | green text on light surfaces, links |
| cedarSoft | #DCEFE3 | soft green fills (facility chips, success cards) |
| ground | #F3EFE7 | page background (limestone) |
| card | #FFFFFF | cards |
| line | #E2DCCF | hairlines, borders |
| ink | #0F1512 | main text |
| muted | #4A5450 | secondary text (6.9:1 on ground) |
| red | #C8102E | **brand accent only**: wordmark "Book", sport marks, selected sport, ticket edge and perforation, open player spots, badges. Text only at 14 pt bold or larger |
| redOnDark | #F2A0AC | red for text on night surfaces |
| danger | #B42318 | errors, always with words |
| warnSoft / warnInk | #FCEFD2 / #7A4E00 | limited availability, pending and unconfirmed states, the demo label |
| booked | #6B6455 | unavailable times (striped, struck through) |

**Rules**
- Red never means "error", "cancelled" or "booked". Those have their own treatments, so red can
  never be read as something going wrong.
- Every action is green. One primary action per screen area.
- Text contrast is at least WCAG AA (4.5:1 for body text) on its background.

## Type

| Role | Font | Size / line |
| --- | --- | --- |
| Title | Archivo ExtraBold | 30 / 34 |
| Heading | Archivo Bold | 20 / 26 |
| Body | Inter Regular | 16 / 22 |
| Strong, label | Inter SemiBold | 16 / 22, 15 / 20 |
| Secondary | Inter Regular | 15 / 20 |
| Caption | Inter Regular | 13 / 17 — the smallest size, except tab labels (12) |
| Eyebrow | Inter Bold, uppercase, tracking 0.8 | 14 / 18 |
| Scoreboard (times, prices, counts) | Archivo Narrow Bold | 20–60 |

- Text follows the phone's text size up to 1.6×. Beyond that, layouts wrap rather than clip.
- Times and prices are always in scoreboard numbers.

## Shape and space

- Spacing scale: 4, 8, 12, 16, 20, 24, 32. Screen side margin: 20 (16 on cards inside lists).
- Corner radii: 10, 14, 18, 22, pill. Cards use 18, tickets 22, buttons 16.
- Touch targets: at least 48 × 48.
- Hairline borders (1 pt, `line`) rather than shadows.

## Components

- **Buttons:** primary (cedar, white bold text), secondary (white with border), dark (on night).
  48 tall at least; busy state shows a spinner and ignores taps.
- **Chips:** pills. A selected filter is ink-filled. A selected *sport* is outlined in red with a
  bold label, so it never looks like a selected time.
- **Time tiles:** three per row. Free tiles are white with a green border, green price line and
  scoreboard time. "1 court free" uses warnSoft. Not free is striped and struck through. Selected
  is solid cedar with a check.
- **Segmented control:** limestone track, white selected segment (Book | Info, Courts | Games).
- **Booking panel:** sits *below* the time list, never over it. Shows court chips, date and time,
  the total in scoreboard numbers, payment wording, and Reserve.
- **Banners:** warnSoft card for an unconfirmed booking (with Check now); cedarSoft for "went
  through"; white for "not made".
- **Sport marks:** each sport drawn as its own court plan in thin red lines.
- **Court markings:** decorative, low-opacity white lines on night surfaces. They take their own
  space and never sit under text.

## Navigation

Tabs **Home · Courts · Bookings · Profile**. The active tab shows a bold label, a heavier green icon
and a short red line above it. Club page: **Book | Info**.

## Voice

Plain, short, specific. Say what happened and what to do next. Never blame the player. Prices in
USD ("$30"). Dates like "Sun 15 Nov", times in 24 h ("18:30").

## Things a redesign must keep

The palette and the red-is-accent rule, scoreboard numbers, the ticket, the cedar mark, the Court
Lines decoration, three time tiles per row, the panel below the list, the four tabs, the
accessibility floor (contrast, 48-point targets, text up to 1.6×, every control labelled).
