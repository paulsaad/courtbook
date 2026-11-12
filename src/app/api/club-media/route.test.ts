// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * These tests are about what the route does when storage and the database disagree. Storing a file
 * and recording a row are two steps, and the dangerous mistake is deleting a file on the strength of
 * an error that is not proof the transaction ended. The mock table below is written so that a
 * publication either happens completely or not at all, as a transaction does.
 */

const storage = { upload: vi.fn(), remove: vi.fn() };
const rpc = vi.fn();
let media: Array<Record<string, unknown>> = [];
let selectFails = false;

/** A small stand-in for the query builder, filtering the rows an eq() names. */
function from() {
  const filters: Array<[string, unknown]> = [];
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => { filters.push([col, val]); return builder; },
    maybeSingle: async () => {
      if (selectFails) return { data: null, error: { message: "fetch failed" } };
      const match = media.find((r) => filters.every(([c, v]) => r[c] === v));
      return { data: match ?? null, error: null };
    },
  };
  return builder;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc, from, storage: { from: () => storage } }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "actor-1" } } }) },
    rpc: async () => ({ error: null }),
  }),
}));

vi.mock("sharp", () => {
  const api: Record<string, unknown> = {};
  api.rotate = () => api;
  api.resize = () => api;
  api.webp = () => api;
  api.toBuffer = async () => Buffer.from("fake-webp");
  api.metadata = async () => ({ width: 1200, height: 900 });
  return { default: () => api };
});

const { POST, DELETE } = await import("./route");

const CLUB = "11111111-1111-1111-1111-111111111111";
const OLD_COVER = `clubs/${CLUB}/old-cover.webp`;

/** A dropped connection or a gateway timeout: no SQLSTATE, so nothing is proven. */
const NO_ANSWER = { message: "TypeError: fetch failed" };
/** A refusal Postgres itself raised, which means the transaction is rolled back and gone. */
const RAISED = (msg: string) => ({ message: msg, code: "P0001" });

function upload(kind: "cover" | "gallery", expect_?: string) {
  const body = new FormData();
  body.set("clubId", CLUB);
  body.set("kind", kind);
  body.set("file", new File([Buffer.from("not-really-an-image")], "p.jpg", { type: "image/jpeg" }));
  if (expect_) body.set("expect", expect_);
  return new Request("http://localhost/api/club-media", { method: "POST", body });
}

function del(mediaId: string) {
  return new Request("http://localhost/api/club-media", {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mediaId, clubId: CLUB }),
  });
}

/** The path the route generated, taken from the upload call it made. */
function uploadedPath() {
  return storage.upload.mock.calls[0][0] as string;
}
function removedPaths() {
  return storage.remove.mock.calls.map((c) => (c[0] as string[])[0]);
}
function orphaned() {
  return rpc.mock.calls.filter((c) => c[0] === "record_media_orphan").map((c) => c[1]);
}

beforeEach(() => {
  storage.upload.mockReset().mockResolvedValue({ error: null });
  storage.remove.mockReset().mockResolvedValue({ error: null });
  rpc.mockReset().mockResolvedValue({ data: null, error: null });
  media = [];
  selectFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("publishing an image when the answer is lost", () => {
  it("keeps the file when the row was written but the reply failed", async () => {
    rpc.mockImplementation(async (fn: string) => {
      if (fn !== "add_club_gallery") return { data: null, error: null };
      media.push({ id: "m-1", path: uploadedPath() });        // the commit landed
      return { data: null, error: NO_ANSWER };                 // the reply did not
    });

    const res = await POST(upload("gallery"));

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("keeps the file when the transaction may still be running", async () => {
    // The connection dropped while the function was blocked on the club lock. Nothing is written
    // yet, so the reconciling read finds nothing — and then the transaction commits.
    rpc.mockImplementation(async (fn: string) => {
      if (fn !== "add_club_gallery") return { data: null, error: null };
      return { data: null, error: NO_ANSWER };
    });

    const res = await POST(upload("gallery"));
    const path = uploadedPath();

    expect(res.status).toBe(409);
    expect(storage.remove).not.toHaveBeenCalled();             // the file must survive
    expect(orphaned()).toEqual([expect.objectContaining({
      p_path: path, p_reason: "publication outcome unknown: establish it before deleting",
      p_certain: false,
    })]);

    // Now the in-flight transaction commits. Had the route deleted the file, this row would point
    // at nothing. It points at a file that is still there.
    media.push({ id: "m-late", path });
    expect(removedPaths()).not.toContain(path);
  });

  // A code can be perfectly well-formed and still say the outcome is unknown. These two do.
  it.each([
    ["08007", "transaction_resolution_unknown"],
    ["40003", "statement_completion_unknown"],
    ["53100", "a code this route has never considered"],
  ])("keeps the file on %s (%s)", async (code) => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "add_club_gallery"
        ? { data: null, error: { message: "could not complete", code } }
        : { data: null, error: null });

    const res = await POST(upload("gallery"));
    const path = uploadedPath();

    expect(res.status).toBe(409);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(orphaned()).toEqual([expect.objectContaining({ p_path: path, p_certain: false })]);

    // And when the publication turns out to have committed, the file it references is still there.
    media.push({ id: "m-late", path });
    expect(removedPaths()).not.toContain(path);
  });

  it("deletes the file only when Postgres itself refused", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "add_club_gallery" ? { data: null, error: RAISED("gallery_full") } : { data: null, error: null });

    const res = await POST(upload("gallery"));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("six photos");
    expect(removedPaths()).toEqual([uploadedPath()]);
  });

  it("keeps the file when the reconciling read fails too", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "add_club_gallery" ? { data: null, error: NO_ANSWER } : { data: null, error: null });
    selectFails = true;

    const res = await POST(upload("gallery"));

    expect(res.status).toBe(409);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("records the file for cleanup when a refusal leaves it undeletable", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "add_club_gallery" ? { data: null, error: RAISED("gallery_full") } : { data: null, error: null });
    storage.remove.mockResolvedValue({ error: { message: "503" } });

    const res = await POST(upload("gallery"));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("six photos");   // the user still hears the real reason
    expect(orphaned()).toEqual([expect.objectContaining({
      p_club: CLUB, p_path: uploadedPath(), p_reason: "rejected: delete failed", p_certain: true,
    })]);
  });

  it("replaces a cover atomically, clearing only the file nothing points at", async () => {
    media = [{ id: "old-1", path: OLD_COVER }];
    rpc.mockImplementation(async (fn: string) => {
      if (fn !== "set_club_image") return { data: null, error: null };
      // What the function really does: the old row goes and the new one arrives together.
      media = [{ id: "new-1", path: uploadedPath() }];
      return { data: null, error: NO_ANSWER };                  // ...and the reply is lost
    });

    const res = await POST(upload("cover", "old-1"));

    expect(res.status).toBe(200);
    // The table now references the new file and nothing else.
    expect(media).toEqual([{ id: "new-1", path: uploadedPath() }]);
    // So exactly the old file is cleaned up, and the referenced one is untouched.
    expect(removedPaths()).toEqual([OLD_COVER]);
    expect(removedPaths()).not.toContain(uploadedPath());
  });
});

describe("removing an image when the answer is lost", () => {
  it("deletes the file when the row is gone but the reply failed", async () => {
    media = [{ id: "m-1", path: OLD_COVER }];
    rpc.mockImplementation(async (fn: string) => {
      if (fn !== "remove_club_media") return { data: null, error: null };
      media = [];                                               // the removal committed
      return { data: null, error: NO_ANSWER };
    });

    const res = await DELETE(del("m-1"));

    expect(res.status).toBe(200);
    expect(removedPaths()).toEqual([OLD_COVER]);
  });

  it("leaves the file alone when Postgres refused", async () => {
    media = [{ id: "m-1", path: OLD_COVER }];
    rpc.mockImplementation(async (fn: string) =>
      fn === "remove_club_media" ? { data: null, error: RAISED("forbidden") } : { data: null, error: null });

    const res = await DELETE(del("m-1"));

    expect(res.status).toBe(403);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("leaves the file alone when the row is still there, which may be a transaction in flight", async () => {
    media = [{ id: "m-1", path: OLD_COVER }];
    rpc.mockImplementation(async (fn: string) =>
      fn === "remove_club_media" ? { data: null, error: NO_ANSWER } : { data: null, error: null });

    const res = await DELETE(del("m-1"));

    expect(res.status).toBe(502);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("leaves the file alone when it cannot find out", async () => {
    media = [{ id: "m-1", path: OLD_COVER }];
    rpc.mockImplementation(async (fn: string) =>
      fn === "remove_club_media" ? { data: null, error: NO_ANSWER } : { data: null, error: null });
    selectFails = true;

    const res = await DELETE(del("m-1"));

    expect(res.status).toBe(502);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("deletes the file on the ordinary path", async () => {
    media = [{ id: "m-1", path: OLD_COVER }];
    rpc.mockImplementation(async (fn: string) =>
      fn === "remove_club_media" ? { data: OLD_COVER, error: null } : { data: null, error: null });

    const res = await DELETE(del("m-1"));

    expect(res.status).toBe(200);
    expect(removedPaths()).toEqual([OLD_COVER]);
  });
});
