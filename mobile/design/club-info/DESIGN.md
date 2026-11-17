---
name: Court Lines
colors:
  surface: '#fdf9f1'
  surface-dim: '#dddad2'
  surface-bright: '#fdf9f1'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f7f3eb'
  surface-container: '#f1ede5'
  surface-container-high: '#ece8e0'
  surface-container-highest: '#e6e2da'
  on-surface: '#1c1c17'
  on-surface-variant: '#3f4941'
  inverse-surface: '#31302b'
  inverse-on-surface: '#f4f0e8'
  outline: '#6f7a70'
  outline-variant: '#becabe'
  surface-tint: '#006d3d'
  primary: '#005f35'
  on-primary: '#ffffff'
  primary-container: '#0f7a47'
  on-primary-container: '#a6ffc3'
  inverse-primary: '#7cda9d'
  secondary: '#436653'
  on-secondary: '#ffffff'
  secondary-container: '#c5ecd4'
  on-secondary-container: '#496c59'
  tertiary: '#a80022'
  on-tertiary: '#ffffff'
  tertiary-container: '#d11a33'
  on-tertiary-container: '#ffe7e5'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#98f7b7'
  primary-fixed-dim: '#7cda9d'
  on-primary-fixed: '#00210f'
  on-primary-fixed-variant: '#00522d'
  secondary-fixed: '#c5ecd4'
  secondary-fixed-dim: '#a9cfb9'
  on-secondary-fixed: '#002113'
  on-secondary-fixed-variant: '#2b4e3c'
  tertiary-fixed: '#ffdad8'
  tertiary-fixed-dim: '#ffb3b1'
  on-tertiary-fixed: '#410007'
  on-tertiary-fixed-variant: '#92001c'
  background: '#fdf9f1'
  on-background: '#1c1c17'
  surface-variant: '#e6e2da'
  cedar-deep: '#0A5C36'
  cedar-soft: '#DCEFE3'
  line: '#E2DCCF'
  ink: '#0F1512'
  muted: '#4A5450'
  red-on-dark: '#F2A0AC'
  danger: '#B42318'
  warn-soft: '#FCEFD2'
  warn-ink: '#7A4E00'
  booked: '#6B6455'
typography:
  headline-display:
    fontFamily: Archivo Narrow
    fontSize: 44px
    fontWeight: '700'
    lineHeight: 48px
  headline-lg:
    fontFamily: Archivo Narrow
    fontSize: 30px
    fontWeight: '800'
    lineHeight: 34px
  headline-md:
    fontFamily: Archivo Narrow
    fontSize: 20px
    fontWeight: '700'
    lineHeight: 26px
  headline-sm:
    fontFamily: Archivo Narrow
    fontSize: 18px
    fontWeight: '700'
    lineHeight: 24px
  scoreboard-lg:
    fontFamily: Archivo Narrow
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 40px
  scoreboard-md:
    fontFamily: Archivo Narrow
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 28px
  scoreboard-sm:
    fontFamily: Archivo Narrow
    fontSize: 20px
    fontWeight: '700'
    lineHeight: 24px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 22px
  body-md:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 20px
  body-semibold:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 22px
  label-md:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '600'
    lineHeight: 20px
  caption:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 17px
  tab-label:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
  eyebrow:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '700'
    lineHeight: 18px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  margin: 1.25rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.25rem
---

# CourtBook — Court Lines design system

The source of truth for how CourtBook looks. Written for people and for design tools (for example, Google Stitch accepts a DESIGN.md). The code's single token file is `lib/theme.ts`; if this file and the code disagree, the code wins and this file is corrected.

## Identity

- **Court Lines.** Surfaces echo a court seen from above: night-green panels, thin white court markings, and numbers set like a scoreboard. Lebanese, sporty and calm, never loud.
- **Lebanese colours, used with restraint.** Cedar green carries every action. Red is a brand accent only. White and limestone give the space.
- **The ticket.** A booking is shown as a ticket: red top edge, night-green band with the date and the time in scoreboard numbers, red perforation, details on white.
- **The cedar mark.** A green cedar on a white tile edged red top and bottom — a nod to the flag, not a copy of it.

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
- Red never means "error", "cancelled" or "booked". Those have their own treatments, so red can never be read as something going wrong.
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
