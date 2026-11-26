// @vitest-environment jsdom
/**
 * Review of #73: the Courts sheet's Reserve reads the player's details before booking. While that read is out
 * (held open here), the booked court, start and length must be exactly what was tapped; a changed selection books
 * nothing; a second tap starts nothing. Same rules as the club page and the app (#70).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Res = { data: unknown; error: unknown };
const nav = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
let profileReads = 0;
let nextProfile: () => Promise<Res> = async () => ({ data: { name: "Rana", phone: "+96170123456" }, error: null });
let bookAnswer: () => Res = () => ({ data: [{ booking_id: "b1" }], error: null });
const booked: Record<string, unknown>[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "book_at_desk" || fn === "hold_slot") { booked.push({ fn, ...args }); return bookAnswer(); }
      return { data: 20, error: null };
    },
    from: (t: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) b[m] = () => b;
      b.single = async () => ({ data: { payment_mode: "at_desk" }, error: null });
      b.maybeSingle = async () => { if (t !== "profiles") return { data: null, error: null }; profileReads++; return nextProfile(); };
      return b;
    },
  }),
}));
import BookSheet from "./BookSheet";

const club = { id: "c1", name: "Test Club", slug: "test", slot_minutes: 30, min_minutes: 60, max_minutes: 120, service_fee_usd: 0, hold_minutes: 10, cancel_cutoff_hours: 6, timezone: "Asia/Beirut" };
const AT = "2026-12-01T08:00:00.000Z";
const COURTS = [{ id: "k1", name: "Court 1", free: 120 }, { id: "k2", name: "Court 2", free: 120 }];

function held() {
  let open!: (v: Res) => void;
  const p = new Promise<Res>((r) => { open = r; });
  nextProfile = () => p;
  return (v: Res = { data: { name: "Rana", phone: "+96170123456" }, error: null }) => act(async () => { open(v); await p; });
}
beforeEach(() => {
  profileReads = 0; booked.length = 0; nav.push.mockReset(); nav.refresh.mockReset();
  nextProfile = async () => ({ data: { name: "Rana", phone: "+96170123456" }, error: null });
  bookAnswer = () => ({ data: [{ booking_id: "b1" }], error: null });
});
afterEach(cleanup);

const show = () => render(<BookSheet club={club} date="2026-12-01" at={AT} courts={COURTS} initialCourtId="k1" initialMinutes={60} signedIn onClose={() => {}} />);
async function reserveButton() {
  const b = await screen.findByRole("button", { name: /Reserve — you pay at the club/ });
  await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false));
  return b;
}
/** Two taps handled before React renders again: both run the handler of the same render (busy still false). */
function twoTapsInOneFrame(button: HTMLElement) {
  const props = Object.entries(button).find(([k]) => k.startsWith("__reactProps"))?.[1] as { onClick: () => void } | undefined;
  if (!props) throw new Error("no React props on the button");
  act(() => { props.onClick(); props.onClick(); });
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe("Courts sheet Reserve while the details are read (review of #73)", () => {
  it("unchanged selection: exactly the tapped court, start and length are booked", async () => {
    show();
    const release = held();
    fireEvent.click(await reserveButton());
    await settle();
    expect(booked).toEqual([]);
    await release();
    await waitFor(() => expect(booked).toHaveLength(1));
    expect(booked[0]).toMatchObject({ fn: "book_at_desk", p_court: "k1", p_start: AT, p_end: "2026-12-01T09:00:00.000Z" });
  });

  it("the player picks another court while the details load: nothing is booked, the new court can be reserved", async () => {
    show();
    const release = held();
    fireEvent.click(await reserveButton());
    fireEvent.click(screen.getByRole("button", { name: "Court 2" }));
    await release();
    await settle();
    expect(booked).toEqual([]);
    expect(nav.push).not.toHaveBeenCalled();
    nextProfile = async () => ({ data: { name: "Rana", phone: "+96170123456" }, error: null });
    fireEvent.click(await reserveButton());
    await waitFor(() => expect(booked).toHaveLength(1));
    expect(booked[0]).toMatchObject({ p_court: "k2", p_start: AT });
  });

  it("the player changes the length while the details load: nothing is booked", async () => {
    show();
    const release = held();
    fireEvent.click(await reserveButton());
    fireEvent.click(screen.getByRole("button", { name: "1 h 30" }));
    await release();
    await settle();
    expect(booked).toEqual([]);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("a second tap while the details load starts nothing more: one read, one booking", async () => {
    show();
    const release = held();
    twoTapsInOneFrame(await reserveButton());
    await release();
    await waitFor(() => expect(booked).toHaveLength(1));
    await settle();
    expect(profileReads).toBe(1);
    expect(booked).toHaveLength(1);
  });

  it("a retry of the same selection reuses its token; another selection gets a new one", async () => {
    bookAnswer = () => ({ data: null, error: { message: "Failed to fetch" } });
    show();
    fireEvent.click(await reserveButton());
    await waitFor(() => expect(booked).toHaveLength(1));
    fireEvent.click(await reserveButton());
    await waitFor(() => expect(booked).toHaveLength(2));
    expect(booked[1].p_token).toBe(booked[0].p_token);
    fireEvent.click(screen.getByRole("button", { name: "Court 2" }));
    fireEvent.click(await reserveButton());
    await waitFor(() => expect(booked).toHaveLength(3));
    expect(booked[2].p_token).not.toBe(booked[0].p_token);
  });
});
