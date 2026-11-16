# CourtBook Club Info — Design Token & UI Handoff Specification

**System:** Court Lines  
**Screen:** Club Info (`CourtBook — Club Info (Definitive Master)`)  
**Target Form Factor:** Native Mobile (390 pt reference width, scalable 320–430 pt+)  
**Purpose:** Canonical platform-independent specification for engineering implementation in React Native / Expo.

---

## 1. Color Palette Tokens

Every color token is strictly semantic. Colors reflect the Lebanese athletic heritage: deep night green, warm limestone ground, white surfaces, cedar action cues, and a disciplined, non-destructive red accent.

| Token | Hex Value | Intended Usage & Interaction Rules |
| :--- | :--- | :--- |
| `night` | `#062B1C` | Deep forest night green. Hero container fill, ticket headers, night court surfaces. |
| `cedar` | `#0F7A47` | Primary action green. Primary buttons (`See free times`), free court slots, active tab labels & icons, success banners. |
| `cedarDeep` | `#0A5C36` | High-contrast dark cedar green. Interactive text links and deep green labels on light surfaces (WCAG AAA). |
| `cedarSoft` | `#DCEFE3` | Soft cedar tint. Facility chip background fill, verified amenity badges. |
| `ground` | `#F3EFE7` | Warm limestone page canvas background. Low-glare, organic physical substrate. |
| `card` | `#FFFFFF` | Elevated surface containers, segmented control selected thumb, list backgrounds. |
| `line` | `#E2DCCF` | 1 pt subtle structural dividers, court row separators, card borders. |
| `ink` | `#0F1512` | Primary typography, headlines, high-contrast values (14.2:1 contrast against `ground`). |
| `muted` | `#4A5450` | Secondary typography, metadata, unit labels, section subtitles (6.9:1 contrast against `ground`). |
| `red` | `#C8102E` | **Brand Accent Only (Lebanese Identity):** 3.5 pt hero crown border, architectural sport line icons, active tab top bar indicator (18 × 2.5 pt). **Strict rule:** Never used for errors, warnings, cancellations, or booked states. |
| `redOnDark` | `#F2A0AC` | Subtle red text/glyph tint when rendered directly on `night` surfaces. |
| `warnSoft` | `#FCEFD2` | Warning & informational container fill (e.g. *"Demo club — not a real venue"* pill). |
| `warnInk` | `#7A4E00` | Warning typography and pill text. |
| `booked` | `#6B6455` | Struck-through/unavailable slot state (used in slot picker flows). |
| `danger` | `#B42318` | Semantic destructive/error state (always accompanied by descriptive text, never bare red). |

---

## 2. Typography Specification

The typographic hierarchy combines `Archivo` for bold athletic structure, `Archivo Narrow` for tabular scoreboard digits, and `Inter` for functional UI clarity.

| Role | Font Family | Weight | Font Size | Line Height | Tracking / Transform | Usage |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Display Title** | Archivo | ExtraBold (800) | 26 pt | 32 pt | Normal | Hero venue title (`Batroun Padel & Tennis Club`) |
| **Heading** | Archivo | Bold (700) | 20 pt | 26 pt | Normal | Major modal & section titles |
| **Card Heading** | Archivo | Bold (700) | 16 pt | 22 pt | Normal | Court titles (`Padel 1`, `Tennis 1`, `Pitch 1`) |
| **Scoreboard Large** | Archivo Narrow | Bold (700) | 30 pt | 34 pt | -0.5 pt | Hero rate values (`$20`, `$30`), total pricing |
| **Scoreboard Medium** | Archivo Narrow | Bold (700) | 24 pt | 28 pt | -0.3 pt | Stat metrics (`08:00–23:00`, `1–3 h`, `6 h before`) |
| **Scoreboard Small** | Archivo Narrow | Bold (700) | 20 pt | 24 pt | Normal | Slot times, list price counters |
| **Eyebrow / Category** | Inter | Bold (700) | 12 pt | 16 pt | +0.8 pt, UPPERCASE | Section labels (`HOURLY RATES`, `FACILITIES`, `COURTS & SURFACES`) |
| **Body Primary** | Inter | Regular (400) | 16 pt | 22 pt | Normal | Explanatory notes, facility labels, main descriptions |
| **Body SemiBold** | Inter | SemiBold (600) | 15 pt | 20 pt | Normal | Booking rule values, button labels, key status text |
| **Secondary / Sub** | Inter | Regular (400) | 15 pt | 20 pt | Normal | Booking rule labels (`Book ahead`, `Payment`), time intervals |
| **Caption** | Inter | Regular (400) | 13 pt | 17 pt | Normal | Stat subtitles (`Open daily`, `Play window`), rate units (`/ hr`) |
| **Tab Label** | Inter | Medium (500) | 11 pt | 14 pt | Normal | Bottom navigation labels (active state in SemiBold 600) |

---

## 3. Spatial & Geometric Grid

- **Base Unit Spacing Scale:** 4 pt, 8 pt, 12 pt, 16 pt, 20 pt, 24 pt, 32 pt, 40 pt, 48 pt.
- **Screen Margin (Horizontal):** 16 pt.
- **Section Stack Margin (Vertical Gap):** 20 pt.
- **Internal Card Padding:** 16 pt standard; 20 pt for hero unit and primary rules card.
- **Border Radii:**
  - Standard Cards: `16 pt`
  - Hero Container: `20 pt` (with `overflow: hidden`)
  - Buttons (Primary & Secondary): `14 pt`
  - Segmented Control Container: `12 pt` (Thumb: `10 pt`)
  - Chips & Status Pills: `9999 pt` (Full Pill)
  - Bottom Tab Active Indicator: `2 pt`
- **Border Widths:**
  - Hairline: `1 pt` (`line` `#E2DCCF`)
  - Lebanese Red Crown (Hero top edge): `3.5 pt` (`red` `#C8102E`)

---

## 4. Component Design Specifications

### A. Top App Bar & Segmented Control
- **Navigation Bar:** 48 pt height. Back navigation button (`< Courts`) aligned left (16 pt body text in `cedar` `#0F7A47`). Centered title: *“Club Details”* (Inter SemiBold 16 pt, `ink`).
- **Segmented Control:** 44 pt total height. Track background: `ground` (`#F3EFE7`), 12 pt radius, 4 pt internal padding. Segments: *Book* | *Info*. Selected segment thumb: `card` (`#FFFFFF`), 10 pt radius, hairline border, Inter SemiBold 15 pt in `ink`. Unselected text: Inter Regular 15 pt in `muted`.

### B. Hero Banner Container
- **Surface:** Solid `night` (`#062B1C`), 20 pt radius.
- **Top Accent Line:** 3.5 pt solid `red` (`#C8102E`) along the top perimeter.
- **Sport Filter Pills:** Pill shape, dark translucent fill (`rgba(255, 255, 255, 0.12)`), text 12 pt Inter Bold uppercase in white (`PADEL`, `TENNIS`, `FOOTBALL`).
- **Demo Badge:** Warm fill `warnSoft` (`#FCEFD2`), text `warnInk` (`#7A4E00`), Inter Regular 12 pt with info glyph (*“Demo club — not a real venue”*).
- **Venue Title & Location:** Title in Archivo ExtraBold 26 pt white; location row with location pin icon + *“Sou2 · Batroun, Lebanon”* (Inter Regular 14 pt, white at 80% opacity).
- **Hero Action Buttons:**
  - *Primary Button (`See free times`):* Minimum height 48 pt, background `card` (`#FFFFFF`), text `night` (`#062B1C`), calendar icon, Inter Bold 15 pt.
  - *Secondary Button (`Directions`):* Minimum height 48 pt, background `rgba(255, 255, 255, 0.15)`, text `#FFFFFF`, hairline border `rgba(255, 255, 255, 0.25)`, compass icon, Inter SemiBold 15 pt.

### C. Quick Stats Strip
- **Layout:** 3-column card (`card` `#FFFFFF` or elevated `surface-container-low`), 16 pt padding, 16 pt radius.
- **Columns:**
  1. *Hours:* `08:00–23:00` (Archivo Narrow Bold 22 pt) / *Open daily* (Inter Regular 13 pt `muted`).
  2. *Duration:* `1–3 h` (Archivo Narrow Bold 22 pt) / *Play window* (Inter Regular 13 pt `muted`).
  3. *Cancellation:* `6 h before` (Archivo Narrow Bold 22 pt) / *Free cancellation* (Inter Regular 13 pt `muted`).

### D. Hourly Rates Section
- **Microcopy:** Inter Regular 14 pt `muted`: *“Rates depend on selected court and time. Example starting rates (pending venue verification):”*
- **Comparison Cards:** 2-column flex grid (equal 50/50 split, 12 pt gap).
  - *Off-Peak Card:* White card, 16 pt radius, 1 pt hairline border. Label *“Off-peak”* (Inter SemiBold 15 pt), period *“08:00–17:00”* (Inter Regular 13 pt `muted`). Scoreboard rate: `$20` (Archivo Narrow Bold 30 pt `ink`) + `/ hr` (Inter Regular 14 pt `muted`).
  - *Peak Card:* White card, 16 pt radius, 1 pt hairline border. Label *“Peak”* (Inter SemiBold 15 pt), period *“17:00–23:00”* (Inter Regular 13 pt `muted`). Scoreboard rate: `$30` (Archivo Narrow Bold 30 pt `ink`) + `/ hr` (Inter Regular 14 pt `muted`).

### E. Location Card
- **Surface:** White card, 16 pt radius, 1 pt hairline border, 16 pt padding.
- **Content:** Map pin glyph in soft cedar square icon container (36 × 36 pt, 10 pt radius, background `cedarSoft` `#DCEFE3`), venue text: *“Sou2, Batroun”* (Archivo SemiBold 16 pt `ink`).

### F. Facilities Section
- **Available Chips:** Horizontal flex wrap, 8 pt gap. Pill shape (9999 pt radius), padding 8 pt vertical × 14 pt horizontal. Background: `cedarSoft` (`#DCEFE3`), text: `cedarDeep` (`#0A5C36`), Inter SemiBold 14 pt, prefixed by checkmark (`✓`).
  - Items: *Changing rooms*, *Showers*, *Equipment rental*, *Drinking water*.
- **Unavailable Amenities Note:** Subtle container or text block in `surface-container-low` (`#F7F3EB`), 10 pt radius, 10 pt padding. Text: Inter Regular 13 pt `muted`: *“• Not available: Parking, café, floodlights”*.

### G. Courts & Surfaces List
- **Section Header:** Eyebrow `COURTS & SURFACES` (Inter Bold 12 pt uppercase `ink`), right-aligned count *“6 courts”* (Inter Regular 13 pt `muted`).
- **Container:** Single white card enclosing all 6 courts, 16 pt radius, 1 pt hairline outer border.
- **Row Architecture:** Minimum 54 pt height per court row. Separated by 1 pt hairline divider (`line` `#E2DCCF`) running from text margin to right edge.
- **Row Elements:**
  - *Sport Line Icon:* 28 × 28 pt square container with hairline border. Inside: precise architectural court plan (Padel cage, Tennis doubles court, Pitch perimeter) drawn in thin 1.25 pt `red` (`#C8102E`) strokes.
  - *Court Title:* Archivo SemiBold 16 pt `ink` (`Padel 1`, `Tennis 1`, etc.).
  - *Surface Metadata:* Inter Regular 14 pt `muted` (`Artificial grass`, `Hard court`, `clay`, `Football`).

### H. Booking Rules Card
- **Container:** White card, 16 pt radius, 1 pt hairline border, 20 pt internal padding.
- **Rows (Key-Value Pairs):** 12 pt vertical row gap.
  - *Book ahead:* Up to 14 days (Inter SemiBold 15 pt)
  - *Booking length:* 1 h to 3 h, 30-min steps (Inter SemiBold 15 pt)
  - *Free cancellation:* Until 6 h before; no refund after (Inter SemiBold 15 pt)
  - *Booking fee:* None ($0) (Inter SemiBold 15 pt)
  - *Payment:* Pay the court at the club when you arrive. (Inter Bold 15 pt, right-aligned multiline wrap)

### I. Bottom Tab Bar
- **Dimensions:** 64 pt height + native bottom safe area inset.
- **Surface:** White card (`#FFFFFF`), 1 pt top border (`line` `#E2DCCF`).
- **Four Tabs:** *Home*, *Courts*, *Bookings*, *Profile*.
  - *Inactive Tab:* 22 pt outline SVG icon in `muted` (`#4A5450`), label Inter Medium 11 pt in `muted`.
  - *Active Tab (`Courts`):* 22 pt geometric multi-sport court lines icon in `cedar` (`#0F7A47`), label Inter SemiBold 11 pt in `cedar`. At the top edge directly above the tab: 18 pt wide × 2.5 pt high rounded indicator bar in `red` (`#C8102E`).

---

## 5. Responsive Behavior (320 pt to 390 pt+ Viewports)

- **320 pt Phones (e.g. iPhone SE 1st gen / narrow Android):**
  - Horizontal screen padding drops from 16 pt to 12 pt.
  - Hero action buttons (`See free times` and `Directions`) wrap from side-by-side (`flex-row`) to vertically stacked (`flex-col`) with an 8 pt gap, each spanning 100% width.
  - Quick stats strip reflows cleanly: font sizes reduce from 22 pt to 18 pt scoreboard digits, or wrap to 2 lines per stat block without horizontal clipping.
  - Hourly rate cards (`$20` vs `$30`) maintain side-by-side display down to 340 pt; below 340 pt they stack vertically.
- **Dynamic Type Scaling (Up to 1.6× / 200%):**
  - No fixed pixel heights on text containers or table cells. All containers use `min-height` with `height: auto`.
  - Booking rules key-value rows transition from single-line horizontal flex to vertical stacking when values exceed 60% of row width.
  - Club name in hero wraps smoothly over 2–3 lines without clipping the status pills above or CTA buttons below.

---

## 6. Accessibility Requirements

- **Minimum Touch Targets:** Every interactive element (buttons, tabs, segmented control thumbs, back arrow, links) must provide an active tappable area of at least **48 × 48 pt**.
- **WCAG Contrast Ratios:**
  - Hero text (`#FFFFFF`) on `night` (`#062B1C`): **15.4:1** (Exceeds AAA requirement of 7:1).
  - Primary button text (`#FFFFFF`) on `cedar` (`#0F7A47`): **4.8:1** (Exceeds AA requirement of 4.5:1).
  - Body text (`ink` `#0F1512`) on `ground` (`#F3EFE7`): **14.2:1** (Exceeds AAA).
  - Secondary metadata (`muted` `#4A5450`) on `ground` (`#F3EFE7`): **6.9:1** (Exceeds AA requirement of 4.5:1).
  - Inverted Lebanese Red (`redOnDark` `#F2A0AC`) on `night` (`#062B1C`): **5.8:1** (Exceeds AA).
- **Non-Color Dependence:**
  - Statuses and sports are never communicated solely by red or green color. Facility items always pair color with a checkmark glyph (`✓`).
  - Court types are identified by written names (*Padel*, *Tennis*, *Pitch*) in addition to architectural icons.
  - Inactive vs active tabs combine label weight (Medium vs SemiBold), icon fill weight, and the physical Lebanese-red top bar indicator.

---

## 7. Change Log from Original Court Lines DESIGN.md

This table documents every specific evolution and precision refinement made during the Club Info design review:

| Design Dimension | Original `DESIGN.md` | Approved Master Refinement (`Definitive Master`) | Rationale |
| :--- | :--- | :--- | :--- |
| **Pricing Framing** | Listed hourly rates without disclaimer; earlier drafts used *"Per court"* or *"Verified starting rates"*. | Updated to explicit disclaimer: *“Rates depend on selected court and time. Example starting rates (pending venue verification):”* | Prevents players from assuming flat pricing across different sports (e.g. padel vs 11-a-side football) prior to selecting slots in the booking flow. |
| **Location String** | Often expanded in early drafts to *"Sou2, North Governorate, Lebanon"*. | Locked strictly to verified text: *“Sou2, Batroun”*. Removed redundant *“Open in Maps”* text link. | Eliminates invented geographic data; relies solely on hero *Directions* button. |
| **Court 5 Surface** | Listed as *“Red clay”* in several exploratory iterations. | Reverted strictly to *“clay”* (all lowercase). | Adheres 100% to verified venue database seed. |
| **Court 6 (Pitch 1)** | Described variously as *“5-a-side turf”* or *“Indoor turf”*. | Preserved strictly as *“Football”* without speculative surface or dimension tags. | Avoids unverified assumptions until confirmed by venue management. |
| **Facilities Copy** | Contained grammatical double-negative: *“Not available on-site: No parking, café, floodlights”*. | Corrected to concise, proper English: *“Not available: Parking, café, floodlights”*. | Grammatical correctness and clean readability. |
| **Active Tab Icon** | Originally depicted a tennis racket and ball. | Replaced with abstract multi-sport **Court Lines** geometry. | CourtBook serves padel, tennis, and football; a racket icon misrepresents multi-sport venues. |
| **Hero Red Crown** | Varied between 2.5 pt and 4.0 pt across early explorations. | Locked to canonical **3.5 pt** (`borders.accentCrown`). | Delivers the authentic Lebanese signature identity without overwhelming the calm forest-green header. |
| **Hero CTAs** | Single full-width primary button in early drafts. | Dual actions: White solid primary (*“See free times”*) + translucent framed secondary (*“Directions”*), both ≥ 48 pt height. | Immediately satisfies the two primary user intents when viewing a club overview. |
