// Sets the two staging sign-in email templates (Magic Link, Confirm signup) to carry the 6-digit code,
// through Supabase's Management API. STAGING PROJECT ONLY: the project ref is fixed below and the live
// ref is refused. Prints only non-secret facts (lengths, whether a template contains {{ .Token }} or a
// link) — never the token, the API response or any other setting.
// Branch staging-auth-templates only; run by "Staging database", action "tester".
const STAGING_REF = "pwznauyioqykdwodwpvx", LIVE_REF = "lgujfbwunokobjxlvpuf";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) { console.error("::error::SUPABASE_ACCESS_TOKEN is not set"); process.exit(1); }
const REF = STAGING_REF;
if (REF === LIVE_REF) { console.error("::error::Refusing the live project"); process.exit(1); }
const api = `https://api.supabase.com/v1/projects/${REF}/config/auth`;
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const body = (title) => `<h2>${title}</h2>\n<p>Enter this code in the app: <strong>{{ .Token }}</strong></p>\n<p>It expires in 1 hour. If you didn't ask for it, ignore this email.</p>`;
const want = {
  mailer_subjects_magic_link: "Your CourtBook Staging code",
  mailer_templates_magic_link_content: body("Your CourtBook Staging sign-in code"),
  mailer_subjects_confirmation: "Welcome to CourtBook Staging: your code",
  mailer_templates_confirmation_content: body("Welcome to CourtBook Staging"),
};
const describe = (c) => `OTP length ${c.mailer_otp_length}; Magic Link: code ${/\{\{\s*\.Token\s*\}\}/.test(c.mailer_templates_magic_link_content || "") ? "yes" : "NO"}, link ${/ConfirmationURL/.test(c.mailer_templates_magic_link_content || "") ? "yes" : "no"}; Confirm signup: code ${/\{\{\s*\.Token\s*\}\}/.test(c.mailer_templates_confirmation_content || "") ? "yes" : "NO"}, link ${/ConfirmationURL/.test(c.mailer_templates_confirmation_content || "") ? "yes" : "no"}`;
async function get() {
  const r = await fetch(api, { headers });
  if (!r.ok) { console.error(`::error::reading staging auth settings failed: HTTP ${r.status}`); process.exit(1); }
  return r.json();
}
console.log(`project: ${REF} (staging)`);
console.log(`before: ${describe(await get())}`);
const p = await fetch(api, { method: "PATCH", headers, body: JSON.stringify(want) });
if (!p.ok) { console.error(`::error::updating the staging templates failed: HTTP ${p.status}`); process.exit(1); }
const after = await get();
console.log(`after:  ${describe(after)}`);
const same = Object.entries(want).every(([k, v]) => after[k] === v);
console.log(`the four template fields now read back exactly as sent: ${same ? "yes" : "NO"}`);
if (!same || after.mailer_otp_length !== 6) process.exit(1);
