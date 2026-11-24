// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { guardProvider, checkStatus, checkCharges, checkStart, validAmount, ProviderAnswerInvalid } = await import("./guard");
const { PaymentStartRefused } = await import("./provider");
const { getProvider, paymentConfigProblem, providerNamed } = await import("./index");

/**
 * M12.3: the provider contract (guard.ts). Every answer a provider adapter gives is checked before the payment engine
 * can act on it. The rule throughout: an answer that is not well formed is never taken as paid and never as failed —
 * it is "unknown", and the attempt stays unresolved until the provider is asked again.
 */
const ATT = "0c000000-0000-4000-8000-0000000000aa";
const good = { attemptId: ATT, amountUsd: 1, currency: "USD" as const, description: "fee", returnUrl: "https://courtbook.example/pay/return?attempt=" + ATT, callbackUrl: "https://courtbook.example/api/pay/callback/whish" };
type Fake = { name: "whish" | "simulated"; startAttempt?: (i: unknown) => Promise<unknown>; attemptStatus?: (id: string) => Promise<unknown>; listCharges?: (a: Date, b: Date) => Promise<unknown>; callbackAttemptId?: (r: Request) => Promise<string | null> };
const make = (f: Fake, hosts: string[] = []) => guardProvider({
  name: f.name, start: vi.fn(), verify: vi.fn(), refund: vi.fn(),
  startAttempt: (f.startAttempt ?? (async () => ({ kind: "redirect", url: "https://pay.example/s/1", session: "S-1" }))) as never,
  attemptStatus: (f.attemptStatus ?? (async () => ({ state: "pending" }))) as never,
  ...(f.listCharges ? { listCharges: f.listCharges as never } : {}),
  ...(f.callbackAttemptId ? { callbackAttemptId: f.callbackAttemptId } : {}),
} as never, { pageHosts: hosts, startTimeoutMs: 50, statusTimeoutMs: 50, listTimeoutMs: 50 });

describe("amounts", () => {
  it("positive, finite, at most two decimals, under a million", () => {
    for (const ok of [1, 0.01, 1.5, 25.99, 999999.99]) expect(validAmount(ok)).toBe(true);
    for (const bad of [0, -1, 1.001, NaN, Infinity, 1e6, "1", "1.00", null, undefined, {}]) expect(validAmount(bad)).toBe(false);
  });
});

describe("status answers: explicit outcomes only", () => {
  it("each of succeeded / failed / expired / pending / unknown passes as such", () => {
    expect(checkStatus({ state: "succeeded", evidence: { providerRef: "W-1", amount: 1, currency: "USD" } })).toEqual({ state: "succeeded", evidence: { providerRef: "W-1", amount: 1, currency: "USD" } });
    for (const st of ["failed", "expired", "pending", "unknown"]) expect(checkStatus({ state: st })).toEqual({ state: st });
  });
  it("anything else is invalid — never success, never failure", () => {
    for (const bad of [null, {}, { state: "paid" }, { state: "SUCCEEDED" }, { state: "succeeded" }, { state: "succeeded", evidence: {} },
      { state: "succeeded", evidence: { providerRef: "", amount: 1, currency: "USD" } },
      { state: "succeeded", evidence: { providerRef: "W 1", amount: 1, currency: "USD" } },
      { state: "succeeded", evidence: { providerRef: "W-1", amount: "1.00", currency: "USD" } },
      { state: "succeeded", evidence: { providerRef: "W-1", amount: -1, currency: "USD" } },
      { state: "succeeded", evidence: { providerRef: "W-1", amount: 1.234, currency: "USD" } },
      { state: "succeeded", evidence: { providerRef: "W-1", amount: 1, currency: "US Dollar" } },
      { state: "succeeded", evidence: { providerRef: "W-1", amount: 1, currency: "" } },
      { state: "succeeded", evidence: { providerRef: "x".repeat(200), amount: 1, currency: "USD" } }]) {
      expect(() => checkStatus(bad)).toThrow(ProviderAnswerInvalid);
    }
  });
  it("a lower-case currency is the same code (the database compares upper case); a different amount or currency is passed on, to be owed back", () => {
    expect(checkStatus({ state: "succeeded", evidence: { providerRef: "W-1", amount: 1, currency: "usd" } })).toMatchObject({ evidence: { currency: "USD" } });
    expect(checkStatus({ state: "succeeded", evidence: { providerRef: "W-1", amount: 2, currency: "LBP" } })).toMatchObject({ evidence: { amount: 2, currency: "LBP" } });
  });
});

describe("start answers", () => {
  it("a hosted page on https with a session; nothing else", () => {
    expect(checkStart({ kind: "redirect", url: "https://pay.example/s/1", session: "S-1" }, false, [])).toEqual({ kind: "redirect", url: "https://pay.example/s/1", session: "S-1" });
    for (const bad of [null, {}, { kind: "redirect" }, { kind: "redirect", url: "http://pay.example/s", session: "S" },
      { kind: "redirect", url: "javascript:alert(1)", session: "S" }, { kind: "redirect", url: "https://u:p@pay.example/", session: "S" },
      { kind: "redirect", url: "https://pay.example/s", session: "" }, { kind: "redirect", url: "https://pay.example/s", session: "has space" },
      { kind: "page", url: "https://pay.example/s", session: "S" }]) {
      expect(() => checkStart(bad, false, [])).toThrow(ProviderAnswerInvalid);
    }
  });
  it("with the provider's page hosts configured, only those hosts", () => {
    expect(() => checkStart({ kind: "redirect", url: "https://evil.example/s", session: "S" }, false, ["pay.example"])).toThrow(ProviderAnswerInvalid);
    expect(checkStart({ kind: "redirect", url: "https://PAY.example/s", session: "S" }, false, ["pay.example"]).kind).toBe("redirect");
  });
  it("money at once: only from the simulated provider, and only with well-formed evidence", () => {
    const imm = { kind: "immediate", evidence: { providerRef: "SIM-1", amount: 1, currency: "USD" } };
    expect(() => checkStart(imm, false, [])).toThrow(ProviderAnswerInvalid);
    expect(checkStart(imm, true, [])).toEqual(imm);
    expect(() => checkStart({ kind: "immediate", evidence: { providerRef: "SIM-1", amount: 0, currency: "USD" } }, true, [])).toThrow(ProviderAnswerInvalid);
  });
});

describe("the guarded provider", () => {
  it("our own request is checked before anything is sent: a bad reference, amount, currency or URL is a refusal, and the provider is never called", async () => {
    const start = vi.fn(async () => ({ kind: "redirect", url: "https://pay.example/s/1", session: "S" }));
    const p = make({ name: "whish", startAttempt: start });
    for (const bad of [{ attemptId: "1; drop" }, { amountUsd: 0 }, { amountUsd: 1.001 }, { currency: "LBP" }, { returnUrl: "http://evil.example/x" }, { callbackUrl: "ftp://x/y" }]) {
      await expect(p.startAttempt({ ...good, ...bad } as never)).rejects.toBeInstanceOf(PaymentStartRefused);
    }
    expect(start).not.toHaveBeenCalled();
  });
  it("a provider that does not answer in time: the start is UNKNOWN (not a refusal) and status is unavailable", async () => {
    const never = () => new Promise<never>(() => {});
    const p = make({ name: "whish", startAttempt: never, attemptStatus: never });
    const s = p.startAttempt(good).catch((e) => e);
    expect(await s).toBeInstanceOf(ProviderAnswerInvalid);
    expect(await s).not.toBeInstanceOf(PaymentStartRefused);
    await expect(p.attemptStatus(ATT)).rejects.toBeInstanceOf(ProviderAnswerInvalid);
  });
  it("an adapter's own refusal passes through untouched (that alone ends an attempt)", async () => {
    const p = make({ name: "whish", startAttempt: async () => { throw new PaymentStartRefused("declined"); } });
    await expect(p.startAttempt(good)).rejects.toBeInstanceOf(PaymentStartRefused);
  });
  it("a malformed start answer (an error page, a wrong shape) is UNKNOWN, never a refusal", async () => {
    const p = make({ name: "whish", startAttempt: async () => "<html>502 Bad Gateway</html>" });
    const e = await p.startAttempt(good).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderAnswerInvalid);
    expect(e).not.toBeInstanceOf(PaymentStartRefused);
  });
  it("a status call for something that is not one of our references is refused before the provider is asked", async () => {
    const st = vi.fn(async () => ({ state: "succeeded", evidence: { providerRef: "W", amount: 1, currency: "USD" } }));
    await expect(make({ name: "whish", attemptStatus: st }).attemptStatus("../admin")).rejects.toBeInstanceOf(ProviderAnswerInvalid);
    expect(st).not.toHaveBeenCalled();
  });
  it("a callback names only an attempt, and only a UUID; anything else is ignored", async () => {
    const p = make({ name: "whish", callbackAttemptId: async () => "' or 1=1 --" });
    expect(await p.callbackAttemptId!(new Request("https://x"))).toBeNull();
    const q = make({ name: "whish", callbackAttemptId: async () => ATT });
    expect(await q.callbackAttemptId!(new Request("https://x"))).toBe(ATT);
  });
  it("the charge list: all records well formed, or the whole list is refused (a partial list must never move the watermark)", async () => {
    const one = { externalRef: ATT, providerRef: "W-1", amount: 1, currency: "USD" };
    expect(await make({ name: "whish", listCharges: async () => [one, { ...one, providerRef: "W-2", externalRef: null }] }).listCharges!(new Date(0), new Date())).toHaveLength(2);
    for (const bad of [null, {}, [one, { ...one, amount: "1" }], [one, null], [{ ...one, externalRef: 5 }]]) {
      await expect(make({ name: "whish", listCharges: async () => bad }).listCharges!(new Date(0), new Date())).rejects.toBeInstanceOf(ProviderAnswerInvalid);
    }
    expect(() => checkCharges([{ ...one, currency: "US" }])).toThrow(ProviderAnswerInvalid);
  });
});

describe("configuration: a mistake never silently means 'simulated'", () => {
  it("unset / empty / simulated → simulated; whish → the unimplemented adapter", () => {
    for (const v of [undefined, "", "simulated"]) expect(getProvider({ PAYMENT_PROVIDER: v }).name).toBe("simulated");
    expect(getProvider({ PAYMENT_PROVIDER: "whish" }).name).toBe("whish");
  });
  it("a typo or stray whitespace → no provider at all: every start refused, every status unanswered", async () => {
    for (const v of ["whsh", "Whish", " whish", "simulated ", "stripe"]) {
      const p = getProvider({ PAYMENT_PROVIDER: v });
      expect(p.name).not.toBe("simulated");
      await expect(p.startAttempt(good)).rejects.toBeInstanceOf(PaymentStartRefused);
      await expect(p.attemptStatus(ATT)).rejects.toThrow();
    }
  });
  it("the problem is named for the operator (codes only)", () => {
    expect(paymentConfigProblem({})).toBeNull();
    expect(paymentConfigProblem({ PAYMENT_PROVIDER: "simulated" })).toBeNull();
    expect(paymentConfigProblem({ PAYMENT_PROVIDER: "whsh" })).toBe("provider_unknown");
    expect(paymentConfigProblem({ PAYMENT_PROVIDER: "whish " })).toBe("provider_name_whitespace");
    expect(paymentConfigProblem({ PAYMENT_PROVIDER: "whish" })).toBe("provider_not_implemented");
    expect(paymentConfigProblem({ PAYMENT_PAGE_HOSTS: "!!!" })).toBe("page_hosts_invalid");
  });
  it("the Whish adapter stays disabled: it refuses to start and never reports a payment", async () => {
    const p = getProvider({ PAYMENT_PROVIDER: "whish" });
    await expect(p.startAttempt(good)).rejects.toBeInstanceOf(PaymentStartRefused);
    await expect(p.attemptStatus(ATT)).rejects.toThrow();
  });
  it("a row of another provider is never answered by this deployment's provider", () => {
    expect(providerNamed("whish")).toBeNull();                 // PAYMENT_PROVIDER unset here → simulated
    expect(providerNamed("simulated")?.name).toBe("simulated");
  });
});
