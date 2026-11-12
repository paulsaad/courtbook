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
 * Storing the file and recording the row are two steps, so they can disagree, and the route must
 * decide what to do with a file when it does not know whether the row was written.
 *
 * Deleting the file is only safe with proof that the transaction ended without it. There are exactly
 * two kinds of proof, and nothing else counts:
 *
 *   - **the row is there.** It committed; only the reply was lost. Keep the file.
 *   - **the error carries a SQLSTATE.** Postgres ran the statement and PostgREST rolled the
 *     transaction back before answering, so there is no transaction left to commit. Delete the file.
 *
 * An absent row proves nothing: the transaction may still be running — blocked on the club lock, for
 * instance — and about to commit a reference to the very file we were about to delete. A dropped
 * connection or a gateway timeout proves nothing either. In that case the file stays and its path is
 * recorded in `media_orphans`, where a later sweep can see the settled outcome and act on it. A
 * leftover file is a tidying problem; a deleted file that a published row points at is a broken
 * image on a club's page.
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
type RpcError = { message?: string; code?: string };

/**
 * Did the transaction definitely roll back? A five-character SQLSTATE in the response says Postgres
 * ran the statement and PostgREST rolled back before replying — our own `raise` arrives as P0001,
 * a constraint as 23xxx. Nothing is left that could still commit.
 *
 * A dropped connection, a timeout, or a gateway error carries no SQLSTATE and proves nothing: the
 * transaction may be in flight. PostgREST's own codes (PGRST…) are deliberately not accepted here —
 * being conservative costs a leftover file, and being wrong costs a published image.
 */
function provesRollback(err: RpcError) {
  return typeof err.code === "string" && /^[0-9A-Z]{5}$/.test(err.code);
}

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
 * Is the row there? The path is unique to this upload, so a hit is proof the publication committed.
 * A miss is not proof of anything — see the note at the top of the file.
 */
async function isPublished(admin: Admin, path: string): Promise<boolean> {
  const { data, error } = await admin.from("club_media").select("id").eq("path", path).maybeSingle();
  if (error) return false;
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
  const refused = NextResponse.json({ error: dbMessage(err.message ?? "") }, { status: 409 });

  // Proof of rollback, in the reply itself. No read needed, and nothing can commit afterwards.
  if (provesRollback(err)) {
    const { error: delErr } = await admin.storage.from("club-media").remove([path]);
    if (delErr) await recordOrphan(admin, actor, clubId, path, "rejected: delete failed");
    return refused;
  }

  // No proof either way. The row being there is proof it committed.
  if (await isPublished(admin, path)) return null;

  // Still no proof. The transaction may be running right now and about to reference this file, so it
  // stays; a later sweep will see the settled outcome. This is also the path a failed read takes.
  console.error(`club-media: could not establish whether ${path} was published (${err.message}). The object is kept for reconciliation.`);
  await recordOrphan(admin, actor, clubId, path, "publication outcome unknown: verify before deleting");
  return refused;
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
    // Proof of rollback: the row is untouched, so its file is still referenced. Leave both alone.
    if (provesRollback(error)) return NextResponse.json({ error: dbMessage(error.message) }, { status: 403 });

    // No proof. Here the row's *absence* is what settles it: the removal committed and the reply was
    // lost, so the file it named is now unreferenced. A row still present means either a refusal or
    // a transaction in flight, and in both cases the file must stay.
    const { data: still, error: checkErr } = await admin.from("club_media").select("id").eq("id", mediaId).maybeSingle();
    if (checkErr || still) {
      console.error(`club-media: could not establish whether ${mediaId} was removed (${error.message}). Nothing was deleted.`);
      return NextResponse.json({ error: "Could not remove that image. Try again in a moment." }, { status: 502 });
    }
    doomed = (before?.path as string | undefined) ?? null;
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
