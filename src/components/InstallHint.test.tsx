// @vitest-environment jsdom
/**
 * Local pilot build, iPhone user agent (26 Nov): every Home visit logged React error #418 (hydration
 * mismatch) because the hint decided "iPhone" during the first render, which the server cannot know.
 * Now the server and hydration agree (no hint), and the hint appears right after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import InstallHint from "./InstallHint";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
const ua = (s: string) => vi.spyOn(navigator, "userAgent", "get").mockReturnValue(s);
beforeEach(() => {
  localStorage.clear();
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

describe("Add to Home Screen hint", () => {
  it("iPhone: hydrates without a mismatch, then shows the hint", async () => {
    ua(IPHONE);
    const html = renderToString(<InstallHint />);           // the server: no hint
    expect(html).toBe("");
    const host = document.createElement("div"); host.innerHTML = html; document.body.appendChild(host);
    const recoverable: unknown[] = [];
    await act(async () => { hydrateRoot(host, <InstallHint />, { onRecoverableError: (e) => recoverable.push(e) }); });
    expect(recoverable).toEqual([]);
    expect(host.textContent).toContain("Add CourtBook to your home screen");
    expect(host.textContent).toContain("Tap Share");
  });

  it("dismissed stays dismissed", () => {
    ua(IPHONE);
    render(<InstallHint />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/home screen/)).toBeNull();
    cleanup();
    render(<InstallHint />);
    expect(screen.queryByText(/home screen/)).toBeNull();
  });

  it("already installed (standalone): nothing", () => {
    ua(IPHONE);
    window.matchMedia = ((q: string) => ({ matches: q.includes("standalone"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    render(<InstallHint />);
    expect(screen.queryByText(/home screen/)).toBeNull();
  });

  it("Android: nothing until the browser offers installing, then Install", async () => {
    ua(ANDROID);
    render(<InstallHint />);
    expect(screen.queryByText(/home screen/)).toBeNull();
    const e = Object.assign(new Event("beforeinstallprompt"), { prompt: async () => {}, userChoice: Promise.resolve({ outcome: "dismissed" as const }) });
    await act(async () => { window.dispatchEvent(e); });
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
  });
});
