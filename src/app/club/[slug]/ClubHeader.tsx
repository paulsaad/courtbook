import Link from "next/link";

export type ClubHead = {
  name: string; slug: string; open_time: string; close_time: string; location_url: string | null;
  town: string | null; district: string | null; sports: string[]; priceMin: number | null; priceMax: number | null;
};

const TABS = [["", "Book"], ["/matches", "Matches"], ["/coaches", "Coaches"], ["/info", "Info"]] as const;

export default function ClubHeader({ club, tab }: { club: ClubHead; tab: "" | "/matches" | "/coaches" | "/info" }) {
  const price = club.priceMin == null ? null : club.priceMin === club.priceMax ? `$${club.priceMin.toFixed(0)}/h` : `$${club.priceMin.toFixed(0)}–${club.priceMax!.toFixed(0)}/h`;
  return (
    <header className="px-4 pt-3">
      <Link href="/" className="text-sm text-muted">‹ Clubs</Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{club.name}</h1>
      <p className="text-sm text-muted">
        {[club.town, club.district].filter(Boolean).join(" · ") || "Lebanon"} · {club.open_time.slice(0, 5)}–{club.close_time.slice(0, 5)}{price && <> · {price}</>}
        {club.location_url && <> · <a className="text-action underline" href={club.location_url} target="_blank" rel="noreferrer">Map</a></>}
      </p>
      <nav className="mt-3 flex rounded-full border border-grid bg-white p-0.5 text-sm">
        {TABS.map(([t, label]) => (
          <Link key={t} href={`/club/${club.slug}${t}`} className={`flex-1 rounded-full py-1.5 text-center ${tab === t ? "bg-ink text-white" : ""}`}>{label}</Link>
        ))}
      </nav>
    </header>
  );
}
