// @vitest-environment jsdom
/** PR-9b: the cancellation notice offers a way to tell the club when it asks the player to. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: vi.fn() }) }));

import CancelButton from "./CancelButton";

const base = { bookingId: "b1", cutoffHours: 6, cutoffLabel: "Fri 28 Nov 12:00", clubInfoHref: "/club/test/info" };
afterEach(cleanup);

describe("cancellation notice: a way to tell the club (PR-9b)", () => {
  it("pay at the club, inside the cutoff, a callable club phone: Call club dials it", () => {
    render(<CancelButton {...base} freeCancel={false} nothingPaid clubPhone="+9616123456" />);
    expect(screen.getByText(/please tell the club\.$/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Call club" }).getAttribute("href")).toBe("tel:+9616123456");
    expect(screen.queryByRole("link", { name: "Club info" })).toBeNull();
  });
  it("no callable phone: a link to the club's Info page", () => {
    render(<CancelButton {...base} freeCancel={false} nothingPaid clubPhone={null} />);
    expect(screen.getByRole("link", { name: "Club info" }).getAttribute("href")).toBe("/club/test/info");
    expect(screen.queryByRole("link", { name: "Call club" })).toBeNull();
  });
  it("still free to cancel: neither", () => {
    render(<CancelButton {...base} freeCancel nothingPaid clubPhone="+9616123456" />);
    expect(screen.queryByRole("link", { name: /Call club|Club info/ })).toBeNull();
  });
  it("paid in the app, inside the cutoff (the notice does not ask to tell the club): neither", () => {
    render(<CancelButton {...base} freeCancel={false} clubPhone="+9616123456" />);
    expect(screen.queryByText(/please tell the club/)).toBeNull();
    expect(screen.queryByRole("link", { name: /Call club|Club info/ })).toBeNull();
  });
});
