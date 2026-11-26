/**
 * Player photo helpers that are safe on the client and the server (no sharp, no Supabase).
 * DRAFT — the database side is docs/profile-photo/sql/player_photos.draft.sql and is not applied anywhere yet.
 */

export const PHOTO = {
  size: 256,                       // stored square, in pixels
  maxInput: 10 * 1024 * 1024,      // the upload, before re-encoding
  maxOutput: 64 * 1024,            // the stored WebP; the table refuses anything larger
} as const;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The image URL. The version changes on every replacement, so a new photo is never served from an old cache entry. */
export function photoUrl(profileId: string, version: number): string {
  return `/api/player-photo/${profileId}?v=${version}`;
}

/** Initials for the placeholder: the same rule the profile header has always used. */
export function initialsOf(name: string | null | undefined, fallback = "?"): string {
  return (name || fallback).split(/[\s@]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
}

/** bytea as PostgREST takes it and returns it: "\x" followed by hex. */
export function toPgBytea(b: Uint8Array): string {
  return "\\x" + Buffer.from(b).toString("hex");
}
export function fromPgBytea(s: unknown): Buffer | null {
  if (typeof s !== "string" || !s.startsWith("\\x") || (s.length - 2) % 2 !== 0 || !/^[0-9a-f]*$/i.test(s.slice(2))) return null;
  return Buffer.from(s.slice(2), "hex");
}

/**
 * A write from a page of this site. Supabase's cookies are SameSite=Lax, so a cross-site form cannot carry them on a
 * POST anyway; this is the second lock, as on the account routes.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return false;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin";
}
