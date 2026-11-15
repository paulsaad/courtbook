"""Pick the newest iOS simulator runtime and two iPhones for it: the smallest (SE-class if the
runtime has one) and the largest (a Pro Max). Prints: <runtime-id> <small-type-id> <large-type-id>."""
import json, subprocess

data = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "-j", "runtimes"]))
ios = [r for r in data["runtimes"] if r.get("platform") == "iOS" and r.get("isAvailable")]
rt = max(ios, key=lambda r: [int(x) for x in r["version"].split(".")])
phones = [d for d in rt.get("supportedDeviceTypes", []) if d.get("productFamily") == "iPhone"]
names = [d["name"] for d in phones]
small = next((d for d in phones if "SE" in d["name"]), None) or next((d for d in phones if d["name"].endswith("e")), None) or phones[0]
large = next((d for d in reversed(phones) if "Pro Max" in d["name"]), phones[-1])
print(rt["identifier"], small["identifier"], large["identifier"])
import sys; print(f"runtime {rt['name']}; small {small['name']}; large {large['name']}; available {names}", file=sys.stderr)
