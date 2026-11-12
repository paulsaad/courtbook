import { NextResponse } from "next/server";
import sharp from "sharp";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The only writer to the club-media bucket, and the only caller of the functions that publish an
 * image. The bucket refuses writes from a browser and those functions refuse to run for anyone but
 * this route, so everything a visitor sees passed through here and these checks hold for every
 * image rather than being applied by the form and skippable:
 *
 *   - the bytes are decoded as an image by sharp, so a renamed file is rejected whatever its name
 *     or declared content type says;
 *   - dimensions are bounded by the re-encode, so a 50-megapixel photo cannot be published;
 *   - the output is WebP, and re-encoding carries no metadata across, so EXIF — including the GPS
 *     coordinates a phone writes into a photo — is gone;
 *   - the result is size-checked after encoding, not before;
 *   - the stored object is named here, at random, under this club's own folder.
 *
 * Permission is established twice, and neither check trusts the other. First the caller's own token
 * must satisfy assert_club_editor, which runs as them. Then the database is told who asked, and
 * decides again — along with whether the path is one this route could have produced.
 *
 * Storing the file and recording the row are two steps, so they can disagree. The rule throughout:
 * **an error from the database is not evidence that it refused.** A commit can land and its response
 * be lost on the way back. So before deleting anything, this route asks the table what actually
 * happened, and when it cannot find out it keeps the file. A leftover file is a tidying problem; a
 * deleted file that a published row still points at is a broken image on a club's page.
 */

const TARGETS = {
  cover:   { w: 1600, h: 600 },
  logo:    { w: 400,  h: 400 },
  gallery: { w: 1200, h: 900 },
} as const;
type Kind = keyof typeof TARGETS;

const MAX_INPUT = 15 * 1024 * 1024;   // before re-encoding; the bucket caps the stored object at 5 MB
const MAX_OUTPUT = 1024 * 1024;

type Admin = ReturnType<typeof createAdminClient>;
type RpcError = { message?: string };

/** Who is asking, and may they change this club? Returns the caller's id, or a response to send. */
async function editorOf(clubId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Sign in first." }, { status: 401 }) };
  const { error } = await supabase.rpc("assert_club_editor", { p_club: clubId });
  if (error) return { error: NextResponse.json({ error: "You cannot change this club's images." }, { status: 403 }) };
  return { actor: user.id };
}

/**
 * Did the publication land? The path is unique to this upload, so the table itself is the answer —
 * which beats reading the error, because a lost response and a refusal can look alike.
 * "unknown" means the question could not be asked.
 */
async function isPublished(admin: Admin, path: string): Promise<boolean | "unknown"> {
  const { data, error } = await admin.from("club_media").select("id").eq("path", path).maybeSingle();
  if (error) return "unknown";
  return data !== null;
}

/** Store a file for later reconciliation when it cannot be deleted. Failing that, say so in the log. */
async function recordOrphan(admin: Admin, actor: string, clubId: string, path: string, reason: string) {
  const { error } = await admin.rpc("record_media_orphan", {
    p_actor: actor, p_club: clubId, p_path: path, p_reason: reason,
  });
  if (error) {
    console.error(`club-media: ${path} is unused, could not be deleted, and could not be recorded for cleanup (${error.message}). It must be removed by hand.`);
  }
}

/**
 * The publication RPC came back with an error. Work out whether it truly refused before touching the
 * file. Returns a response to send, or null when the publication in fact succeeded.
 */
async function afterFailedPublish(
  admin: Admin, actor: string, clubId: string, path: string, err: RpcError,
) {
  const landed = await isPublished(admin, path);

  if (landed === true) return null;        // it committed; only the answer was lost. The file stays.

  if (landed === "unknown") {              // never delete on a guess
    console.error(`club-media: could not establish whether ${path} was published (${err.message}). The object is kept for reconciliation.`);
    return NextResponse.json({ error: dbMessage(err.message ?? "") }, { status: 409 });
  }

  // A genuine refusal: nothing references the file, so clear it — and account for it if that fails.
  const { error: delErr } = await admin.storage.from("club-media").remove([path]);
  if (delErr) await recordOrphan(admin, actor, clubId, path, "rejected: delete failed");
  return NextResponse.json({ error: dbMessage(err.message ?? "") }, { status: 409 });
}

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

  const who = await editorOf(clubId);
  if (who.error) return who.error;
  const actor = who.actor!;
  const admin = createAdminClient();

  // Note the file a cover or logo is about to replace. The function returns it too, but if that
  // answer is lost the old file would otherwise be left behind with nothing naming it.
  let replacing: string | null = null;
  if (kind !== "gallery" && expect) {
    const { data } = await admin.from("club_media").select("path").eq("id", expect).maybeSingle();
    replacing = (data?.path as string | undefined) ?? null;
  }

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
  // a public link carries neither the original filename nor anything about the uploader. The name
  // is also the only shape the database will accept, so a path invented elsewhere cannot be used.
  const path = `clubs/${clubId}/${crypto.randomUUID()}.webp`;
  const { error: upErr } = await admin.storage.from("club-media").upload(path, out, {
    contentType: "image/webp", cacheControl: "31536000", upsert: false,
  });
  if (upErr) return NextResponse.json({ error: "Could not store the image. Nothing was changed." }, { status: 502 });

  // Record it. Only now does anything the player sees change.
  let oldPath: string | null = null;
  if (kind === "gallery") {
    const { error } = await admin.rpc("add_club_gallery", {
      p_actor: actor, p_club: clubId, p_path: path, p_caption: caption, p_width: width, p_height: height,
    });
    if (error) {
      const bail = await afterFailedPublish(admin, actor, clubId, path, error);
      if (bail) return bail;
    }
  } else {
    const { data, error } = await admin.rpc("set_club_image", {
      p_actor: actor, p_club: clubId, p_kind: kind, p_path: path,
      p_width: width, p_height: height, p_expect: expect,
    });
    if (error) {
      const bail = await afterFailedPublish(admin, actor, clubId, path, error);
      if (bail) return bail;
      oldPath = replacing;          // it landed after all, so the row it replaced is the one we noted
    } else {
      oldPath = (Array.isArray(data) ? data[0] : data)?.old_path ?? null;
    }
  }

  // The new image is published. If clearing the old file fails, that is a tidying problem, not a
  // failed replacement: record it for cleanup and tell the caller it worked.
  if (oldPath) {
    const { error: delErr } = await admin.storage.from("club-media").remove([oldPath]);
    if (delErr) await recordOrphan(admin, actor, clubId, oldPath, "replace: delete failed");
  }
  return NextResponse.json({ ok: true, path, width, height });
}

/** Caption and order. Neither moves bytes, but both publish, so both come through here. */
export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string; clubId?: string; mediaId?: string; caption?: string | null; ids?: string[];
  };
  const clubId = body.clubId;
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });

  const who = await editorOf(clubId);
  if (who.error) return who.error;
  const admin = createAdminClient();

  if (body.action === "caption") {
    if (!body.mediaId) return NextResponse.json({ error: "mediaId required" }, { status: 400 });
    const caption = body.caption?.trim() ? body.caption.trim() : null;
    if (caption && caption.length > 80) return NextResponse.json({ error: "A caption can be at most 80 characters." }, { status: 400 });
    const { error } = await admin.rpc("set_gallery_caption", {
      p_actor: who.actor, p_id: body.mediaId, p_caption: caption,
    });
    if (error) return NextResponse.json({ error: dbMessage(error.message) }, { status: 409 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "reorder") {
    if (!Array.isArray(body.ids) || body.ids.length === 0) return NextResponse.json({ error: "ids required" }, { status: 400 });
    const { error } = await admin.rpc("reorder_club_gallery", {
      p_actor: who.actor, p_club: clubId, p_ids: body.ids,
    });
    if (error) return NextResponse.json({ error: dbMessage(error.message) }, { status: 409 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

/**
 * Remove one image, then its file. The same lost-response hazard applies in reverse here: if the row
 * is gone and we assume it is not, the file is left behind with nothing naming it. So the path is
 * noted first, and the table decides what happened.
 */
export async function DELETE(request: Request) {
  const { mediaId, clubId } = (await request.json().catch(() => ({}))) as { mediaId?: string; clubId?: string };
  if (!mediaId || !clubId) return NextResponse.json({ error: "mediaId required" }, { status: 400 });

  const who = await editorOf(clubId);
  if (who.error) return who.error;
  const actor = who.actor!;
  const admin = createAdminClient();

  const { data: before } = await admin.from("club_media").select("path").eq("id", mediaId).maybeSingle();
  const { data: returned, error } = await admin.rpc("remove_club_media", { p_actor: actor, p_id: mediaId });

  let doomed: string | null = (returned as string | null) ?? null;
  if (error) {
    const { data: still, error: checkErr } = await admin.from("club_media").select("id").eq("id", mediaId).maybeSingle();
    if (checkErr) {
      console.error(`club-media: could not establish whether ${mediaId} was removed (${error.message}). Nothing was deleted.`);
      return NextResponse.json({ error: "Could not remove that image. Try again in a moment." }, { status: 502 });
    }
    if (still) return NextResponse.json({ error: dbMessage(error.message) }, { status: 403 });   // a real refusal
    doomed = (before?.path as string | undefined) ?? null;      // it committed; the answer was lost
  }

  if (doomed) {
    const { error: delErr } = await admin.storage.from("club-media").remove([doomed]);
    if (delErr) await recordOrphan(admin, actor, clubId, doomed, "remove: delete failed");
  }
  return NextResponse.json({ ok: true });
}

function dbMessage(raw: string) {
  if (raw.includes("gallery_full")) return "A club can show six photos. Remove one first.";
  if (raw.includes("changed_elsewhere")) return "Someone else changed this club's images just now. Reload and try again.";
  if (raw.includes("caption_too_long")) return "A caption can be at most 80 characters.";
  if (raw.includes("bad_path") || raw.includes("path_required")) return "That image could not be published. Upload it again.";
  if (raw.includes("forbidden") || raw.includes("not_authenticated")) return "You cannot change this club's images.";
  return "Could not save that image.";
}
