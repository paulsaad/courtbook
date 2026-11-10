import { NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Best-effort email fan-out for in-app notifications. Called by the app after actions that
 * create notifications; any signed-in user may trigger it, but it only ever emails rows the
 * DB marked as pending for opted-in recipients, and marks them emailed. Uses Gmail SMTP
 * (GMAIL_USER / GMAIL_APP_PASSWORD) until a domain + Resend exist. No-op when unset.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  const smtpUser = process.env.GMAIL_USER, smtpPass = process.env.GMAIL_APP_PASSWORD;
  if (!smtpUser || !smtpPass) return NextResponse.json({ sent: 0, reason: "email not configured" });

  const admin = createAdminClient();
  const { data: rows } = await admin.rpc("notifications_to_email", { p_limit: 20 });
  const list = (rows ?? []) as { id: string; email: string; name: string | null; body: string; kind: string; match_id: string | null }[];
  if (list.length === 0) return NextResponse.json({ sent: 0 });

  const origin = new URL(request.url).origin;
  const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: smtpUser, pass: smtpPass } });
  const done: string[] = [];
  for (const n of list) {
    try {
      await transport.sendMail({
        from: `CourtBook <${smtpUser}>`,
        to: n.email,
        subject: `CourtBook: ${n.body.slice(0, 60)}`,
        text: `${n.body}\n\nOpen: ${origin}${n.match_id ? `/matches/${n.match_id}` : "/notifications"}\n\nTo stop these emails, turn off "Email me about my matches" in your profile.`,
      });
      done.push(n.id);
    } catch {
      // leave unmarked; next call retries
    }
  }
  if (done.length) await admin.rpc("mark_notifications_emailed", { p_ids: done });
  return NextResponse.json({ sent: done.length });
}
