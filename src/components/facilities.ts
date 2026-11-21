/**
 * The seven venue facilities, in display order: [column on clubs, label].
 * A plain module (no "use client") so the server-rendered club Info page and the browser-side
 * ClubVenue editor can both import it. Exported from ClubVenue.tsx ("use client") it reached the
 * server page as a client reference, and the page failed with "FACILITIES.map is not a function".
 */
export const FACILITIES = [
  ["has_parking", "Parking"],
  ["has_changing_rooms", "Changing rooms"],
  ["has_showers", "Showers"],
  ["has_equipment_rental", "Equipment rental"],
  ["has_cafe", "Café"],
  ["has_floodlights", "Floodlights"],
  ["has_drinking_water", "Drinking water"],
] as const;
