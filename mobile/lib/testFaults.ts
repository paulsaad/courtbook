import * as Updates from "expo-updates";
import type { Attempt, Lookup, ReserveResult } from "./reserve";
import { installedVariant } from "./appIdentity";

/**
 * Test builds only: make the next reservations lose their connection on purpose, so the
 * unresolved-reservation flow can be tested on a phone without racing airplane mode.
 *
 *   answer-lost  — the reservation IS sent to the database and handled normally (one booking, the
 *                  usual checks); the app then throws the answer away, as if the connection had
 *                  dropped after the database committed. Lookups by token get "no answer".
 *   request-lost — nothing is sent; the app reports "no answer", as if the connection had dropped
 *                  before the request left. Lookups by token get "no answer".
 *
 * While a fault is on, nothing reaches the database except the one real reservation request in
 * answer-lost. Turning the fault off lets lookups through, which settles the reservation the usual
 * way. Never in a store build (unavailable, and setFault refuses); kept in memory only, so
 * closing the app always turns it off.
 */
export type Fault = "off" | "answer-lost" | "request-lost";

export const FAULT_LABEL: Record<Fault, string> = {
  off: "Off",
  "answer-lost": "Answer lost",
  "request-lost": "Request lost",
};

// Test builds: the live app's preview channel, the CourtBook Staging app, development builds.
let available = __DEV__ || Updates.channel === "preview" || installedVariant === "staging";
let fault: Fault = "off";
const listeners = new Set<() => void>();

export const faultsAvailable = () => available;
export const currentFault = () => fault;
export function subscribeFault(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

export function setFault(f: Fault): boolean {
  if (!available && f !== "off") return false;
  fault = f;
  listeners.forEach((l) => l());
  return true;
}

const noAnswer = (message: string): ReserveResult => ({ kind: "uncertain", failure: { kind: "network", message } });

export async function withReserveFault(real: (a: Attempt) => Promise<ReserveResult>, a: Attempt): Promise<ReserveResult> {
  if (fault === "request-lost") return noAnswer("Test: request lost before it was sent");
  if (fault === "answer-lost") {
    await real(a); // really sent, really handled by the database; the answer is then dropped
    return noAnswer("Test: answer lost after the database handled the request");
  }
  return real(a);
}

export async function withLookupFault(real: (token: string) => Promise<Lookup>, token: string): Promise<Lookup> {
  if (fault !== "off") return { kind: "unreachable" };
  return real(token);
}

/** Tests only. */
export function __setFaultsAvailableForTests(v: boolean) { available = v; if (!v) fault = "off"; }
