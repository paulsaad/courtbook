"use client";

import type { Governorate } from "@/lib/geo";
import { usePlaying } from "@/lib/playing";
import { PlayingAreasEditor } from "@/components/SavedAreas";

/** Profile → "Where I play" (0088). Nothing is shown before 0088 exists or while it loads. */
export default function PlayingAreasSection({ govs }: { govs: Governorate[] }) {
  const playing = usePlaying(true);
  if (!playing.prefs) return null;
  return <PlayingAreasEditor govs={govs} prefs={playing.prefs} onSave={playing.saveAreas} />;
}
