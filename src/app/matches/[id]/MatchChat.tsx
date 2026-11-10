"use client";

import { useEffect, useRef, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";

type Msg = { id: string; profile_id: string; name: string | null; body: string; created_at: string };

export default function MatchChat({ matchId, meId, tz, initial }: { matchId: string; meId: string; tz: string; initial: Msg[] }) {
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  // poll for new messages every 5 s (boring and reliable; realtime can replace it later)
  useEffect(() => {
    const id = setInterval(async () => {
      const last = msgs[msgs.length - 1]?.created_at ?? null;
      const { data } = await createClient().rpc("match_messages_list", { p_match: matchId, p_after: last });
      if (data && (data as Msg[]).length) setMsgs((cur) => [...cur, ...(data as Msg[]).filter((d) => !cur.some((c) => c.id === d.id))]);
    }, 5000);
    return () => clearInterval(id);
  }, [matchId, msgs]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [msgs.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    const supabase = createClient();
    const { data, error } = await supabase.from("match_messages").insert({ match_id: matchId, profile_id: meId, body }).select("id, profile_id, body, created_at").single();
    setBusy(false);
    if (!error && data) { setMsgs((cur) => [...cur, { ...data, name: "You" }]); setText(""); fetch("/api/notify/email", { method: "POST" }).catch(() => {}); }
  }

  return (
    <section className="rounded-2xl border border-grid bg-white p-4">
      <h2 className="mb-2 font-medium">Chat</h2>
      <div className="flex max-h-72 flex-col gap-2 overflow-y-auto text-sm">
        {msgs.length === 0 && <p className="text-muted">No messages yet. Agree on balls, who brings what, where to meet.</p>}
        {msgs.map((x) => (
          <div key={x.id} className={`max-w-[85%] rounded-2xl px-3 py-2 ${x.profile_id === meId ? "self-end bg-turf text-white" : "self-start bg-paper"}`}>
            {x.profile_id !== meId && <div className="text-xs font-medium opacity-70">{x.name ?? "Player"}</div>}
            <div>{x.body}</div>
            <div className={`mt-0.5 text-[10px] ${x.profile_id === meId ? "text-white/70" : "text-muted"}`}>{formatInTimeZone(new Date(x.created_at), tz, "EEE HH:mm")}</div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form onSubmit={send} className="mt-3 flex gap-2">
        <input className="flex-1 rounded-xl border border-grid px-3 py-2.5 text-base outline-none focus:border-action" placeholder="Message" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
        <button disabled={busy || !text.trim()} className="rounded-xl bg-action px-4 font-medium text-white disabled:opacity-50">Send</button>
      </form>
    </section>
  );
}
