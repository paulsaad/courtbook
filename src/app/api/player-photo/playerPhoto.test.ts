// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";

/**
 * Player photo (DRAFT): the re-encode, the byte helpers, and both routes against mock Supabase clients that record
 * which client ran which call. The database rules themselves are tested in supabase/tests/photo/player_photos.sh.
 */
vi.mock("server-only", () => ({}));
type Call = { client: "user" | "service"; fn: string; args?: unknown };
let calls: Call[];
let user: { id: string } | null;
let userRpc: Record<string, { data?: unknown; error?: { message: string; code?: string } | null }>;
let serviceRpc: Record<string, { data?: unknown; error?: { message: string; code?: string } | null }>;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc: async (fn: string, args?: unknown) => { calls.push({ client: "user", fn, args }); return { data: null, error: null, ...(userRpc[fn] ?? {}) }; },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args?: unknown) => { calls.push({ client: "service", fn, args }); return { data: null, error: null, ...(serviceRpc[fn] ?? {}) }; },
  }),
}));

const { processPhoto } = await import("@/lib/playerPhoto/process");
const shared = await import("@/lib/playerPhoto/shared");
const upload = await import("./route");
const view = await import("./[id]/route");

const ME = "a0000000-0000-4000-8000-00000000000a";
const OTHER = "b0000000-0000-4000-8000-00000000000b";
const SITE = "https://courtbook.example";

async function jpegWithGps(w = 1200, h = 900) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 60, b: 40 } } })
    .jpeg()
    .withExifMerge({ IFD0: { Make: "TestPhone", Copyright: "secret-owner" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "34/1 15/1 0/1" } })
    .toBuffer();
}
async function noise(w: number, h: number) {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}
function form(file: Blob | string | null, headers: Record<string, string> = { origin: SITE, "sec-fetch-site": "same-origin" }) {
  const body = new FormData();
  if (file !== null) body.append("file", file as Blob);
  return new Request(`${SITE}/api/player-photo`, { method: "POST", headers, body });
}

beforeEach(() => { calls = []; user = { id: ME }; userRpc = {}; serviceRpc = { set_player_photo: { data: 3 } }; });

describe("processPhoto", () => {
  it("re-encodes to a 256 px square WebP with no EXIF (GPS and owner gone)", async () => {
    const input = await jpegWithGps();
    expect((await sharp(input).metadata()).exif).toBeDefined();         // the control: the input does carry EXIF
    const r = await processPhoto(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const meta = await sharp(r.webp).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([256, 256]);
    expect(meta.exif).toBeUndefined();
    expect(r.webp.includes(Buffer.from("secret-owner"))).toBe(false);
    expect(r.webp.byteLength).toBeLessThanOrEqual(shared.PHOTO.maxOutput);
  });
  it("starts with RIFF…WEBP, which the table checks", async () => {
    const r = await processPhoto(await jpegWithGps(300, 300));
    if (!r.ok) throw new Error("expected ok");
    expect(r.webp.subarray(0, 4).toString()).toBe("RIFF");
    expect(r.webp.subarray(8, 12).toString()).toBe("WEBP");
  });
  it("a noisy photo still fits under the cap", async () => {
    const r = await processPhoto(await noise(1024, 1024));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.webp.byteLength).toBeLessThanOrEqual(shared.PHOTO.maxOutput);
  });
  it("a renamed non-image is refused", async () => {
    expect(await processPhoto(Buffer.from("%PDF-1.4 not a photo at all"))).toEqual({ ok: false, reason: "not_image" });
  });
  it("an input over the upload cap (4 MB) is refused before decoding", async () => {
    expect(await processPhoto(Buffer.alloc(shared.PHOTO.maxInput + 1))).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("pixel limit (decompression bomb)", () => {
  it("a small file holding a valid image just over the pixel limit is refused, not decoded", async () => {
    const { MAX_INPUT_PIXELS } = await import("@/lib/playerPhoto/process");
    const w = 7000, h = Math.ceil(MAX_INPUT_PIXELS / w) + 10;      // just over the limit
    const bomb = await sharp(Buffer.alloc(w * h), { raw: { width: w, height: h, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.byteLength).toBeLessThan(PHOTO_MAX_INPUT());          // passes the byte cap: only the pixel limit stops it
    expect(await processPhoto(bomb)).toEqual({ ok: false, reason: "not_image" });
  }, 30_000);
  it("an image just under the limit is accepted (the limit is not set too low)", async () => {
    const r = await processPhoto(await sharp(Buffer.alloc(4000 * 3000), { raw: { width: 4000, height: 3000, channels: 1 } }).png().toBuffer());
    expect(r.ok).toBe(true);
  }, 30_000);
});
const PHOTO_MAX_INPUT = () => shared.PHOTO.maxInput;

describe("browser shrink sizes", () => {
  it.each([[4032, 3024, 1024, 768], [3024, 4032, 768, 1024], [800, 600, 800, 600], [5000, 10, 1024, 2]])(
    "%i×%i → %i×%i (longer side ≤ 1024, never enlarged)", async (w, h, ew, eh) => {
      const { scaledSize } = await import("@/lib/playerPhoto/shrink");
      expect(scaledSize(w, h)).toEqual({ width: ew, height: eh });
    });
});

describe("byte helpers", () => {
  it("bytea round trip", () => {
    const b = Buffer.from([0, 1, 254, 255]);
    expect(shared.toPgBytea(b)).toBe("\\x0001feff");
    expect(shared.fromPgBytea("\\x0001feff")).toEqual(b);
  });
  it.each([null, 5, "0001", "\\x0", "\\xzz"])("refuses a malformed bytea %s", (v) => {
    expect(shared.fromPgBytea(v)).toBeNull();
  });
  it("initials follow the profile header's rule", () => {
    expect(shared.initialsOf("Rami Khoury")).toBe("RK");
    expect(shared.initialsOf(null)).toBe("?");
    expect(shared.initialsOf("  ")).toBe("?");
  });
});

describe("POST /api/player-photo", () => {
  it("stores the re-encoded bytes through the service client, never the upload itself", async () => {
    const input = await jpegWithGps();
    const res = await upload.POST(form(new Blob([new Uint8Array(input)], { type: "image/jpeg" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 3 });
    expect(calls.map((c) => `${c.client}:${c.fn}`)).toEqual(["service:set_player_photo"]);
    const args = calls[0].args as { p_actor: string; p_image: string; p_width: number };
    expect(args.p_actor).toBe(ME);
    expect(args.p_width).toBe(256);
    const stored = shared.fromPgBytea(args.p_image)!;
    expect((await sharp(stored).metadata()).format).toBe("webp");
    expect(stored.equals(input)).toBe(false);
  });
  it("refuses a cross-site request before anything else", async () => {
    const res = await upload.POST(form(new Blob(["x"]), { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
  it("refuses a missing Origin", async () => {
    expect((await upload.POST(form(new Blob(["x"]), {}))).status).toBe(403);
  });
  it("needs a signed-in user", async () => {
    user = null;
    expect((await upload.POST(form(new Blob(["x"])))).status).toBe(401);
    expect(calls).toEqual([]);
  });
  it("a non-image is 415 and nothing is written", async () => {
    const res = await upload.POST(form(new Blob(["not an image"], { type: "image/jpeg" })));
    expect(res.status).toBe(415);
    expect(calls).toEqual([]);
  });
  it("an upload over the cap is 413 and nothing is decoded or written", async () => {
    const res = await upload.POST(form(new Blob([new Uint8Array(shared.PHOTO.maxInput + 1)], { type: "image/jpeg" })));
    expect(res.status).toBe(413);
    expect(calls).toEqual([]);
  });
  it("no file is 400", async () => {
    expect((await upload.POST(form(null))).status).toBe(400);
  });
  it.each([["account_closed", 403], ["suspended", 403], ["something else", 500]])("database refusal %s → %i", async (msg, status) => {
    serviceRpc = { set_player_photo: { error: { message: msg, code: "P0001" } } };
    const res = await upload.POST(form(new Blob([new Uint8Array(await jpegWithGps(300, 300))])));
    expect(res.status).toBe(status);
  });
});

describe("DELETE /api/player-photo", () => {
  const del = (headers: Record<string, string> = { origin: SITE, "sec-fetch-site": "same-origin" }) =>
    new Request(`${SITE}/api/player-photo`, { method: "DELETE", headers });
  it("runs as the player, not the service key", async () => {
    const res = await upload.DELETE(del());
    expect(res.status).toBe(200);
    expect(calls.map((c) => `${c.client}:${c.fn}`)).toEqual(["user:remove_player_photo"]);
  });
  it("refuses cross-site", async () => {
    expect((await upload.DELETE(del({ origin: "https://evil.example" }))).status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("GET /api/player-photo/[id]", () => {
  const get = (id: string, headers: Record<string, string> = {}) =>
    view.GET(new Request(`${SITE}/api/player-photo/${id}?v=1`, { headers }), { params: Promise.resolve({ id }) });
  const img = async () => shared.toPgBytea((await processPhoto(await jpegWithGps(300, 300)) as { webp: Buffer }).webp);

  it("serves a visible photo as WebP, privately and revalidated, asking the database as the viewer", async () => {
    userRpc = { player_photo: { data: [{ image: await img(), version: 4 }] } };
    const res = await get(OTHER);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("etag")).toBe('"v4"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(calls).toEqual([{ client: "user", fn: "player_photo", args: { p_subject: OTHER } }]);
  });
  it("304 when the cached version still matches", async () => {
    userRpc = { player_photo: { data: [{ image: await img(), version: 4 }] } };
    expect((await get(OTHER, { "if-none-match": '"v4"' })).status).toBe(304);
  });
  it("not visible (no row) is a 404 that is not cached", async () => {
    userRpc = { player_photo: { data: [] } };
    const res = await get(OTHER);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
  it("signed out is the same 404, without asking the database", async () => {
    user = null;
    expect((await get(OTHER)).status).toBe(404);
    expect(calls).toEqual([]);
  });
  it("a malformed id is 404 without asking the database", async () => {
    expect((await get("../../etc")).status).toBe(404);
    expect(calls).toEqual([]);
  });
  it("a database error is 500, not a 404 that would hide the fault", async () => {
    userRpc = { player_photo: { error: { message: "boom", code: "XX000" } } };
    expect((await get(OTHER)).status).toBe(500);
  });
});
