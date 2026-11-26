"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { COMMUNITY_RULES, COMMUNITY_RULES_TITLE } from "@/lib/types";
import { actionError } from "@/lib/actionError";
import { BLOCK_EXPLAINED, BLOCKED_PATH, blockPlayer, reportMessage } from "@/lib/gameSafety";
import SafetyConfirm from "@/components/SafetyConfirm";
import ReportSheet from "./ReportSheet";

type Msg = { id: string; profile_id: string; name: string | null; body: string; created_at: string; deleted?: boolean; /** M3-S: the reader blocked the sender (text withheld) */ blocked?: boolean };

// what the thread looks like right now, so we only re-render when it really changed
/** Report and block are offered only on another player's message that is still shown. */
const canReport = (m: Msg, meId: string) => m.profile_id !== meId && !m.deleted && !m.blocked;

const signature = (rows: Msg[]) => rows.map((r) => `${r.id}:${r.deleted ? 1 : 0}${r.blocked ? 1 : 0}`).join(",");

export default function MatchChat({ matchId, meId, tz, initial, finished, hidden }: { matchId: string; meId: string; tz: string; initial: Msg[]; finished: boolean; hidden: boolean }) {
  const [gone, setGone] = useState(hidden);
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState(false);   // M3-S: shown when the server asks for the rules first
  // H13: one id per message, made here and kept for its retries (as the app, mobile/lib/chat.ts). If the
  // first try reached the database and only the answer was lost, the retry hits the primary key: sent once.
  const outgoing = useRef<{ body: string; id: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  // report and block (M3-S, as the app's long-press menu): only on other players' visible messages
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [reporting, setReporting] = useState<Msg | null>(null);
  const [blocking, setBlocking] = useState<Msg | null>(null);
  const [blockedName, setBlockedName] = useState<string | null>(null);
  // a message's options only while it can still be reported: not after it is deleted, withheld or gone
  // a new copy of the thread (poll or reload) closes a menu whose message can no longer be reported
  const closeStaleMenu = (rows: Msg[]) => setMenuFor((open) => (open && rows.some((m) => m.id === open && canReport(m, meId)) ? open : null));

  // poll the whole thread every 5 s, not just what is newer: a message deleted further up
  // would never come back through an incremental read (boring and reliable; realtime can replace it later)
  useEffect(() => {
    let alive = true;
    const id = setInterval(async () => {
      const { data, error } = await createClient().rpc("match_messages_list", { p_match: matchId, p_after: null });
      if (!alive || error || !data) return;
      const rows = data as Msg[];
      setMsgs((cur) => (signature(cur) === signature(rows) ? cur : rows));
      setMenuFor((open) => (open && rows.some((m) => m.id === open && canReport(m, meId)) ? open : null));
    }, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [matchId, meId]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [msgs.length]);

  // the whole thread again, now: after a block the server withholds that player's messages
  async function reload() {
    const { data, error } = await createClient().rpc("match_messages_list", { p_match: matchId, p_after: null });
    if (!error && data) { setMsgs(data as Msg[]); closeStaleMenu(data as Msg[]); }
  }
  async function block(m: Msg): Promise<string | null> {
    const p = await blockPlayer((fn, args) => createClient().rpc(fn, args), m.profile_id);
    if (p) return p;
    setBlockedName(m.name ?? "this player");
    await reload();
    return null;
  }

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
    const retry = outgoing.current?.body === body;
    if (!retry) outgoing.current = { body, id: crypto.randomUUID() };
    const id = outgoing.current!.id;
    setBusy(true); setError(null);
    const supabase = createClient();
    const { data, error } = await supabase.from("match_messages").insert({ id, match_id: matchId, profile_id: meId, body }).select("id, profile_id, body, created_at").single();
    if (error && error.code !== "23505") {
      // the text stays in the box; the rules are asked for once, then the same message is sent
      if (error.message?.includes("rules_not_accepted")) { setBusy(false); setRules(true); return; }
      // on a retry, an earlier try may have arrived (its answer lost, then this one refused, e.g.
      // slow_down): if the thread already holds this id, the message was sent
      const thread = retry ? await supabase.rpc("match_messages_list", { p_match: matchId, p_after: null }) : null;
      const rows = (thread && !thread.error ? thread.data : null) as Msg[] | null;
      if (!rows?.some((m) => m.id === id)) { setBusy(false); setError(actionError(error.message)); return; }   // no connection: says so (H3)
      setMsgs(rows); closeStaleMenu(rows);
    } else if (data) setMsgs((cur) => (cur.some((m) => m.id === data.id) ? cur : [...cur, { ...data, name: "You" }]));
    else await reload();   // 23505: this id is already in the thread (sent by the earlier try)
    setBusy(false);
    outgoing.current = null; setText("");
    fetch("/api/notify/email", { method: "POST" }).catch(() => {});
  }
  async function acceptRules() {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc("accept_community_rules");
    setBusy(false);
    if (error) { setError(actionError(error.message)); return; }
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
            {x.profile_id !== meId && !x.deleted && !x.blocked && (
              <div className="flex items-start justify-between gap-2">
                <div className="text-xs font-medium opacity-70">{x.name ?? "Player"}</div>
                <button type="button" onClick={() => setMenuFor(menuFor === x.id ? null : x.id)} aria-expanded={menuFor === x.id}
                  aria-label={`Options for ${x.name ?? "this player"}'s message`} className="-my-2 -mr-2 flex h-9 w-10 shrink-0 items-center justify-center rounded-full text-base leading-none text-muted">⋯</button>
              </div>
            )}
            {x.deleted ? <div className="text-xs italic">Message deleted</div> : x.blocked ? <div className="text-xs italic text-muted"><span>Message from a player you blocked</span> · <Link href={BLOCKED_PATH} className="not-italic underline">Blocked players</Link></div> : <div>{x.body}</div>}
            {menuFor === x.id && canReport(x, meId) && (
              <div className="mt-1 flex flex-col items-start gap-1 border-t border-grid pt-1" role="group" aria-label="Message options">
                <button type="button" onClick={() => { setMenuFor(null); setReporting(x); }} className="min-h-9 text-sm font-medium text-ink">Report message</button>
                <button type="button" onClick={() => { setMenuFor(null); setBlocking(x); }} className="min-h-9 text-sm font-medium text-danger">Block {x.name ?? "this player"}</button>
              </div>
            )}
            {!x.deleted && x.profile_id === meId && <button onClick={() => removeMessage(x.id)} className="mt-0.5 text-[10px] text-white underline">Delete</button>}
            <div className={`mt-0.5 text-[10px] ${x.profile_id === meId ? "text-white" : "text-muted"}`}>{formatInTimeZone(new Date(x.created_at), tz, "EEE HH:mm")}</div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {rules && (
        <div className="mt-3 rounded-xl border border-grid bg-paper p-3 text-sm" role="dialog" aria-label={COMMUNITY_RULES_TITLE}>
          <p className="mb-2 font-medium">{COMMUNITY_RULES_TITLE}</p>
          <ol className="mb-3 list-decimal space-y-1 pl-5">{COMMUNITY_RULES.map((r) => <li key={r}>{r}</li>)}</ol>
          <div className="flex gap-2">
            <button disabled={busy} onClick={acceptRules} className="rounded-xl bg-action px-4 py-2 font-medium text-white disabled:opacity-50">I agree</button>
            <button disabled={busy} onClick={() => setRules(false)} className="rounded-xl border border-grid bg-white px-4 py-2">Not now</button>
          </div>
        </div>
      )}
      {blockedName && (
        <p role="status" className="mt-3 rounded-lg bg-paper px-3 py-2 text-sm">
          You blocked {blockedName}. You won&apos;t see their messages. <Link href={BLOCKED_PATH} className="text-action underline">Blocked players</Link>
        </p>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      <form onSubmit={send} className="mt-3 flex gap-2">
        <input aria-label="Message" className="min-w-0 flex-1 rounded-xl border border-grid px-3 py-2.5 text-base outline-none focus:border-action" placeholder="Message" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
        <button disabled={busy || !text.trim()} className="rounded-xl bg-action px-4 font-medium text-white disabled:opacity-50">Send</button>
      </form>
      {reporting && (
        <ReportSheet name={reporting.name} onClose={() => setReporting(null)}
          onSend={(reason, note) => reportMessage((fn, args) => createClient().rpc(fn, args), reporting.id, reason, note)}
          onBlock={() => { setBlocking(reporting); setReporting(null); }} />
      )}
      {blocking && (
        <SafetyConfirm title={`Block ${blocking.name ?? "this player"}?`} text={BLOCK_EXPLAINED} action="Block" destructive linkBlocked
          onConfirm={() => block(blocking)} onClose={() => setBlocking(null)} />
      )}
    </section>
  );
}
