"""Checks the crash report the staging app actually sent (from the device log, SENTRY_EVENT lines).

Fails if the report is missing, is not marked staging, lacks version/update, or contains anything
personal: the test account's email or name, an email address, an IP address, a user, a device name,
request bodies or headers, tap breadcrumbs, or a query string. Usage: check_report.py <logcat.txt>
"""
import json, os, re, sys

text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
parts = {}
for m in re.finditer(r"SENTRY_EVENT (\d+)/(\d+) (.*)", text):
    parts[int(m.group(1))] = (int(m.group(2)), m.group(3))
if not parts:
    print("FAIL no crash report was sent"); sys.exit(1)
total = max(t for t, _ in parts.values())
if len(parts) < total:
    print(f"FAIL report incomplete in the log ({len(parts)}/{total} pieces)"); sys.exit(1)
raw = "".join(parts[i][1] for i in range(1, total + 1))
ev = json.loads(raw)
problems = []
want = {"environment": "staging"}
for k, v in want.items():
    if ev.get(k) != v: problems.append(f"{k} is {ev.get(k)!r}, expected {v!r}")
if not str(ev.get("release", "")).startswith("courtbook@0.3.0+"): problems.append(f"release {ev.get('release')!r}")
if not ev.get("dist"): problems.append("no dist (update ID)")
if ev.get("user"): problems.append("user present")
if ev.get("server_name"): problems.append("server_name present")
if ((ev.get("contexts") or {}).get("device") or {}).get("name"): problems.append("device name present")
req = ev.get("request") or {}
if set(req) - {"url", "method"}: problems.append(f"request carries {sorted(set(req) - {'url', 'method'})}")
for b in ev.get("breadcrumbs") or []:
    if b.get("category") == "touch" or str(b.get("category", "")).startswith("ui."): problems.append("tap breadcrumb present")
    url = (b.get("data") or {}).get("url")
    if isinstance(url, str) and "?" in url: problems.append(f"query string in breadcrumb {url[:60]}")
for needle in filter(None, [os.environ.get("E2E_EMAIL"), "Emma Tester", os.environ.get("E2E_PASSWORD")]):
    if needle in raw: problems.append(f"contains {needle[:12]}…")
if re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", raw, re.I): problems.append("contains an email address")
if re.search(r"\b\d{1,3}(\.\d{1,3}){3}\b", raw): problems.append("contains an IP-like address")
msg = ((ev.get("exception") or {}).get("values") or [{}])[0].get("value")
print(f"report: environment={ev.get('environment')} release={ev.get('release')} dist={ev.get('dist')} event_id={ev.get('event_id')}")
print(f"report: message={msg!r}; {len(ev.get('breadcrumbs') or [])} breadcrumbs; top-level keys {sorted(ev)}")
for p in problems: print("FAIL", p)
print("crash report: " + ("OK, nothing personal" if not problems else f"{len(problems)} problem(s)"))
sys.exit(1 if problems else 0)
