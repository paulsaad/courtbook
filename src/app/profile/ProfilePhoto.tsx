"use client";
import { useRef, useState } from "react";
import { photoUrl } from "@/lib/playerPhoto/shared";
import { UPLOAD_MAX, shrinkForUpload } from "@/lib/playerPhoto/shrink";

/**
 * The profile header picture, with Add / Change / Remove. Same circle as before; a photo, when there is one, fills it.
 * Who sees the photo is said next to the controls, because it is not public.
 */
export default function ProfilePhoto({ userId, initials, version: initialVersion }: { userId: string; initials: string; version: number | null }) {
  const [version, setVersion] = useState(initialVersion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setError(null);
    setBusy(true);
    try {
      const small = await shrinkForUpload(file);
      if (small.size > UPLOAD_MAX) { setError("That photo is too large. Please pick a smaller one."); return; }
      const body = new FormData();
      body.append("file", small, "photo.jpg");
      const res = await fetch("/api/player-photo", { method: "POST", body });
      const json = await res.json().catch(() => ({}));
      if (res.status === 413) { setError("That photo is too large. Please pick a smaller one."); return; }
      if (!res.ok) { setError(json.error ?? "Your photo could not be saved. Please try again."); return; }
      setVersion(json.version);
    } catch {
      setError("No connection. Your photo was not changed.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/player-photo", { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? "Your photo could not be removed. Please try again."); return; }
      setVersion(null);
    } catch {
      setError("No connection. Your photo was not changed.");
    } finally {
      setBusy(false);
    }
  }

  const ring = "h-28 w-28 rounded-full border-4 border-white shadow-[0_0_0_1px_#e6e8e5]";
  return (
    <div className="flex flex-col items-center gap-2">
      {version != null ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl(userId, version)} alt="Your photo" width={112} height={112} className={`${ring} bg-grid object-cover`} />
      ) : (
        <span className={`${ring} flex items-center justify-center bg-turf text-[40px] font-extrabold text-white`} aria-hidden="true">{initials}</span>
      )}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => input.current?.click()} className="chip">
          {busy ? "Saving…" : version != null ? "Change photo" : "Add a photo"}
        </button>
        {version != null && <button type="button" disabled={busy} onClick={() => void remove()} className="chip text-cedar">Remove</button>}
      </div>
      <p className="text-center text-xs text-muted">Optional. Only you and the players in your games can see it.</p>
      {error && <p role="alert" className="text-center text-sm text-cedar">{error}</p>}
    </div>
  );
}
