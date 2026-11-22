"use client";

import { useState } from "react";
import { PRIVACY_PROBE, SAFE_MESSAGES } from "@/lib/monitoring";

/** Raises uncaught browser errors (outside React, so the page stays usable) and opens the server test route. */
export default function MonitoringTest({ environment, enabled }: { environment: string; enabled: boolean }) {
  const [sent, setSent] = useState<string | null>(null);
  const raise = (message: string, label: string) => {
    setTimeout(() => { throw new Error(message); }, 0);
    setSent(label);
  };
  const button = "min-h-11 rounded-xl border border-grid px-4 py-3 text-left font-medium";
  return (
    <main className="mx-auto flex max-w-md flex-col gap-3 p-6 md:max-w-2xl lg:max-w-[720px]">
      <h1 className="text-xl font-semibold">Monitoring test</h1>
      <p className="text-sm text-muted">Environment: {environment}. Monitoring is {enabled ? "on" : "off (no DSN)"}.</p>
      <button type="button" className={button} onClick={() => raise(SAFE_MESSAGES.testBrowser, "browser test")}>1. Browser test error</button>
      <button type="button" className={button} onClick={() => raise(PRIVACY_PROBE, "browser privacy probe")}>2. Browser privacy probe</button>
      <a className={button} href="/api/monitoring/test?kind=server&probe_query=probe@example.invalid">3. Server test error</a>
      <a className={button} href="/api/monitoring/test?kind=probe&probe_query=probe@example.invalid">4. Server privacy probe</a>
      {sent && <p className="text-sm text-muted">Sent: {sent}.</p>}
    </main>
  );
}
