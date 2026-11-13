/**
 * Design tokens. Every colour, size and radius in the app comes from here, so the visual pass
 * after the screen designs are approved is a change to this file, not to every screen.
 *
 * Values follow the "Court Lines" proposal (cedar night, cedar, limestone, the red line).
 * STATUS: approved by Paul 2026-11-13 (refined round).
 */
export const color = {
  night: "#062B1C", // hero surfaces, tickets
  cedar: "#0F7A47", // primary actions, free slots, success
  cedarDeep: "#0A5C36", // green text on light surfaces
  cedarSoft: "#DCEFE3",
  ground: "#F3EFE7", // page background (limestone)
  line: "#E2DCCF", // hairlines and borders
  card: "#FFFFFF",
  ink: "#0F1512",
  muted: "#4A5450", // 6.9:1 on ground, 7.9:1 on white
  red: "#C8102E", // accent only: once per view, never for errors
  danger: "#B42318", // errors, always with words
  warnSoft: "#FCEFD2", // limited availability, pending states
  warnInk: "#7A4E00", // 6.3:1 on warnSoft
  booked: "#6B6455", // unavailable slots, 5.1:1 on ground
  emptySlot: "#7D7565", // dashed open-spot circles, 4.6:1 on white
  onDark: "#FFFFFF",
  onDarkMuted: "#CFE6D8",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

export const radius = { sm: 10, md: 14, lg: 18, xl: 22, pill: 999 } as const;

/**
 * Typefaces (SIL Open Font License, files in assets/fonts). Custom fonts carry their weight in the
 * family name, so components set fontFamily and never fontWeight (Android otherwise substitutes).
 */
export const font = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  display: "Archivo_700Bold",
  displayHeavy: "Archivo_800ExtraBold",
  score: "ArchivoNarrow_700Bold", // times, prices, counts: the scoreboard
  scoreSemi: "ArchivoNarrow_600SemiBold",
} as const;

/** Legacy size set used by M1 placeholder screens; new screens use components/Text variants. */
export const text = {
  title: { fontSize: 28, lineHeight: 32, fontWeight: "700" as const, letterSpacing: -0.5 },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: "700" as const },
  body: { fontSize: 16, lineHeight: 22, fontWeight: "400" as const },
  label: { fontSize: 14, lineHeight: 19, fontWeight: "600" as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "400" as const },
} as const;

/** Minimum touch target (iOS 44 pt; Android asks 48 dp, so 48 is used everywhere). */
export const TOUCH = 48;

/** Largest text scale honoured before layouts are allowed to wrap rather than grow. */
export const MAX_FONT_SCALE = 1.6;
