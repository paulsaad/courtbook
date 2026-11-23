# Prints the `run:` script of a staging-db.yml step whose `if:` names the given action (the n-th such step, default 1).
import sys, yaml
action = sys.argv[1]; nth = int(sys.argv[2]) if len(sys.argv) > 2 else 1
wf = yaml.safe_load(open(".github/workflows/staging-db.yml"))
steps = [st for job in wf["jobs"].values() for st in job.get("steps", []) if f"inputs.action == '{action}'" in str(st.get("if", ""))]
print(steps[nth - 1]["run"])
