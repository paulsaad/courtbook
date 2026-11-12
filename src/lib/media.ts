/** One stored image for a club. `path` is an object in the club-media bucket; `external_url` is a
 *  cover that predates managed storage and is still hosted wherever it always was. */
export type ClubMedia = {
  id: string;
  kind: "cover" | "logo" | "gallery";
  path: string | null;
  external_url: string | null;
  caption: string | null;
  sort: number;
  width: number | null;
  height: number | null;
};

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

/** Where to fetch this image from. Public bucket, so no signing and no expiry. */
export function mediaUrl(m: Pick<ClubMedia, "path" | "external_url">): string {
  if (m.external_url) return m.external_url;
  return `${BASE}/storage/v1/object/public/club-media/${m.path}`;
}

/** Alt text that says something, falling back to a description of the picture's job. */
export function mediaAlt(m: Pick<ClubMedia, "caption" | "kind">, clubName: string, n?: number): string {
  if (m.caption) return m.caption;
  if (m.kind === "cover") return `${clubName}, main photo`;
  if (m.kind === "logo") return `${clubName} logo`;
  return `${clubName}, photo ${n ?? 1}`;
}
