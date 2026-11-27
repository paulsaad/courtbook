#!/usr/bin/env python3
"""Check a website build's Supabase calls against the schema at a migration stage.

check.py <calls.json> <stage> <reference stage> : for every .from() chain and .rpc() call, decide per role
(anon, authenticated, service_role) whether it is allowed at <stage>: relation/function exists, every referenced column
exists, the needed table/column privilege is granted, and (RLS on) at least one permissive policy covers the command
for that role. Reports (1) anything that does not exist at <stage>; (2) any role whose verdict differs between
<reference stage> and <stage> (a call that worked at the reference and does not at <stage> is a REGRESSION);
(3) calls no signed-in or signed-out user may make at <stage> (informational: expected for service-role files).
"""
import json, os, re, sys

calls = json.load(open(sys.argv[1]))
stage, ref = sys.argv[2], sys.argv[3]
cat = {s: json.load(open(f"{os.environ.get('CATALOG_DIR', '/tmp/stg')}/cat_{s}.json")) for s in {stage, ref}}
ROLES = ["anon", "authenticated", "service_role"]
CMD = {"select": "r", "insert": "a", "update": "w", "delete": "d"}

def split_top(s):
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch == "(": depth += 1
        if ch == ")": depth -= 1
        if ch == "," and depth == 0: out.append(cur.strip()); cur = ""
        else: cur += ch
    if cur.strip(): out.append(cur.strip())
    return out

def colname(tok):
    tok = tok.strip()
    if ":" in tok and "::" not in tok.split(":", 1)[0] + ":" and not tok.startswith("..."):
        a, b = tok.split(":", 1)
        if "::" not in a: tok = b          # alias:col
    tok = tok.split("::")[0]               # cast
    tok = re.split(r"->>?", tok)[0]         # json path
    tok = re.sub(r"\.(count|sum|avg|min|max)\(\)$", "", tok)
    return tok.strip()

def resolve_embed(c, parent, name, hint):
    rels = c["relations"]
    if name in rels: return name
    p = rels.get(parent)
    if p:
        for fk in p["fks"]:
            if fk["cols"] == [name] or (hint and fk["cols"] == [hint]): return fk["ref"]
    return None

def parse_select(c, table, s, need, aliases, problems):
    """need: list of (table, column, privilege). aliases: embed name/alias -> table."""
    for item in split_top(s):
        if item in ("*", "count", "count()"):
            need.append((table, "*", "select")); continue
        m = re.match(r"^(\.\.\.)?(?:(\w+):)?(\w+)(?:!(\w+))?(?:!(inner|left))?\((.*)\)$", item, re.S)
        if m:
            alias, name, hint, sub = m.group(2), m.group(3), m.group(4), m.group(6)
            t = resolve_embed(c, table, name, hint)
            if t is None: problems.append(f"embed `{item[:50]}` from {table}: no table or foreign key `{name}`"); continue
            aliases[alias or name] = t; aliases[name] = t
            need.append((t, "*embed*", "select"))
            parse_select(c, t, sub, need, aliases, problems); continue
        need.append((table, colname(item), "select"))

def or_cols(expr):
    cols = []
    for part in split_top(expr):
        mm = re.match(r"^(and|or|not\.and|not\.or)\((.*)\)$", part, re.S)
        if mm: cols += or_cols(mm.group(2)); continue
        cols.append(part.split(".", 1)[0])
    return cols

def allowed(c, table, col, priv, role):
    r = c["relations"].get(table)
    if r is None: return False, f"relation `{table}` does not exist"
    if col not in ("*", "*embed*") and col not in r["columns"]: return False, f"column `{table}.{col}` does not exist"
    tp = r["table_priv"][role][priv]
    if col in ("*", "*embed*"):
        ok = tp or (priv != "delete" and any(v[priv] for v in r["col_priv"][role].values()))
        if not ok: return False, f"no {priv.upper()} on `{table}` for {role}"
    elif priv != "delete" and not r["col_priv"][role][col][priv]:
        return False, f"no {priv.upper()} on `{table}.{col}` for {role}"
    if r["rls"] and role != "service_role" and r["kind"] in ("r", "p"):
        cmd = CMD[priv]
        if not any(p["permissive"] and p["cmd"] in (cmd, "*") and ({"public", role} & set(p["roles"])) for p in r["policies"]):
            return False, f"RLS on `{table}`: no {priv.upper()} policy for {role}"
    return True, ""

def needs_of(c, call):
    need, problems, aliases = [], [], {}
    t = call["table"]
    if t not in c["relations"]: return [(t, "*", "select")], [f"relation `{t}` does not exist"]
    ops = call["ops"]
    writing = any(o["op"] in ("insert", "upsert", "update", "delete") for o in ops)
    for o in ops:
        if o["op"] == "select":
            if o["cols"].startswith("<non-literal"): problems.append(f"select list not a literal: {o['cols']}")
            else: parse_select(c, t, o["cols"], need, aliases, problems)
        elif o["op"] in ("insert", "upsert"):
            for k in o["keys"]: need.append((t, k, "insert"))
            if o["op"] == "upsert" and "ignoreDuplicates: true" not in (o.get("onConflict") or ""):
                for k in o["keys"]: need.append((t, k, "update"))
        elif o["op"] == "update":
            for k in o["keys"]: need.append((t, k, "update"))
        elif o["op"] == "delete": need.append((t, "*", "delete"))
    for o in ops:
        cols = []
        if o["op"] == "filter": cols = [o["col"]]
        elif o["op"] == "or": cols = [] if o["expr"].startswith("<non-literal") else or_cols(o["expr"])
        elif o["op"] == "match": cols = o["keys"]
        for col in cols:
            if col.startswith("<non-literal"): problems.append(f"filter column not a literal: {col}"); continue
            tt = t
            if "." in col:
                a, col = col.split(".", 1)
                tt = aliases.get(a) or resolve_embed(c, t, a, None)
                if tt is None: problems.append(f"filter on `{a}.{col}`: unknown embed"); continue
            if o["op"] == "or" and o.get("foreign"):
                fm = re.search(r"(?:foreignTable|referencedTable):\s*['\"](\w+)['\"]", o["foreign"])
                if fm: tt = aliases.get(fm.group(1), fm.group(1))
            # filters on a write need SELECT on the filtered column (PostgREST/Postgres semantics for UPDATE/DELETE WHERE)
            need.append((tt, colname(col), "select"))
    if not any(o["op"] == "select" for o in ops) and not writing:
        need.append((t, "*", "select"))
    return need, problems

def verdict_from(c, call):
    need, problems = needs_of(c, call)
    v = {}
    for role in ROLES:
        reasons = [why for (tb, col, pv) in need for ok, why in [allowed(c, tb, col, pv, role)] if not ok]
        v[role] = (not reasons, sorted(set(reasons)))
    return v, problems

def verdict_rpc(c, call):
    sigs = c["functions"].get(call["fn"])
    if not sigs: return {r: (False, [f"function `{call['fn']}` does not exist"]) for r in ROLES}, []
    keys = set(call["keys"]); v = {}
    match = [s for s in sigs if keys <= set(s["args"]) and set(s["args"][: s["nargs"] - s["ndefaults"]]) <= keys]
    for r in ROLES:
        if not match: v[r] = (False, [f"`{call['fn']}`: no signature takes exactly-named args {sorted(keys)}"])
        elif not any(s["exec"][r] for s in match): v[r] = (False, [f"`{call['fn']}`: no EXECUTE for {r}"])
        else: v[r] = (True, [])
    return v, []

def verdict(c, call):
    if call.get("unresolved") and (call["kind"] == "rpc" and call["fn"] is None or call["kind"] == "from" and call["table"] is None):
        return None, [call["unresolved"]]
    return verdict_from(c, call) if call["kind"] == "from" else verdict_rpc(c, call)

missing, regress, nobody, manual, changed = [], [], [], [], []
for call in calls:
    where = f"{call['file']}:{call['line']} {call['kind']} {call.get('table') or call.get('fn')}"
    vs, probs = verdict(cat[stage], call)
    vr, _ = verdict(cat[ref], call)
    unresolved = call.get("unresolved") or next((o.get("unresolved") for o in call.get("ops", []) if o.get("unresolved")), None)
    if vs is None or probs or unresolved:
        manual.append(f"{where} — {'; '.join(probs) or unresolved}")
        if vs is None: continue
    roles = ["service_role"] if call["admin"] else ["anon", "authenticated"]
    for r in ROLES:
        if vr and vr[r][0] and not vs[r][0]:
            (regress if r in roles else changed).append(f"{where} — {r}: {'; '.join(vs[r][1])}")
        elif vr and not vr[r][0] and vs[r][0]:
            changed.append(f"{where} — {r}: allowed at {stage}, not at {ref}")
    if any("does not exist" in why for r in ROLES for why in vs[r][1]):
        missing.append(f"{where} — {'; '.join(sorted({w for r in ROLES for w in vs[r][1] if 'does not exist' in w}))}")
    elif not any(vs[r][0] for r in roles):
        nobody.append(f"{where} — " + " | ".join(f"{r}: {'; '.join(vs[r][1])}" for r in roles))

n_from = sum(1 for x in calls if x["kind"] == "from"); n_rpc = len(calls) - n_from
print(f"## {os.path.basename(sys.argv[1]).removesuffix('.json')} at {stage} (reference {ref}): {n_from} table calls, {n_rpc} rpc calls")
for title, items in [("MISSING at this stage (relation, column or function)", missing),
                     ("REGRESSION for the role the call uses (allowed at reference, refused at this stage)", regress),
                     ("refused for the role the call uses (anon and authenticated, or service_role for admin files)", nobody),
                     ("other verdict changes (roles the call does not use)", changed),
                     ("needs a manual look (non-literal input)", manual)]:
    print(f"- {title}: {len(items)}")
    for i in items: print(f"    {i}")
