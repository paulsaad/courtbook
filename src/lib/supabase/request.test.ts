// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Who is calling a route shared by the website and the app. The properties under test:
 * the cookie path is unchanged; a bearer token is accepted only when Supabase Auth verifies it;
 * a bad header is refused without falling back to the cookie; nothing else names the user.
 */
const VALID = "aaa.bbb.ccc";
const tokenClients: Array<{ headers: Record<string, string> }> = [];
const getUserForToken = vi.fn(async (token: string) =>
  token === VALID ? { data: { user: { id: "app-user" } }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } }
);
vi.mock("@supabase/supabase-js", () => ({
  createClient: (_u: string, _k: string, opts: { global: { headers: Record<string, string> } }) => {
    tokenClients.push({ headers: opts.global.headers });
    return { auth: { getUser: getUserForToken } };
  },
}));
let cookieUser: { id: string } | null = { id: "web-user" };
const cookieGetUser = vi.fn(async () => ({ data: { user: cookieUser } }));
vi.mock("./server", () => ({ createClient: async () => ({ auth: { getUser: cookieGetUser } }) }));

const { authenticateRequest } = await import("./request");
const req = (headers: Record<string, string> = {}, body?: unknown) =>
  new Request("https://example.test/api/pay/simulate", { method: "POST", headers, body: body ? JSON.stringify(body) : undefined });

beforeEach(() => {
  tokenClients.length = 0;
  getUserForToken.mockClear();
  cookieGetUser.mockClear();
  cookieUser = { id: "web-user" };
});

describe("authenticateRequest", () => {
  it("website: no Authorization header uses the cookie session, unchanged", async () => {
    const r = await authenticateRequest(req());
    expect(r).toMatchObject({ ok: true, via: "cookie", user: { id: "web-user" } });
    expect(getUserForToken).not.toHaveBeenCalled();
  });

  it("website: no cookie session is 401", async () => {
    cookieUser = null;
    expect(await authenticateRequest(req())).toEqual({ ok: false, status: 401, error: "not_authenticated" });
  });

  it("app: a token Supabase Auth verifies is accepted, and the client queries as that user", async () => {
    const r = await authenticateRequest(req({ Authorization: `Bearer ${VALID}` }));
    expect(r).toMatchObject({ ok: true, via: "bearer", user: { id: "app-user" } });
    expect(getUserForToken).toHaveBeenCalledWith(VALID);
    expect(tokenClients[0].headers.Authorization).toBe(`Bearer ${VALID}`);
    expect(cookieGetUser).not.toHaveBeenCalled();
  });

  it.each([
    ["an expired or forged token", `Bearer xxx.yyy.zzz`],
    ["a token that is not a JWT", "Bearer not-a-jwt"],
    ["Basic credentials", "Basic dXNlcjpwYXNz"],
    ["an empty bearer", "Bearer "],
  ])("app: %s is 401 and never falls back to the cookie", async (_name, header) => {
    const r = await authenticateRequest(req({ Authorization: header }));
    expect(r).toEqual({ ok: false, status: 401, error: "invalid_authorization" });
    expect(cookieGetUser).not.toHaveBeenCalled();
  });

  it("an identity in the body or another header is ignored", async () => {
    const r = await authenticateRequest(
      req({ Authorization: `Bearer ${VALID}`, "x-user-id": "someone-else" }, { user_id: "someone-else", profile_id: "someone-else" })
    );
    expect(r).toMatchObject({ ok: true, user: { id: "app-user" } });
  });
});
