"use client";

import { useEffect, useRef, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { COMMUNITY_RULES, friendlyError } from "@/lib/types";

type Msg = { id: string; profile_id: string; name: string | null; body: string; created_at: string; deleted?: boolean; /** M3-S: the reader blocked the sender (text withheld) */ blocked?: boolean };

// what the thread looks like right now, so we only re-render when it really changed
const signature = (rows: Msg[]) => rows.map((r) => `${r.id}:${r.deleted ? 1 : 0}${r.blocked ? 1 : 0}`).join(",");

export default function MatchChat({ matchId, meId, tz, initial, finished, hidden }: { matchId: string; meId: string; tz: string; initial: Msg[]; finished: boolean; hidden: boolean }) {
  const [gone, setGone] = useState(hidden);
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState(false);   // M3-S: shown when the server asks for the rules first
  const bottom = useRef<HTMLDivElement>(null);

  // poll the whole thread every 5 s, not just what is newer: a message deleted further up
  // would never come back through an incremental read (boring and reliable; realtime can replace it later)
  useEffect(() => {
    let alive = true;
    const id = setInterval(async () => {
      const { data, error } = await createClient().rpc("match_messages_list", { p_match: matchId, p_after: null });
      if (!alive || error || !data) return;
      const rows = data as Msg[];
      setMsgs((cur) => (signature(cur) === signature(rows) ? cur : rows));
    }, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [matchId]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [msgs.length]);

  async function removeMessage(id: string) {
    setMsgs((cur) => cur.map((m) => (m.id === id ? { ...m, body: "", deleted: true } : m)));
    const { error } = await createClient().rpc("delete_match_message", { p_id: id });
    if (error) setMsgs(initial);
  }
  async function removeConversation() {
    const { error } = await createClient().rpc("hide_match", { p_match: matchId, p_hidden: true });
    if (!error) { setGone(true); setMsgs([]); }
  }

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    setBusy(true); setError(null);
    const supabase = createClient();
    const { data, error } = await supabase.from("match_messages").insert({ match_id: matchId, profile_id: meId, body }).select("id, profile_id, body, created_at").single();
    setBusy(false);
    if (error) {
      // the text stays in the box; the rules are asked for once, then the same message is sent
      if (error.message?.includes("rules_not_accepted")) setRules(true);
      else setError(friendlyError(error.message));
      return;
    }
    if (data) { setMsgs((cur) => [...cur, { ...data, name: "You" }]); setText(""); fetch("/api/notify/email", { method: "POST" }).catch(() => {}); }
  }
  async function acceptRules() {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc("accept_community_rules");
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return; }
    setRules(false);
    await send();
  }

  if (gone) return (
    <section className="card p-4 text-center text-sm text-muted">
      You removed this conversation. <button onClick={async () => { await createClient().rpc("hide_match", { p_match: matchId, p_hidden: false }); location.reload(); }} className="font-semibold text-turf">Undo</button>
    </section>
  );

  return (
    <section className="card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-medium">Chat</h2>
        {finished && <button onClick={removeConversation} className="text-sm text-cedar">Delete conversation</button>}
      </div>
      <div className="flex max-h-72 flex-col gap-2 overflow-y-auto text-sm">
        {msgs.length === 0 && <p className="text-muted">No messages yet. Agree on balls, who brings what, where to meet.</p>}
        {msgs.map((x) => (
          <div key={x.id} className={`group max-w-[85%] rounded-2xl px-3 py-2 ${x.deleted ? "self-start border border-dashed border-grid bg-white text-muted" : x.profile_id === meId ? "self-end bg-turf text-white" : "self-start bg-paper"}`}>
            {x.profile_id !== meId && !x.deleted && !x.blocked && <div className="text-xs font-medium opacity-70">{x.name ?? "Player"}</div>}
            {x.deleted ? <div className="text-xs italic">Message deleted</div> : x.blocked ? <div className="text-xs italic text-muted">Message from a player you blocked</div> : <div>{x.body}</div>}
            {!x.deleted && x.profile_id === meId && <button onClick={() => removeMessage(x.id)} className="mt-0.5 text-[10px] text-white/80 underline">Delete</button>}
            <div className={`mt-0.5 text-[10px] ${x.profile_id === meId ? "text-white/70" : "text-muted"}`}>{formatInTimeZone(new Date(x.created_at), tz, "EEE HH:mm")}</div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {rules && (
        <div className="mt-3 rounded-xl border border-grid bg-paper p-3 text-sm" role="dialog" aria-label="Community rules">
          <p className="mb-2 font-medium">Before your first message</p>
          <ol className="mb-3 list-decimal space-y-1 pl-5">{COMMUNITY_RULES.map((r) => <li key={r}>{r}</li>)}</ol>
          <div className="flex gap-2">
            <button disabled={busy} onClick={acceptRules} className="rounded-xl bg-action px-4 py-2 font-medium text-white disabled:opacity-50">I agree</button>
            <button disabled={busy} onClick={() => setRules(false)} className="rounded-xl border border-grid bg-white px-4 py-2">Not now</button>
          </div>
        </div>
      )}
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      <form onSubmit={send} className="mt-3 flex gap-2">
        <input className="flex-1 rounded-xl border border-grid px-3 py-2.5 text-base outline-none focus:border-action" placeholder="Message" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
        <button disabled={busy || !text.trim()} className="rounded-xl bg-action px-4 font-medium text-white disabled:opacity-50">Send</button>
      </form>
    </section>
  );
}
