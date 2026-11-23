// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import DeleteAccountInfo from "./page";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
afterEach(cleanup);

describe("public account-deletion page (M2)", () => {
  it("does not promise a confirmation email (none is sent until the CourtBook sender exists)", () => {
    const { container } = render(<DeleteAccountInfo />);
    expect(container.textContent).not.toMatch(/email you|we will email|confirmation email/i);
  });
  it("no deletion screen promises an email either", () => {
    for (const f of ["src/app/profile/DeleteAccount.tsx", "mobile/components/DeleteAccount.tsx"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/email you/i);
    }
  });
  it("explains both ways to ask and what is kept", () => {
    const { container } = render(<DeleteAccountInfo />);
    expect(container.textContent).toMatch(/Delete my account/);
    expect(container.textContent).toMatch(/courtbook\.contact@gmail\.com/);
    expect(container.textContent).toMatch(/Kept without your name/);
  });
});
