import { createClient } from "@/lib/supabase/server";
import { UUID, fromPgBytea } from "@/lib/playerPhoto/shared";

/**
 * DRAFT — one player's photo, if the signed-in caller may see it (the database decides, as the caller: themself, or
 * someone they share a non-cancelled game with as organizer or accepted player, with no block either way).
 *
 * "No photo" and "not allowed" are the same 404, so the endpoint does not tell a stranger whether someone has a photo.
 * Cached privately but revalidated every time (no-cache + ETag), so a block or a closed account takes effect at once;
 * a revalidation that still matches costs a 304 without the bytes.
 */
const NONE = () => new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return NONE();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NONE();

  const { data, error } = await supabase.rpc("player_photo", { p_subject: id });
  if (error) {
    console.error(`player-photo: read failed (${error.code}: ${error.message})`);
    return new Response(null, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
  const row = (data as { image: string; version: number }[] | null)?.[0];
  const bytes = row ? fromPgBytea(row.image) : null;
  if (!row || !bytes) return NONE();

  const etag = `"v${row.version}"`;
  const headers = {
    "Content-Type": "image/webp",
    "Cache-Control": "private, no-cache",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}
