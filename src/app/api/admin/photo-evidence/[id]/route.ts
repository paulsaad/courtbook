import { createClient } from "@/lib/supabase/server";
import { UUID, fromPgBytea } from "@/lib/playerPhoto/shared";

/**
 * DRAFT (#67, Paul's decision 4, 27 Nov) — one copy of a reported player's photo, for a photo moderator only.
 *
 * The database decides (moderator_photo_evidence runs as the caller: a listed photo moderator who is an active admin)
 * and records every reading in the moderation log. Being an admin alone is not enough. Anything else — not signed in,
 * not a photo moderator, no such copy, schema not there — is the same 404, so the endpoint says nothing about whether
 * a copy exists. Never cached anywhere: no-store, and private so no shared cache may keep it even if one ignored that.
 */
const NO_STORE = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };
const NONE = () => new Response(null, { status: 404, headers: NO_STORE });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return NONE();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NONE();

  const { data, error } = await supabase.rpc("moderator_photo_evidence", { p_evidence: id });
  if (error) {
    if (/forbidden|not_found|Could not find the function|PGRST202/.test(`${error.code} ${error.message}`)) return NONE();
    console.error(`photo-evidence: read failed (${error.code})`);
    return new Response(null, { status: 500, headers: NO_STORE });
  }
  const bytes = fromPgBytea(data);
  if (!bytes) return NONE();
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    },
  });
}
