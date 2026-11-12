"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mediaUrl, type ClubMedia } from "@/lib/media";

/** Staff manage a club's cover, logo and up to six venue photos.
 *  Every upload goes to /api/club-media, which re-encodes before storing: nothing here is trusted. */
export default function ClubPhotos({ clubId, initial }: { clubId: string; initial: ClubMedia[] }) {
  const [media, setMedia] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const cover = media.find((m) => m.kind === "cover") ?? null;
  const logo = media.find((m) => m.kind === "logo") ?? null;
  const gallery = media.filter((m) => m.kind === "gallery").sort((a, b) => a.sort - b.sort);

  async function refresh() {
    const { data } = await createClient().from("club_media")
      .select("id, kind, path, external_url, caption, sort, width, height")
      .eq("club_id", clubId).order("sort");
    setMedia((data ?? []) as ClubMedia[]);
  }

  async function upload(kind: "cover" | "logo" | "gallery", file: File, expect: string | null) {
    setBusy(kind); setError(null); setNote(null);
    const body = new FormData();
    body.set("clubId", clubId); body.set("kind", kind); body.set("file", file);
    if (expect) body.set("expect", expect);
    const res = await fetch("/api/club-media", { method: "POST", body });
    const out = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError(out.error ?? "Could not upload that image."); return; }
    await refresh();
    setNote(kind === "gallery" ? "Photo added." : `New ${kind} saved.`);
  }

  async function remove(m: ClubMedia) {
    setBusy(m.id); setError(null); setNote(null);
    const res = await fetch("/api/club-media", {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaId: m.id, clubId }),
    });
    const out = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError(out.error ?? "Could not remove that image."); return; }
    await refresh();
  }

  async function move(m: ClubMedia, by: number) {
    const ids = gallery.map((g) => g.id);
    const i = ids.indexOf(m.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setBusy(m.id); setError(null);
    const { error } = await createClient().rpc("reorder_club_gallery", { p_club: clubId, p_ids: ids });
    setBusy(null);
    if (error) { setError("Someone else changed these photos just now. Reload and try again."); await refresh(); return; }
    await refresh();
  }

  async function caption(m: ClubMedia, text: string) {
    const { error } = await createClient().rpc("set_gallery_caption", { p_id: m.id, p_caption: text });
    if (error) { setError("Could not save that caption."); return; }
    await refresh();
  }

  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Photos</h2>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      {note && <p className="rounded-lg bg-turf-soft px-3 py-2 text-sm text-turf">{note}</p>}
      <p className="text-xs text-muted">
        Photos are resized and re-saved when you upload them, which also removes the location and camera
        details a phone stores in a photo. Don&apos;t upload pictures of people who have not agreed to it.
      </p>

      <Slot label="Cover" hint="Wide photo across the top of your club page." aspect="aspect-[8/3]"
            item={cover} busy={busy === "cover"} clubId={clubId}
            onPick={(f) => upload("cover", f, cover?.id ?? null)} onRemove={() => cover && remove(cover)} />

      <Slot label="Logo" hint="Square. Optional." aspect="aspect-square w-28"
            item={logo} busy={busy === "logo"} clubId={clubId}
            onPick={(f) => upload("logo", f, logo?.id ?? null)} onRemove={() => logo && remove(logo)} />

      <div>
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">Venue photos</h3>
          <span className="text-xs text-muted">{gallery.length} of 6</span>
        </div>
        <ul className="mt-2 flex flex-col gap-2">
          {gallery.map((m, i) => (
            <li key={m.id} className="flex items-center gap-2 rounded-xl border border-grid p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={mediaUrl(m)} alt={m.caption ?? "Venue photo"} width={m.width ?? 120} height={m.height ?? 90}
                   className="h-16 w-20 shrink-0 rounded-lg object-cover" />
              <input
                className="min-w-0 flex-1 rounded-lg border border-grid bg-paper px-2 py-1.5 text-sm"
                defaultValue={m.caption ?? ""} maxLength={80} placeholder="Caption (optional)"
                onBlur={(e) => e.target.value !== (m.caption ?? "") && caption(m, e.target.value)} />
              <div className="flex shrink-0 flex-col">
                <button disabled={i === 0 || busy === m.id} onClick={() => move(m, -1)} aria-label="Move up" className="px-2 text-sm disabled:opacity-30">▲</button>
                <button disabled={i === gallery.length - 1 || busy === m.id} onClick={() => move(m, 1)} aria-label="Move down" className="px-2 text-sm disabled:opacity-30">▼</button>
              </div>
              <button disabled={busy === m.id} onClick={() => remove(m)} className="shrink-0 px-2 text-sm text-danger">Remove</button>
            </li>
          ))}
          {gallery.length === 0 && <li className="rounded-xl border border-dashed border-grid px-3 py-6 text-center text-sm text-muted">No venue photos yet.</li>}
        </ul>
        {gallery.length < 6 && (
          <PickButton label={busy === "gallery" ? "Uploading…" : "Add a photo"} disabled={busy === "gallery"}
                      onPick={(f) => upload("gallery", f, null)} />
        )}
      </div>
    </section>
  );
}

function Slot({ label, hint, aspect, item, busy, onPick, onRemove }: {
  label: string; hint: string; aspect: string; item: ClubMedia | null; busy: boolean; clubId: string;
  onPick: (f: File) => void; onRemove: () => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">{label}</h3>
        <span className="text-xs text-muted">{hint}</span>
      </div>
      {item ? (
        <div className="mt-2 flex items-start gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mediaUrl(item)} alt={`${label} image`} width={item.width ?? 320} height={item.height ?? 120}
               className={`${aspect} flex-1 rounded-xl border border-grid object-cover`} />
          <button disabled={busy} onClick={onRemove} className="shrink-0 px-2 py-1 text-sm text-danger">Remove</button>
        </div>
      ) : (
        <div className={`${aspect} mt-2 grid place-items-center rounded-xl border border-dashed border-grid text-sm text-muted`}>None yet</div>
      )}
      <PickButton label={busy ? "Uploading…" : item ? `Replace ${label.toLowerCase()}` : `Add a ${label.toLowerCase()}`}
                  disabled={busy} onPick={onPick} />
    </div>
  );
}

function PickButton({ label, disabled, onPick }: { label: string; disabled: boolean; onPick: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
             onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }} />
      <button disabled={disabled} onClick={() => ref.current?.click()}
              className="mt-2 w-full rounded-xl border border-grid py-2.5 text-sm disabled:opacity-50">{label}</button>
    </>
  );
}
