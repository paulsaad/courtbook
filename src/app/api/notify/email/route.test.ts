/** Chat privacy (Paul, 26 Nov): a notification email never carries chat-message text; other kinds are unchanged. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: { subject: string; text: string }[] = [];
let rows: { id: string; email: string; name: string | null; body: string; kind: string; match_id: string | null }[] = [];
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: async (m: { subject: string; text: string }) => { sent.push(m); } }) } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async (fn: string) => (fn === "claim_notifications_to_email" ? { data: rows } : { data: null }) }) }));
import { POST } from "./route";
import { emailSafe } from "@/lib/emailSafe";

beforeEach(() => { sent.length = 0; process.env.GMAIL_USER = "x@example.test"; process.env.GMAIL_APP_PASSWORD = "p"; });
const row = (kind: string, body: string) => ({ id: kind + body.length, email: "r@example.test", name: "Rana", body, kind, match_id: "m1" });

describe("notification emails", () => {
  it("a chat notice still holding text (before the database change) is sent without it", async () => {
    rows = [row("match_message", "Karim Haddad: my private address is 12 Cedar St")];
    await POST(new Request("https://courtbook.example/api/notify/email", { method: "POST" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].subject + sent[0].text).not.toMatch(/Cedar|private address/);
    expect(sent[0].subject).toBe("CourtBook: New message in one of your games");
  });
  it("the new chat notice text is sent as it is; other kinds are unchanged", async () => {
    rows = [row("match_message", "New message from Karim Haddad"), row("player_joined", "Rana Khoury joined your match")];
    await POST(new Request("https://courtbook.example/api/notify/email", { method: "POST" }));
    expect(sent.map((m) => m.subject)).toEqual(["CourtBook: New message from Karim Haddad", "CourtBook: Rana Khoury joined your match"]);
  });
  it("emailSafe: only the exact new form passes for chat notices", () => {
    expect(emailSafe(row("match_message", "New message from Karim: hi there")).body).toBe("New message in one of your games");
    expect(emailSafe(row("match_message", "New message from Karim Haddad")).body).toBe("New message from Karim Haddad");
    expect(emailSafe(row("join_request", "Karim: asked to join")).body).toBe("Karim: asked to join");
  });
});
