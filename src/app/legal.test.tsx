// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import PrivacyPage, { metadata as privacyMeta } from "./privacy/page";
import TermsPage, { metadata as termsMeta } from "./terms/page";
import DeleteAccountInfo from "./delete-account/page";
import { CONTACT_EMAIL, LEGAL_LINKS, LEGAL_STATUS, LEGAL_UPDATED } from "@/lib/legal";
import { COMMUNITY_RULES } from "@/lib/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
afterEach(cleanup);

const PAGES = [
  { name: "privacy", path: "/privacy", file: "src/app/privacy/page.tsx", el: () => <PrivacyPage />, meta: privacyMeta },
  { name: "terms", path: "/terms", file: "src/app/terms/page.tsx", el: () => <TermsPage />, meta: termsMeta },
];
/** visible text outside the marked (not final) items */
const unmarkedText = (root: HTMLElement) => {
  const copy = root.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("mark[data-pending]").forEach((m) => m.remove());
  return copy.textContent ?? "";
};

describe("M5 legal pages: public, structured, honest about what is not final", () => {
  for (const p of PAGES) {
    it(`${p.name}: one page title, sections with headings, contact address, links to the other legal pages`, () => {
      const { container } = render(p.el());
      expect(container.querySelectorAll("h1")).toHaveLength(1);
      expect(container.querySelectorAll("main")).toHaveLength(1);
      expect(container.querySelectorAll("section[aria-labelledby] > h2").length).toBeGreaterThanOrEqual(6);
      expect(container.textContent).toContain(CONTACT_EMAIL);
      const nav = within(container.querySelector('nav[aria-label="Legal"]') as HTMLElement);
      for (const l of LEGAL_LINKS.filter((x) => x.href !== p.path)) expect(nav.getByRole("link", { name: l.label }).getAttribute("href")).toBe(l.href);
      expect(nav.queryByRole("link", { name: LEGAL_LINKS.find((x) => x.href === p.path)!.label })).toBeNull();
    });

    it(`${p.name}: works without signing in — reads no session, cookie or database`, () => {
      for (const f of [p.file, "src/components/legal.tsx", "src/lib/legal.ts"]) {
        const src = readFileSync(f, "utf8");
        expect(src).not.toMatch(/supabase|getUser|cookies\(|headers\(|redirect\(|"use client"|useEffect|fetch\(/);
      }
    });

    it(`${p.name}: while draft, says so at the top, marks what is not final, and asks not to be indexed`, () => {
      const { container } = render(p.el());
      const marks = container.querySelectorAll("mark[data-pending]");
      if (LEGAL_STATUS === "draft") {
        expect(container.querySelector('aside[aria-label="Draft notice"]')?.textContent).toMatch(/Draft for review — not yet in force/);
        expect(marks.length).toBeGreaterThan(0);
        for (const m of marks) expect(["decision", "legal", "proposed"]).toContain(m.getAttribute("data-pending"));
        expect(p.meta.robots).toEqual({ index: false, follow: false });
      } else {
        // publishing: nothing may be left marked, and the date must be set
        expect(marks.length).toBe(0);
        expect(LEGAL_UPDATED).toMatch(/\d{4}/);
        expect(p.meta.robots).toBeUndefined();
      }
    });

    it(`${p.name}: no time limit outside a marked item unless the code implements it (no invented commitments)`, () => {
      const { container } = render(p.el());
      const periods = unmarkedText(container).match(/\b\d+\s*(?:hours?|days?|weeks?|months?|years?)\b/gi) ?? [];
      // 180 days: report text and moderation notes (0082, enforce_report_retention). Nothing else is implemented.
      for (const x of periods) expect(["180 days"]).toContain(x);
    });

    it(`${p.name}: no accessibility violations (axe-core)`, async () => {
      render(p.el());
      const axe = (await import("axe-core")).default;
      const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }

  it("the operator, address and governing law are never filled in by guessing: they stay marked", () => {
    const { container: privacy } = render(<PrivacyPage />);
    const { container: terms } = render(<TermsPage />);
    if (LEGAL_STATUS === "draft") {
      expect(privacy.querySelector('mark[data-pending="decision"]')?.textContent).toMatch(/operator/);
      expect(terms.textContent).toMatch(/\[jurisdiction\]/);
    }
  });

  it("terms: the community rules are exactly the ones players accept before chatting", () => {
    const { container } = render(<TermsPage />);
    const items = [...container.querySelectorAll("#games ~ ol li, section[aria-labelledby=games] ol li")].map((li) => li.textContent);
    expect(items).toEqual(COMMUNITY_RULES);
  });

  it("the deletion page: its provisional processing time and retention wording are marked, nothing else is promised", () => {
    const { container } = render(<DeleteAccountInfo />);
    const marked = [...container.querySelectorAll("mark[data-pending]")].map((m) => m.textContent);
    if (LEGAL_STATUS === "draft") {
      expect(marked.some((t) => /within 30 days/.test(t ?? ""))).toBe(true);
      expect(marked.some((t) => /the period the law requires/.test(t ?? ""))).toBe(true);
    }
    expect(unmarkedText(container).match(/\b\d+\s*(?:hours?|days?|weeks?|months?|years?)\b/gi) ?? []).toEqual([]);
  });

  it("the deletion page shares the contact address and links to the privacy policy and terms", () => {
    const { container } = render(<DeleteAccountInfo />);
    expect(container.textContent).toContain(CONTACT_EMAIL);
    const nav = within(container.querySelector('nav[aria-label="Legal"]') as HTMLElement);
    expect(nav.getByRole("link", { name: "Privacy policy" }).getAttribute("href")).toBe("/privacy");
    expect(nav.getByRole("link", { name: "Terms of use" }).getAttribute("href")).toBe("/terms");
  });

  it("sign-in, profile and the 18+ question link to the legal pages", () => {
    for (const f of ["src/app/login/LoginForm.tsx", "src/app/profile/ProfileForm.tsx", "src/app/age/AgeForm.tsx"]) {
      expect(readFileSync(f, "utf8")).toMatch(/<LegalLinks\b/);
    }
  });
});

describe("M5 privacy policy: what it says is absent stays absent in the code", () => {
  const web = JSON.parse(readFileSync("package.json", "utf8"));
  const app = JSON.parse(readFileSync("mobile/package.json", "utf8"));
  const appJson = JSON.parse(readFileSync("mobile/app.json", "utf8")).expo;
  const deps = [...Object.keys(web.dependencies ?? {}), ...Object.keys(app.dependencies ?? {})];

  it("“We do not use your location”: no location library in the app, no location request on the website", () => {
    expect(deps.filter((d) => /location|geoloc/i.test(d))).toEqual([]);
    for (const f of ["src/components/Discover.tsx", "src/components/HomeClient.tsx", "src/app/courts/page.tsx"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/geolocation/);
    }
  });

  it("“The app does not ask for … contacts, photos, camera or microphone”: no such library and no such permission", () => {
    expect(deps.filter((d) => /contacts|image-picker|media-library|camera|audio|av$|expo-av|microphone/i.test(d))).toEqual([]);
    expect(appJson.android?.permissions ?? []).toEqual([]);
    expect(Object.keys(appJson.ios?.infoPlist ?? {}).filter((k) => /UsageDescription$/.test(k))).toEqual([]);
  });

  it("“no advertising or analytics trackers”: none among the website's or the app's libraries", () => {
    expect(deps.filter((d) => /analytics|admob|ads-|facebook|firebase|amplitude|mixpanel|segment|posthog|appsflyer|adjust|branch|tracking-transparency/i.test(d))).toEqual([]);
  });
});
