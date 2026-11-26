// @vitest-environment jsdom
/**
 * Local pilot build, 26 Nov: in "Post a match", typing 45 players and pressing Enter posted the game with
 * the previous number (3) while the field still showed 45. An empty or too-small number did the same.
 * The number shown is now always the number sent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import PlayersNeeded from "./PlayersNeeded";

afterEach(cleanup);
function Form({ start = 3, min, onSubmit }: { start?: number; min?: number; onSubmit: (n: number) => void }) {
  const [n, setN] = useState(start);
  return <form onSubmit={(e) => { e.preventDefault(); onSubmit(n); }}><PlayersNeeded value={n} onChange={setN} min={min} /></form>;
}
const field = () => screen.getByLabelText("Players wanted") as HTMLInputElement;

describe("players wanted: the number shown is the number sent", () => {
  it("more than 30 becomes 30 at once", () => {
    const sent = vi.fn();
    render(<Form onSubmit={sent} />);
    fireEvent.change(field(), { target: { value: "45" } });
    expect(field().value).toBe("30");
    fireEvent.submit(field().form!);
    expect(sent).toHaveBeenCalledWith(30);
  });

  it("Enter on an empty field does not send; the field shows the number kept", () => {
    const sent = vi.fn();
    render(<Form onSubmit={sent} />);
    fireEvent.change(field(), { target: { value: "" } });
    const allowed = fireEvent.keyDown(field(), { key: "Enter" });
    expect(allowed).toBe(false);          // default (submit) prevented
    expect(field().value).toBe("3");
    expect(sent).not.toHaveBeenCalled();
  });

  it("Enter below the minimum (players already joined) snaps up first", () => {
    render(<Form start={4} min={3} onSubmit={vi.fn()} />);
    fireEvent.change(field(), { target: { value: "1" } });
    expect(fireEvent.keyDown(field(), { key: "Enter" })).toBe(false);
    expect(field().value).toBe("3");
  });

  it("a valid number typed and Enter is sent as typed", () => {
    const sent = vi.fn();
    render(<Form onSubmit={sent} />);
    fireEvent.change(field(), { target: { value: "12" } });
    expect(fireEvent.keyDown(field(), { key: "Enter" })).toBe(true);
    fireEvent.submit(field().form!);
    expect(sent).toHaveBeenCalledWith(12);
  });
});
