"""Print which fingerprint sources differ between an installed build and this code.

Input: the JSON of `eas fingerprint:compare --json` (fingerprint1 = the build, fingerprint2 = here).
For config sources, prints each differing setting by dotted path.
"""
import json
import sys

d = json.load(open(sys.argv[1]))
idx = lambda f: {(x.get("filePath") or x.get("id")): x for x in f["sources"]}
a, b = idx(d["fingerprint1"]), idx(d["fingerprint2"])


def flat(x, p=""):
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            out.update(flat(v, p + "." + k))
        return out
    return {p: json.dumps(x)}


for k in sorted(set(a) | set(b)):
    if a.get(k, {}).get("hash") == b.get(k, {}).get("hash"):
        continue
    print(f"  DIFFERS {k}")
    try:
        fa, fb = flat(json.loads(a[k]["contents"])), flat(json.loads(b[k]["contents"]))
        for kk in sorted(set(fa) | set(fb)):
            if fa.get(kk) != fb.get(kk):
                print(f"    {kk}: installed build = {fa.get(kk, 'absent')} | this code = {fb.get(kk, 'absent')}")
    except Exception:
        print(f"    installed build = {a.get(k, {}).get('hash', 'absent')} | this code = {b.get(k, {}).get('hash', 'absent')}")
