"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Governorate } from "@/lib/geo";
import { areaKey, areaName, MAX_AREAS, sameArea, type PlayingArea, type PlayingPrefs } from "@/lib/places";

/**
 * Saved playing areas (0088) on the website:
 *  - SavedAreaChips: one tap between the places the player usually plays ("Beirut", "Batroun"), next to the area picker;
 *  - AreasQuestion: the optional first-use question, asked once per account ("Not now" also counts);
 *  - PlayingAreasEditor: add, refine to a district or town, remove — on the profile page.
 */
export function SavedAreaChips({ prefs, govs, current, onPick }: { prefs: PlayingPrefs | null; govs: Governorate[]; current: PlayingArea | null; onPick: (a: PlayingArea | null) => void }) {
  if (!prefs || prefs.areas.length === 0) return null;
  const chip = (on: boolean) => `chip shrink-0 ${on ? "chip-on" : ""}`;
  return (
    <div className="flex gap-2 overflow-x-auto px-5 pb-1" role="group" aria-label="Your areas">
      <button type="button" onClick={() => onPick(null)} className={chip(current === null)}>All Lebanon</button>
      {prefs.areas.map((a) => (
        <button key={areaKey(a)} type="button" onClick={() => onPick(a)} className={chip(sameArea(a, current))} aria-pressed={sameArea(a, current)}>{areaName(a, govs)}</button>
      ))}
      <Link href="/profile#areas" className="chip shrink-0 text-turf">Edit</Link>
    </div>
  );
}

export function AreasQuestion({ govs, onSave, onDismiss }: { govs: Governorate[]; onSave: (areas: PlayingArea[]) => Promise<unknown>; onDismiss: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (code: string) => setPicked((p) => (p.includes(code) ? p.filter((c) => c !== code) : [...p, code]));
  return (
    <section className="card flex flex-col gap-3 p-4" aria-labelledby="areas-question">
      <h2 id="areas-question" className="text-lg font-bold">Where do you usually play?</h2>
      <p className="text-sm text-muted">Pick one or more. We&apos;ll keep them on your account, so they&apos;re ready on any device. You can add towns later.</p>
      <div className="flex flex-wrap gap-2">
        {govs.map((g) => <button key={g.code} type="button" aria-pressed={picked.includes(g.code)} onClick={() => toggle(g.code)} className={`chip ${picked.includes(g.code) ? "chip-on" : ""}`}>{g.name_en}</button>)}
      </div>
      {error && <p role="alert" className="text-sm text-cedar">{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || picked.length === 0} className="btn btn-primary flex-1"
          onClick={async () => {
            setBusy(true); setError(null);
            try { await onSave(picked.map((g) => ({ governorate: g, district: null, town: null }))); }
            catch { setError("Couldn't save your areas. Try again."); setBusy(false); }
          }}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" disabled={busy} onClick={onDismiss} className="btn btn-secondary">Not now</button>
      </div>
    </section>
  );
}

type TownRow = { id: string; name_en: string };

export function PlayingAreasEditor({ govs, prefs, onSave }: { govs: Governorate[]; prefs: PlayingPrefs; onSave: (areas: PlayingArea[]) => Promise<unknown> }) {
  const [gov, setGov] = useState("");
  const [district, setDistrict] = useState("");
  const [town, setTown] = useState("");
  const [towns, setTowns] = useState<TownRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const g = govs.find((x) => x.code === gov);
  useEffect(() => {
    let alive = true;
    if (!district) { Promise.resolve().then(() => alive && setTowns([])); return () => { alive = false; }; }
    createClient().from("towns").select("id, name_en").eq("district_code", district).order("name_en").then(({ data }) => { if (alive) setTowns((data ?? []) as TownRow[]); });
    return () => { alive = false; };
  }, [district]);

  const save = async (areas: PlayingArea[]) => {
    setBusy(true); setError(null);
    try { await onSave(areas); setGov(""); setDistrict(""); setTown(""); }
    catch (e) { setError((e as Error).message === "too_many_areas" ? `You can keep up to ${MAX_AREAS} areas.` : "Couldn't save your areas. Try again."); }
    setBusy(false);
  };
  const adding: PlayingArea | null = gov ? { governorate: gov, district: district || null, town: district && town ? town : null,
    label: towns.find((t) => t.id === town)?.name_en ?? g?.districts.find((d) => d.code === district)?.name_en ?? g?.name_en } : null;
  const dup = adding && prefs.areas.some((a) => sameArea(a, adding));
  const select = "w-full rounded-xl border border-grid bg-white px-3 py-3 text-base";

  return (
    <section id="areas" className="card flex flex-col gap-3 p-4" aria-labelledby="areas-title">
      <div id="areas-title" className="eyebrow">Where I play</div>
      <p className="text-sm text-muted">Your areas appear as one-tap choices on Home and Courts, on every device.</p>
      {prefs.areas.length > 0 ? (
        <ul className="flex flex-col divide-y divide-grid rounded-xl border border-grid bg-white">
          {prefs.areas.map((a) => (
            <li key={areaKey(a)} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="text-[15px]">{areaName(a, govs)}{a.within ? <span className="text-muted"> · {a.within}</span> : null}</span>
              <button type="button" disabled={busy} onClick={() => save(prefs.areas.filter((x) => !sameArea(x, a)))} className="min-h-11 px-2 text-sm font-semibold text-cedar" aria-label={`Remove ${areaName(a, govs)}`}>Remove</button>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm">No areas yet.</p>}
      {prefs.areas.length < MAX_AREAS && (
        <div className="flex flex-col gap-2">
          <label className="text-sm">Area
            <select className={select} value={gov} onChange={(e) => { setGov(e.target.value); setDistrict(""); setTown(""); }}>
              <option value="">Choose…</option>
              {govs.map((x) => <option key={x.code} value={x.code}>{x.name_en}</option>)}
            </select>
          </label>
          {g && (
            <label className="text-sm">District (optional)
              <select className={select} value={district} onChange={(e) => { setDistrict(e.target.value); setTown(""); }}>
                <option value="">All of {g.name_en}</option>
                {g.districts.map((d) => <option key={d.code} value={d.code}>{d.name_en}</option>)}
              </select>
            </label>
          )}
          {district && towns.length > 0 && (
            <label className="text-sm">Town (optional)
              <select className={select} value={town} onChange={(e) => setTown(e.target.value)}>
                <option value="">The whole district</option>
                {towns.map((t) => <option key={t.id} value={t.id}>{t.name_en}</option>)}
              </select>
            </label>
          )}
          <button type="button" disabled={!adding || !!dup || busy} onClick={() => adding && save([...prefs.areas, adding])} className="btn btn-secondary">
            {dup ? "Already in your areas" : busy ? "Saving…" : "Add this area"}
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-cedar">{error}</p>}
    </section>
  );
}
