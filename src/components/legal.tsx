import Link from "next/link";
import { CONTACT_EMAIL, LEGAL_LINKS, LEGAL_STATUS, LEGAL_UPDATED } from "@/lib/legal";

/**
 * M5 legal pages: frame, marked unfinished wording, and the links shown on other pages.
 * Server components only: the pages read nothing about the visitor and work without signing in.
 */

export type PendingKind = "decision" | "legal" | "proposed";
const PENDING_LABEL: Record<PendingKind, string> = {
  decision: "Decision needed",
  legal: "Legal review",
  proposed: "Proposed wording",
};

/** A sentence or value that is not final: shown highlighted with what it is waiting for. */
export function Pending({ kind, children }: { kind: PendingKind; children: React.ReactNode }) {
  return (
    <mark data-pending={kind} className="rounded bg-amber-100 px-1 text-ink">
      <span className="mr-1 text-xs font-bold uppercase tracking-wide text-amber-800">[{PENDING_LABEL[kind]}]</span>
      {children}
    </mark>
  );
}

export function LegalPage({ path, title, intro, children }: { path: string; title: string; intro: React.ReactNode; children: React.ReactNode }) {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5 pt-12 md:max-w-2xl lg:max-w-[720px]">
      <Link href="/" className="text-sm text-muted">‹ CourtBook</Link>
      <h1 className="text-[28px] font-extrabold tracking-tight">{title}</h1>
      {LEGAL_STATUS === "draft" ? (
        <aside role="note" aria-label="Draft notice" className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-bold">Draft for review — not yet in force.</p>
          <p className="mt-1">
            This page describes what CourtBook does today. Highlighted items are not final: they wait for a decision, a legal
            review, or approval of proposed wording.
          </p>
        </aside>
      ) : (
        <p className="text-sm text-muted">Last updated: {LEGAL_UPDATED}</p>
      )}
      <div className="text-[15px]">{intro}</div>
      <article className="legal flex flex-col gap-6 text-[15px] leading-relaxed">{children}</article>
      <p className="text-sm">
        Questions: <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-turf">{CONTACT_EMAIL}</a>
      </p>
      <LegalLinks current={path} />
    </main>
  );
}

/** One section with a heading the page's contents can point to. */
export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-lg font-bold">{title}</h2>
      {children}
    </section>
  );
}

/** The legal links, for page footers (sign-in, profile, deletion, 18+ question, the legal pages). */
export function LegalLinks({ current, className = "" }: { current?: string; className?: string }) {
  return (
    <nav aria-label="Legal" className={`flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted ${className}`}>
      {LEGAL_LINKS.filter((l) => l.href !== current).map((l) => (
        <Link key={l.href} href={l.href} className="underline underline-offset-2">{l.label}</Link>
      ))}
    </nav>
  );
}
