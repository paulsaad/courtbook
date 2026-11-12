"use client";

import { useState } from "react";

export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 30;

/** How many more players an organiser is looking for: minus, an editable number, plus.
 *  Three fixed buttons could not express a football side; this runs 1–30.
 *  `min` is raised to the number already accepted, so editing can never drop below them. */
export default function PlayersNeeded({ value, onChange, min = MIN_PLAYERS, accepted }: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  accepted?: number;
}) {
  const lo = Math.max(MIN_PLAYERS, min);
  const [text, setText] = useState(String(value));
  const clamp = (n: number) => Math.min(MAX_PLAYERS, Math.max(lo, n));

  const set = (n: number) => { const c = clamp(n); setText(String(c)); onChange(c); };
  const step = (d: number) => set(value + d);

  return (
    <div className="text-sm">
      <label htmlFor="players-needed">How many more players are you looking for?</label>
      <div className="mt-1 flex items-center gap-2">
        <button type="button" aria-label="One fewer player" disabled={value <= lo} onClick={() => step(-1)}
                className="h-11 w-11 shrink-0 rounded-xl border border-grid text-xl leading-none disabled:opacity-40">−</button>
        <input
          id="players-needed" inputMode="numeric" pattern="[0-9]*" aria-label="Players wanted"
          className="h-11 w-16 rounded-xl border border-grid text-center text-base outline-none focus:border-action"
          value={text}
          onChange={(e) => {
            const digits = e.target.value.replace(/[^0-9]/g, "").slice(0, 2);
            setText(digits);                                     // let the field be empty while typing
            const n = Number(digits);
            if (digits !== "" && n >= lo && n <= MAX_PLAYERS) onChange(n);
          }}
          onBlur={() => set(Number(text) || value)}              // snap back to something valid on the way out
        />
        <button type="button" aria-label="One more player" disabled={value >= MAX_PLAYERS} onClick={() => step(1)}
                className="h-11 w-11 shrink-0 rounded-xl border border-grid text-xl leading-none disabled:opacity-40">+</button>
      </div>
      <p className="mt-1 text-xs text-muted">
        Not counting you, or anyone you have already arranged outside the app. Up to {MAX_PLAYERS}.
        {accepted ? ` ${accepted} ${accepted === 1 ? "player has" : "players have"} joined, so this cannot go below ${accepted}.` : ""}
      </p>
    </div>
  );
}
