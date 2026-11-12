// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * These tests are about what the route does when storage and the database disagree. Storing the file
 * and recording the row are two steps; the dangerous case is an error that is not a refusal, because
 * deleting the file then breaks an image that is already published.
 */

const storage = { upload: vi.fn(), remove: vi.fn() };
const rpc = vi.fn();
const rows = { "club_media": [] as Array<Record<string, unknown>> };
let selectFails = false;

/** A small stand-in for the query builder, filtering the rows an eq() names. */
function from(table: string) {
  const filters: Array<[string, unknown]> = [];
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => { filters.push([col, val]); return builder; },
    maybeSingle: async () => {
      if (selectFails) return { data: null, error: { message: "fetch failed" } };
      const match = (rows[table as keyof typeof rows] ?? []).find((r) =>
        filters.every(([c, v]) => r[c] === v));
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

const { POST } = await import("./route");

const CLUB = "11111111-1111-1111-1111-111111111111";

function upload(kind: "cover" | "gallery", expect_?: string) {
  const body = new FormData();
  body.set("clubId", CLUB);
  body.set("kind", kind);
  body.set("file", new File([Buffer.from("not-really-an-image")], "p.jpg", { type: "image/jpeg" }));
  if (expect_) body.set("expect", expect_);
  return new Request("http://localhost/api/club-media", { method: "POST", body });
}

/** The path the route generated, taken from the upload call it made. */
function uploadedPath() {
  return storage.upload.mock.calls[0][0] as string;
}

beforeEach(() => {
  storage.upload.mockReset().mockResolvedValue({ error: null });
  storage.remove.mockReset().mockResolvedValue({ error: null });
  rpc.mockReset();
  rows.club_media = [];
  selectFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("club-media publication when the answer is lost", () => {
  it("keeps the file when the row was written but the reply failed", async () => {
    // The commit landed. All the route sees is an error.
    rpc.mockImplementation(async (fn: string) => {
      if (fn === "add_club_gallery") {
        rows.club_media.push({ id: "m-1", path: uploadedPath() });
        return { data: null, error: { message: "fetch failed" } };
      }
      return { data: null, error: null };
    });

    const res = await POST(upload("gallery"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("deletes the file when the database really did refuse", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "gallery_full" } });

    const res = await POST(upload("gallery"));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("six photos");
    expect(storage.remove).toHaveBeenCalledWith([uploadedPath()]);
  });

  it("keeps the file when it cannot find out what happened", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "fetch failed" } });
    selectFails = true;                       // the reconciling read fails too

    const res = await POST(upload("gallery"));

    expect(res.status).toBe(409);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("records the file for cleanup when a refusal leaves it undeletable", async () => {
    rpc.mockImplementation(async (fn: string) => {
      if (fn === "add_club_gallery") return { data: null, error: { message: "gallery_full" } };
      return { data: null, error: null };
    });
    storage.remove.mockResolvedValue({ error: { message: "503" } });

    const res = await POST(upload("gallery"));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("six photos");         // the user still hears the real reason
    expect(rpc).toHaveBeenCalledWith("record_media_orphan", expect.objectContaining({
      p_club: CLUB, p_path: uploadedPath(), p_reason: "rejected: delete failed",
    }));
  });

  it("still clears the old cover when the reply to a replacement is lost", async () => {
    rows.club_media.push({ id: "old-1", path: `clubs/${CLUB}/old.webp` });
    rpc.mockImplementation(async (fn: string) => {
      if (fn === "set_club_image") {
        rows.club_media.push({ id: "new-1", path: uploadedPath() });
        return { data: null, error: { message: "fetch failed" } };
      }
      return { data: null, error: null };
    });

    const res = await POST(upload("cover", "old-1"));

    expect(res.status).toBe(200);
    expect(storage.remove).toHaveBeenCalledWith([`clubs/${CLUB}/old.webp`]);
    expect(storage.remove).not.toHaveBeenCalledWith([uploadedPath()]);
  });
});
