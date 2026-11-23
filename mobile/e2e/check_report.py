"""Checks the crash reports the staging app actually sent (from the device log, SENTRY_EVENT lines).

Every report in the log is checked. Fails if none was sent, a report is incomplete, is not marked
staging, lacks version/update, has a field outside the allowlist (lib/crash.ts), or contains anything
personal: the test account's email, name or password, any of the synthetic probe values
(lib/crash.ts PROBE_VALUES), an email address, an IP address, a user, a device name, request bodies or
headers, tap or console breadcrumbs, or a query string.

Usage: check_report.py <logcat.txt> [--probe]
  --probe  the privacy probe must be among the reports: its error and its message, both "[withheld]".
"""
import json, os, re, sys

# not a bare "Probe": the function sendPrivacyProbe is in every stack
PROBE = ["Probe Personname", "Personname", "probe.person@example.com", "probe.person",
         "+961 70 123 456", "70 123 456", "70123456", "961%2070", "3f6e2b1c-9a4d-4c2e-8b7f-1a2b3c4d5e6f",
         "probetoken1234567890abcdef", "probe_name"]
TOP = {"event_id", "timestamp", "platform", "level", "environment", "release", "dist", "sdk", "message",
       "exception", "tags", "contexts", "breadcrumbs", "request", "transaction", "debug_meta"}
CONTEXTS = {"os", "device", "app", "runtime", "react_native_context"}

text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
probe = "--probe" in sys.argv[2:]

# Reports are logged in numbered pieces; piece 1 starts a new report.
events, cur = [], None
for m in re.finditer(r"SENTRY_EVENT (\d+)/(\d+) (.*)", text):
    i, n, body = int(m.group(1)), int(m.group(2)), m.group(3)
    if i == 1: cur = {"n": n, "parts": {}}; events.append(cur)
    if cur is not None: cur["parts"][i] = body
if not events:
    print("FAIL no crash report was sent"); sys.exit(1)

failed = 0
withheld = 0
for k, e in enumerate(events, 1):
    if len(e["parts"]) < e["n"]:
        print(f"FAIL report {k} incomplete in the log ({len(e['parts'])}/{e['n']} pieces)"); failed += 1; continue
    raw = "".join(e["parts"][i] for i in range(1, e["n"] + 1))
    ev = json.loads(raw)
    problems = []
    if ev.get("environment") != "staging": problems.append(f"environment is {ev.get('environment')!r}")
    if not str(ev.get("release", "")).startswith("app.courtbook.mobile.staging@0.3.0+"): problems.append(f"release {ev.get('release')!r}")
    if not ev.get("dist"): problems.append("no dist (build)")
    if not (ev.get("tags") or {}).get("update_id"): problems.append("no update_id tag")
    if set(ev) - TOP: problems.append(f"fields outside the allowlist: {sorted(set(ev) - TOP)}")
    if set(ev.get("tags") or {}) - {"update_id"}: problems.append(f"tags outside the allowlist: {sorted(set(ev['tags']) - {'update_id'})}")
    if set(ev.get("contexts") or {}) - CONTEXTS: problems.append(f"contexts outside the allowlist: {sorted(set(ev['contexts']) - CONTEXTS)}")
    if ((ev.get("contexts") or {}).get("device") or {}).get("name"): problems.append("device name present")
    req = ev.get("request") or {}
    if set(req) - {"url", "method"}: problems.append(f"request carries {sorted(set(req) - {'url', 'method'})}")
    for b in ev.get("breadcrumbs") or []:
        cat = str(b.get("category", ""))
        if cat not in ("navigation", "fetch", "xhr", "http"): problems.append(f"breadcrumb kind {cat!r} present")
        if "message" in b: problems.append("breadcrumb message present")
        for v in (b.get("data") or {}).values():
            if isinstance(v, str) and ("?" in v or "#" in v): problems.append(f"query or fragment in breadcrumb {v[:60]}")
    needles = PROBE + list(filter(None, [os.environ.get("E2E_EMAIL"), "Emma Tester", os.environ.get("E2E_PASSWORD")]))
    for needle in needles:
        if needle in raw: problems.append(f"contains {needle[:12]}…")
    if re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", raw, re.I): problems.append("contains an email address")
    if re.search(r"\b\d{1,3}(\.\d{1,3}){3}\b", raw): problems.append("contains an IP-like address")
    exc = ((ev.get("exception") or {}).get("values") or [{}])[0]
    msg = exc.get("value") if ev.get("exception") else ev.get("message")
    if msg == "[withheld]": withheld += 1
    print(f"report {k}: environment={ev.get('environment')} release={ev.get('release')} update_id={(ev.get('tags') or {}).get('update_id')} event_id={ev.get('event_id')}")
    print(f"report {k}: text={msg!r}; {len(ev.get('breadcrumbs') or [])} breadcrumbs {[b.get('category') for b in ev.get('breadcrumbs') or []]}; fields {sorted(ev)}")
    for p in problems: print(f"FAIL report {k}:", p)
    failed += bool(problems)

if probe and withheld < 2:
    print(f"FAIL the privacy probe's error and message were expected, both withheld; found {withheld} withheld"); failed += 1
print(f"crash reports: {len(events)} checked, " + ("OK, nothing personal" if not failed else f"{failed} with problems"))
sys.exit(1 if failed else 0)
