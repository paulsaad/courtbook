"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function NewClubForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const { error } = await createClient().from("clubs").insert({ name: name.trim(), slug: slug.trim().toLowerCase() });
    if (error) { setBusy(false); setError(error.message.includes("clubs_slug_key") ? "That URL name is taken." : error.message); return; }
    router.push(`/admin/clubs/${slug.trim().toLowerCase()}`);
  }

  if (!open) return <button onClick={() => setOpen(true)} className="rounded-xl border border-grid bg-white py-3.5">Add a club</button>;
  return (
    <form onSubmit={create} className="flex flex-col gap-3 rounded-2xl border border-grid bg-white p-4">
      <input className="rounded-xl border border-grid px-4 py-3" placeholder="Club name" required value={name}
        onChange={(e) => { setName(e.target.value); if (!slug) setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")); }} />
      <input className="rounded-xl border border-grid px-4 py-3" placeholder="url-name (letters, numbers, dashes)" required pattern="[a-z0-9-]+" value={slug} onChange={(e) => setSlug(e.target.value)} />
      <p className="text-xs text-muted">Players open courtbook…/club/<b>{slug || "url-name"}</b>. Hours, courts and prices come next.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button disabled={busy} className="rounded-xl bg-action py-3 font-medium text-white disabled:opacity-50">{busy ? "Creating…" : "Create club"}</button>
    </form>
  );
}
