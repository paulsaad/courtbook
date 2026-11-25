import { NextResponse } from "next/server";
import { playerFromBearer } from "@/lib/supabase/bearer";
import { appleDeletionDeps, appleDeletionSetup } from "@/lib/apple/routeDeps";
import { closeAppleAccount, type AppleDeletionInput } from "@/lib/apple/deletion";

/**
 * E1 (draft, OFF): deleting an Apple-linked account from the app, with Sign in with Apple token revocation.
 * POST { method: "apple", code, intent } | { method: "fallback", intent } with the app's bearer token.
 * The order and every rule are in closeAppleAccount (src/lib/apple/deletion.ts): intent bound to this account →
 * Apple identities from the server → recent sign-in (database) → exchange and verify (apple) → close_my_account as
 * the person → revoke → mark → existing processing. Nothing about Apple is stored; no token is returned or logged.
 *
 * Answers: 200 { closed: true, revocation } · 202 { closed: "unknown" } (never "nothing changed") ·
 *          4xx/5xx { error } with closed: false (definitely nothing changed). Off: 503 not_configured.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STATUS: Record<string, number> = {
  bad_request: 400, intent_invalid: 403, account_mismatch: 403,
  reauth_required: 409, staff_role: 409, admin_role: 409, processing_unavailable: 409, not_apple_account: 409,
  apple_code_missing: 422, apple_code_rejected: 422, wrong_apple_account: 422, apple_identity_unverified: 422,
  apple_unavailable: 503, identity_lookup_failed: 503,
};

function input(body: unknown): AppleDeletionInput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.intent !== "string" || b.intent.length > 512) return null;
  if (b.method === "fallback") return { method: "fallback", intent: b.intent };
  if (b.method === "apple" && typeof b.code === "string" && b.code.length <= 2048) return { method: "apple", code: b.code, intent: b.intent };
  return null;
}

export async function POST(request: Request) {
  const setup = appleDeletionSetup();
  if (!setup) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const who = await playerFromBearer(request);
  if (!who) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  let body: unknown = null;
  try { body = await request.json(); } catch { /* bad JSON → bad_request */ }
  const inp = input(body);
  if (!inp) return NextResponse.json({ error: "bad_request", closed: false }, { status: 400 });

  const out = await closeAppleAccount(inp, appleDeletionDeps(setup, who));
  const headers = { "cache-control": "no-store" };
  if (out.closed === true) return NextResponse.json({ closed: true, revocation: out.revocation }, { headers });
  if (out.closed === "unknown") return NextResponse.json({ closed: "unknown", error: out.code }, { status: 202, headers });
  return NextResponse.json({ closed: false, error: out.code }, { status: STATUS[out.code] ?? 500, headers });
}
