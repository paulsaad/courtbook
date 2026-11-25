import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import { onlineManager } from "@tanstack/react-query";
import { ChunkedSecureStore } from "./secureStorage";
import { supabase } from "./supabase";
import { paymentConfig } from "./feePayment";
import { PayController } from "./payController";

/**
 * The device side of M12.4: whether this build may pay the booking fee in the app, and the one PayController.
 *
 * EXPO_PUBLIC_FEE_PAYMENTS must be read exactly like this (a static dotted property) for Expo to inline it at build
 * time. Distributed builds do not set it: the feature is off and fee_online clubs keep "Reserve on the website".
 * EXPO_PUBLIC_PAYMENT_DEV_SERVER is used only outside a native build, and only if it is a localhost address.
 */
export const payments = paymentConfig(Application.applicationId, process.env.EXPO_PUBLIC_FEE_PAYMENTS, process.env.EXPO_PUBLIC_PAYMENT_DEV_SERVER);
export const FEE_PAYMENTS_ON = payments.enabled;

/** No answer after this long is "unknown" — never a failure, never retried on its own. */
export const PAYMENT_CALL_TIMEOUT_MS = 20_000;

async function post(path: string, body: Record<string, string>): Promise<{ status: number; body: unknown } | null> {
  if (!payments.enabled) return { status: 503, body: { error: "payments_not_configured", final: true } };
  const { data } = await supabase.auth.getSession();          // refreshed by supabase-js when it has expired
  const token = data.session?.access_token;
  if (!token) return { status: 401, body: { error: "not_authenticated", final: true } };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PAYMENT_CALL_TIMEOUT_MS);
  try {
    // the token travels only in this header: never in a URL, a deep link, a log or storage of ours
    const r = await fetch(`${payments.server}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    let parsed: unknown = null;
    try { parsed = await r.json(); } catch { parsed = null; }
    return { status: r.status, body: parsed };
  } catch {
    return null;   // offline, timeout, dropped: unknown
  } finally {
    clearTimeout(timer);
  }
}

let controller: PayController | null = null;
export function payController(): PayController {
  return (controller ??= new PayController({
    storage: ChunkedSecureStore,
    post,
    newKey: () => Crypto.randomUUID(),
    isOnline: () => onlineManager.isOnline(),
    now: () => Date.now(),
  }));
}
