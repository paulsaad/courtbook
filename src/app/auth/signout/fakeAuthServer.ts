/// <reference types="node" />
/**
 * TEST ONLY. A local stand-in for Supabase Auth (GoTrue), for the two-session sign-out tests (F2). It keeps sessions
 * per device and answers the endpoints @supabase/auth-js 2.119 uses here, with Supabase Auth's documented semantics:
 *   POST /auth/v1/token?grant_type=password        a new session (its own refresh token and session_id)
 *   POST /auth/v1/token?grant_type=refresh_token   new tokens if the session is alive; otherwise 400 refresh_token_not_found
 *   GET  /auth/v1/user                             the user if the JWT's session is alive; otherwise 403 session_not_found
 *   POST /auth/v1/logout?scope=local|global|others local: this JWT's session; global: every session of the user;
 *                                                  others: every other session (auth-js docs, signOut)
 *   POST /rest/v1/rpc/close_my_account             200 (the database part of closure is tested elsewhere)
 * It records every request, so a test can show which scope was sent. Real Supabase Auth on two real devices is the
 * staging acceptance step; this server only checks that our code sends the right request through the real library.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";

type Session = { id: string; userId: string; refresh: string; revoked: boolean };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

export type FakeAuth = {
  url: string;
  /** set to make /logout answer this instead (e.g. a gateway's 404, a 401, a 403 bad_jwt); null = normal */
  logoutAnswer: { status: number; code?: string } | null;
  requests: { method: string; path: string }[];
  sessions: Session[];
  alive: () => Session[];
  close: () => Promise<void>;
};

export async function startFakeAuth(user = { id: "f7000000-0000-4000-8000-000000000001", email: "rana@example.test" }): Promise<FakeAuth> {
  const sessions: Session[] = [];
  const requests: { method: string; path: string }[] = [];
  const jwtFor = (s: Session) => {
    const now = Math.floor(Date.now() / 1000);
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: s.userId, session_id: s.id, role: "authenticated", aud: "authenticated", email: user.email, iat: now, exp: now + 3600 })}.c2ln`;
  };
  const sessionOf = (req: IncomingMessage) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    try { const sid = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).session_id; return sessions.find((s) => s.id === sid) ?? null; }
    catch { return null; }
  };
  const tokens = (s: Session) => ({
    access_token: jwtFor(s), token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: s.refresh,
    user: { id: user.id, aud: "authenticated", role: "authenticated", email: user.email, app_metadata: { provider: "email" }, user_metadata: {}, created_at: "2026-11-01T00:00:00Z" },
  });
  const body = (req: IncomingMessage) => new Promise<Record<string, unknown>>((res) => {
    let d = ""; req.on("data", (c) => { d += c; }); req.on("end", () => { try { res(d ? JSON.parse(d) : {}); } catch { res({}); } });
  });
  const fake = { logoutAnswer: null as FakeAuth["logoutAnswer"] };
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    requests.push({ method: req.method ?? "", path: u.pathname + u.search });
    const send = (status: number, json?: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(json === undefined ? "" : JSON.stringify(json)); };
    const b = await body(req);
    if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "password") {
      const s = { id: randomUUID(), userId: user.id, refresh: randomUUID(), revoked: false };
      sessions.push(s); return send(200, tokens(s));
    }
    if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "refresh_token") {
      const s = sessions.find((x) => x.refresh === b.refresh_token && !x.revoked);
      if (!s) return send(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" });
      s.refresh = randomUUID(); return send(200, tokens(s));
    }
    if (u.pathname === "/auth/v1/user") {
      const s = sessionOf(req);
      if (!s || s.revoked) return send(403, { code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" });
      return send(200, tokens(s).user);
    }
    if (u.pathname === "/auth/v1/logout" && fake.logoutAnswer) {
      return send(fake.logoutAnswer.status, { code: fake.logoutAnswer.status, error_code: fake.logoutAnswer.code ?? "unexpected", msg: "forced by the test" });
    }
    if (u.pathname === "/auth/v1/logout") {
      const s = sessionOf(req);
      if (!s || s.revoked) return send(403, { code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" });
      const scope = u.searchParams.get("scope") ?? "global";
      for (const x of sessions) {
        if (x.userId !== s.userId) continue;
        if (scope === "global" || (scope === "local" && x.id === s.id) || (scope === "others" && x.id !== s.id)) x.revoked = true;
      }
      return send(204);
    }
    if (u.pathname === "/rest/v1/rpc/close_my_account") return send(200, null);
    send(404, { msg: "not modelled" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, requests, sessions,
    get logoutAnswer() { return fake.logoutAnswer; }, set logoutAnswer(v) { fake.logoutAnswer = v; },
    alive: () => sessions.filter((s) => !s.revoked),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
