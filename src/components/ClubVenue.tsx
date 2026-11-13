"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";

/**
 * What a player wants to know before deciding to come, and what to expect when they arrive.
 *
 * Every facility has three states, not two. `null` means the club has not answered, and that is the
 * state a new club starts in — a player must never be told there is no parking because nobody has
 * been asked yet. The form says "Not confirmed" for it and the club page leaves it out entirely.
 */

export type VenueRow = {
  id: string;
  description: string | null;
  arrival_notes: string | null;
  address: string | null;
  has_parking: boolean | null;
  has_changing_rooms: boolean | null;
  has_showers: boolean | null;
  has_equipment_rental: boolean | null;
  has_cafe: boolean | null;
  has_floodlights: boolean | null;
  has_drinking_water: boolean | null;
  facilities_confirmed_at: string | null;
};

export const FACILITIES = [
  ["has_parking", "Parking"],
  ["has_changing_rooms", "Changing rooms"],
  ["has_showers", "Showers"],
  ["has_equipment_rental", "Equipment rental"],
  ["has_cafe", "Café"],
  ["has_floodlights", "Floodlights"],
  ["has_drinking_water", "Drinking water"],
] as const;

type Key = (typeof FACILITIES)[number][0];

export default function ClubVenue({ club }: { club: VenueRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [description, setDescription] = useState(club.description ?? "");
  const [arrival, setArrival] = useState(club.arrival_notes ?? "");
  const [address, setAddress] = useState(club.address ?? "");
  const [facilities, setFacilities] = useState<Record<Key, boolean | null>>(
    Object.fromEntries(FACILITIES.map(([k]) => [k, club[k]])) as Record<Key, boolean | null>,
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setSaved(false);
    const { error } = await createClient().rpc("set_club_venue", {
      p_club: club.id,
      p_description: description, p_arrival: arrival, p_address: address,
      p_parking: facilities.has_parking, p_changing: facilities.has_changing_rooms,
      p_showers: facilities.has_showers, p_rental: facilities.has_equipment_rental,
      p_cafe: facilities.has_cafe, p_floodlights: facilities.has_floodlights,
      p_water: facilities.has_drinking_water,
    });
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return; }
    setSaved(true);
    router.refresh();
  }

  const field = "w-full rounded-lg border border-grid px-3 py-2 text-sm";

  return (
    <section className="rounded-2xl border border-grid bg-white p-4">
      <h2 className="font-medium">Venue information</h2>
      <p className="mt-1 text-xs text-muted">
        What players see on your club page before they book. Leave a facility on <em>Not confirmed</em>
        {" "}if you are not sure — it is left out rather than shown as a no.
      </p>

      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      {saved && !error && <p className="mt-3 rounded-lg bg-turf-soft px-3 py-2 text-sm text-turf">Saved.</p>}

      <form onSubmit={save} className="mt-3 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          About this club
          <textarea className={`${field} min-h-24`} maxLength={600} value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Two or three lines about the club — the courts, the atmosphere, who plays here." />
          <span className="text-right text-xs text-muted">{description.length}/600</span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Address
          <input className={field} maxLength={200} value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Street, building, town — what someone would read out to a driver." />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Finding the entrance
          <textarea className={`${field} min-h-16`} maxLength={300} value={arrival}
            onChange={(e) => setArrival(e.target.value)}
            placeholder="The gate is behind the bakery · Ring the bell · Parking is through the side entrance." />
          <span className="text-right text-xs text-muted">{arrival.length}/300</span>
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm">Facilities</legend>
          {/* Label and choices sit side by side where there is room and stack where there is not:
              "Equipment rental" beside "Yes / No / Not confirmed" does not fit on a 320px phone.
              The buttons are 44px tall and share the width evenly when stacked, so they stay
              thumb-sized rather than shrinking to fit. */}
          {FACILITIES.map(([key, label]) => (
            <div key={key} className="flex flex-col gap-2 border-t border-grid py-2 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-sm">{label}</span>
              <div className="flex overflow-hidden rounded-lg border border-grid sm:shrink-0">
                {([[true, "Yes"], [false, "No"], [null, "Not confirmed"]] as const).map(([value, text]) => (
                  <button key={text} type="button"
                    onClick={() => setFacilities((f) => ({ ...f, [key]: value }))}
                    aria-pressed={facilities[key] === value}
                    className={`min-h-11 flex-1 whitespace-nowrap px-3 text-xs sm:flex-none ${facilities[key] === value ? "bg-action text-white" : "bg-white text-muted"}`}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </fieldset>

        <div className="flex items-center gap-3">
          <button disabled={busy} className="rounded-lg bg-action px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "Saving…" : "Save venue information"}
          </button>
          {club.facilities_confirmed_at && (
            <span className="text-xs text-muted">
              Last answered {new Date(club.facilities_confirmed_at).toLocaleDateString()}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
