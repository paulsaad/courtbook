import { NextResponse } from "next/server";
import sharp from "sharp";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The only writer to the club-media bucket.
 *
 * The bucket has no insert policy, so a signed-in player — or anyone with their token — cannot put
 * a file there directly. Everything published therefore passes through here, which means these
 * checks hold for every image rather than being applied by the form and skippable:
 *
 *   - the bytes are decoded as an image by sharp, so a renamed file is rejected whatever its name
 *     or declared content type says;
 *   - dimensions are bounded by the re-encode, so a 50-megapixel photo cannot be published;
 *   - the output is WebP, and re-encoding carries no metadata across, so EXIF — including the GPS
 *     coordinates a phone writes into a photo — is gone;
 *   - the result is size-checked after encoding, not before.
 *
 * Permission is checked twice: here, before any work, and again inside the database function that
 * records the row. Neither trusts the other.
 */

const TARGETS = {
  cover:   { w: 1600, h: 600 },
  logo:    { w: 400,  h: 400 },
  gallery: { w: 1200, h: 900 },
} as const;
type Kind = keyof typeof TARGETS;

const MAX_INPUT = 15 * 1024 * 1024;   // before re-encoding; the bucket caps the stored object at 5 MB
const MAX_OUTPUT = 1024 * 1024;

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected a file upload." }, { status: 400 });

  const clubId = String(form.get("clubId") ?? "");
  const kind = String(form.get("kind") ?? "") as Kind;
  const caption = form.get("caption") ? String(form.get("caption")) : null;
  const expect = form.get("expect") ? String(form.get("expect")) : null;
  const file = form.get("file");

  if (!clubId || !(kind in TARGETS)) return NextResponse.json({ error: "Missing club or image kind." }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  if (file.size > MAX_INPUT) return NextResponse.json({ error: "That image is over 15 MB. Please pick a smaller one." }, { status: 413 });
  if (caption && caption.length > 80) return NextResponse.json({ error: "A caption can be at most 80 characters." }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { error: permErr } = await supabase.rpc("assert_club_editor", { p_club: clubId });
  if (permErr) return NextResponse.json({ error: "You cannot change this club's images." }, { status: 403 });

  // Decode and re-encode. A file that is not really an image fails here, whatever it was called.
  const target = TARGETS[kind];
  let out: Buffer, width: number, height: number;
  try {
    const input = Buffer.from(await file.arrayBuffer());
    const pipeline = sharp(input, { failOn: "error" })
      .rotate()                                       // apply the EXIF orientation, then drop the rest
      .resize(target.w, target.h, { fit: "cover", position: "centre", withoutEnlargement: false })
      .webp({ quality: 82 });
    out = await pipeline.toBuffer();
    const meta = await sharp(out).metadata();
    width = meta.width ?? target.w;
    height = meta.height ?? target.h;
  } catch {
    return NextResponse.json({ error: "That file is not an image we can read. Try a JPEG, PNG or WebP." }, { status: 415 });
  }
  if (out.byteLength > MAX_OUTPUT) {
    return NextResponse.json({ error: "That image is too detailed to publish. Try a smaller one." }, { status: 413 });
  }

  // A new object every time, named at random: a failure leaves whatever is published untouched, and
  // a public link carries neither the original filename nor anything about the uploader.
  const admin = createAdminClient();
  const path = `clubs/${clubId}/${crypto.randomUUID()}.webp`;
  const { error: upErr } = await admin.storage.from("club-media").upload(path, out, {
    contentType: "image/webp", cacheControl: "31536000", upsert: false,
  });
  if (upErr) return NextResponse.json({ error: "Could not store the image. Nothing was changed." }, { status: 502 });

  // Record it. Only now does anything the player sees change.
  let oldPath: string | null = null;
  if (kind === "gallery") {
    const { error } = await supabase.rpc("add_club_gallery", {
      p_club: clubId, p_path: path, p_caption: caption, p_width: width, p_height: height,
    });
    if (error) {
      await admin.storage.from("club-media").remove([path]);     // nothing referenced it yet
      return NextResponse.json({ error: dbMessage(error.message) }, { status: 409 });
    }
  } else {
    const { data, error } = await supabase.rpc("set_club_image", {
      p_club: clubId, p_kind: kind, p_path: path, p_width: width, p_height: height, p_expect: expect,
    });
    if (error) {
      await admin.storage.from("club-media").remove([path]);
      return NextResponse.json({ error: dbMessage(error.message) }, { status: 409 });
    }
    oldPath = (Array.isArray(data) ? data[0] : data)?.old_path ?? null;
  }

  // The new image is published. If clearing the old file fails, that is a tidying problem, not a
  // failed replacement: report it for cleanup and tell the caller it worked.
  if (oldPath) {
    const { error: delErr } = await admin.storage.from("club-media").remove([oldPath]);
    if (delErr) await supabase.rpc("record_media_orphan", { p_club: clubId, p_path: oldPath, p_reason: "replace: delete failed" });
  }
  return NextResponse.json({ ok: true, path, width, height });
}

/** Remove one image, then its file. A file that will not delete is recorded, not retried blindly. */
export async function DELETE(request: Request) {
  const { mediaId, clubId } = (await request.json().catch(() => ({}))) as { mediaId?: string; clubId?: string };
  if (!mediaId || !clubId) return NextResponse.json({ error: "mediaId required" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { data: path, error } = await supabase.rpc("remove_club_media", { p_id: mediaId });
  if (error) return NextResponse.json({ error: dbMessage(error.message) }, { status: 403 });

  if (path) {
    const admin = createAdminClient();
    const { error: delErr } = await admin.storage.from("club-media").remove([path as string]);
    if (delErr) await supabase.rpc("record_media_orphan", { p_club: clubId, p_path: path, p_reason: "remove: delete failed" });
  }
  return NextResponse.json({ ok: true });
}

function dbMessage(raw: string) {
  if (raw.includes("gallery_full")) return "A club can show six photos. Remove one first.";
  if (raw.includes("changed_elsewhere")) return "Someone else changed this club's images just now. Reload and try again.";
  if (raw.includes("caption_too_long")) return "A caption can be at most 80 characters.";
  if (raw.includes("forbidden")) return "You cannot change this club's images.";
  return "Could not save that image.";
}
