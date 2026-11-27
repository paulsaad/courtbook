"use client";
import { useState } from "react";
import { initialsOf } from "@/lib/playerPhoto/shared";

/**
 * A player's small round picture: their photo when there is one they may see, otherwise their initials. A photo that
 * fails to load (removed, blocked, account closed since the page was drawn) falls back to the initials.
 */
export default function Avatar({ name, src, size = 32, className = "" }: { name: string | null; src: string | null; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };
  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" width={size} height={size} style={box} onError={() => setFailed(true)}
        className={`shrink-0 rounded-full bg-grid object-cover ${className}`} />
    );
  }
  return (
    <span aria-hidden="true" style={{ ...box, fontSize: Math.round(size * 0.38) }}
      className={`flex shrink-0 items-center justify-center rounded-full bg-turf font-bold text-white ${className}`}>
      {initialsOf(name)}
    </span>
  );
}
