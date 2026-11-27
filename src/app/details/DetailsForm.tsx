"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { normalizePhone } from "@/lib/phone";
import { NAME_MAX, PHONE_HELP, PHONE_PRIVACY, checkDetails, detailsPatch, saveProblem, whyWeAsk, type Field } from "@/lib/playerDetails";

const input = "min-h-11 rounded-lg border border-grid bg-white px-3 py-2 text-base";

/** The details step before a first court booking: only the missing fields; Save goes back to the same selection. */
export default function DetailsForm({ userId, ask, next }: { userId: string; ask: Field[]; next: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const savedAs = phone.trim() ? normalizePhone(phone) : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setProblem(null);
    const found = checkDetails({ name, phone }, ask, true);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    // .select() makes "no row was changed" visible: an update the permissions filtered out returns nothing
    const { data, error } = await createClient().from("profiles").update(detailsPatch({ name, phone }, ask)).eq("id", userId).select("id");
    if (error || !data || data.length !== 1) { setBusy(false); setProblem(saveProblem(error ?? { message: "not_saved" })); return; }
    router.replace(next);
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-[720px] flex-col gap-5 p-5 pt-12">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Before you book</h1>
        <p className="mt-1 text-sm text-muted">{whyWeAsk(ask)}</p>
      </div>
      <form onSubmit={save} noValidate className="flex flex-col gap-4">
        {ask.includes("name") && (
          <label className="flex flex-col gap-1 text-sm">Name
            <input className={input} autoComplete="name" maxLength={NAME_MAX + 20} value={name} aria-invalid={!!errors.name}
              onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, name: undefined })); }} />
            {errors.name && <span role="alert" className="text-danger">{errors.name}</span>}
          </label>
        )}
        {ask.includes("phone") && (
          <label className="flex flex-col gap-1 text-sm">Contact phone
            <input className={input} inputMode="tel" autoComplete="tel" maxLength={24} placeholder="03 123 456 or +46 70 123 45 67" value={phone} aria-invalid={!!errors.phone}
              onChange={(e) => { setPhone(e.target.value); setErrors((x) => ({ ...x, phone: undefined })); }} />
            {errors.phone ? <span role="alert" className="text-danger">{errors.phone}</span>
              : savedAs && savedAs !== phone.trim() ? <span className="text-xs text-muted">Saved as {savedAs}</span> : null}
            <span className="text-xs text-muted">{PHONE_HELP}</span>
            <span className="text-xs text-muted">{PHONE_PRIVACY}</span>
          </label>
        )}
        {problem && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{problem}</p>}
        <button type="submit" disabled={busy} className="btn btn-primary">{busy ? "Saving…" : "Save and continue"}</button>
        <button type="button" onClick={() => router.replace(next)} className="btn btn-secondary">Not now</button>
      </form>
    </main>
  );
}
