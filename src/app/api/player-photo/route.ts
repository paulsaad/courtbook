import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processPhoto } from "@/lib/playerPhoto/process";
import { PHOTO, sameOrigin, toPgBytea } from "@/lib/playerPhoto/shared";

/**
 * DRAFT — the player's own photo: POST uploads or replaces it, DELETE removes it.
 *
 * The only writer. The bytes a browser sends are never stored: they are decoded and re-encoded here (processPhoto),
 * and only the result is written, by set_player_photo, which refuses any caller but the server. The photo lives in
 * the database row, so there is no storage object to orphan and nothing to clean up if the write fails.
 */

const REFUSALS: Record<string, { status: number; error: string }> = {
  account_closed: { status: 403, error: "This account is closed." },
  suspended: { status: 403, error: "Your account is suspended, so you cannot change your photo." },
};

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a photo to upload." }, { status: 400 });
  if (file.size > PHOTO.maxInput) return NextResponse.json({ error: "That photo is too large. Please pick a smaller one." }, { status: 413 });

  const p = await processPhoto(Buffer.from(await file.arrayBuffer()));
  if (!p.ok) {
    return p.reason === "not_image"
      ? NextResponse.json({ error: "That file is not a photo we can read. Try a JPEG, PNG or WebP." }, { status: 415 })
      : NextResponse.json({ error: "That photo is too large. Please pick a smaller one." }, { status: 413 });
  }

  const { data, error } = await createAdminClient().rpc("set_player_photo", {
    p_actor: user.id, p_image: toPgBytea(p.webp), p_width: p.width, p_height: p.height,
  });
  if (error) {
    const known = REFUSALS[error.message ?? ""];
    if (known) return NextResponse.json({ error: known.error }, { status: known.status });
    console.error(`player-photo: could not save (${error.code}: ${error.message})`);
    return NextResponse.json({ error: "Your photo could not be saved because of a problem on our side. Please try again." }, { status: 500 });
  }
  return NextResponse.json({ version: data as number });
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { error } = await supabase.rpc("remove_player_photo");
  if (error) {
    console.error(`player-photo: could not remove (${error.code}: ${error.message})`);
    return NextResponse.json({ error: "Your photo could not be removed because of a problem on our side. Please try again." }, { status: 500 });
  }
  return NextResponse.json({ removed: true });
}
