export type AgendaRow = { kind: "booking" | "match"; id: string; start_at: string; end_at: string | null; club_name: string; club_slug: string; timezone: string; title: string | null; status: string; role: string | null };

export function agendaPill(r: AgendaRow): [string, string] {
  if (r.kind === "booking") return r.status === "confirmed" ? ["booked", "bg-turf-soft text-turf"] : r.status === "no_show" ? ["no-show", "bg-slate-soft text-muted"] : ["cancelled", "bg-slate-soft text-muted"];
  if (r.status === "cancelled") return ["cancelled", "bg-slate-soft text-muted"];
  if (r.role === "organizer") return ["your match", "bg-sand-soft text-ink"];
  if (r.role === "pending") return ["requested", "bg-sand-soft text-ink"];
  return ["you're in", "bg-turf-soft text-turf"];
}
