"""Is the Reserve button fully on screen and clear of Android's navigation bar? (F6, 18 Nov)

usage: check_reachable.py ui.xml dumpsys-window.txt dpi label expected-button-label
ui.xml: `uiautomator dump` of the club screen; dumpsys-window.txt: `dumpsys window` output, which
gives the navigation bar's frame. Prints one line; exit 1 if the button is cut off, covered or small.
Reads bounds, ids and the button's own label (so a stale screen cannot pass), never any field."""
import re, sys
ui, win, dpi, label, expected = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5]
xml = open(ui, encoding="utf-8").read()
node = next((n for n in re.findall(r"<node [^>]*>", xml) if 'resource-id="reserve-button"' in n), None)
m = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node) if node else None
desc = re.search(r'content-desc="([^"]*)"', node).group(1) if node and 'content-desc="' in node else None
if m and desc != expected:
    print(f"{label}: FAIL the button on screen reads {desc!r}, expected {expected!r}"); sys.exit(1)
root = re.search(r'<node[^>]*bounds="\[0,0\]\[(\d+),(\d+)\]"', xml)
if not m or not root:
    print(f"{label}: FAIL reserve button not found on screen"); sys.exit(1)
x1, y1, x2, y2 = map(int, m.groups())
screen_w, screen_h = map(int, root.groups())
text = open(win, encoding="utf-8", errors="replace").read()
nav = re.search(r'(?:ITYPE_NAVIGATION_BAR|type=navigationBars)[^\n]*?frame=\[\d+,(\d+)\]\[\d+,(\d+)\]', text)
nav_top = int(nav.group(1)) if nav and int(nav.group(2)) > int(nav.group(1)) else None
limit = nav_top if nav_top is not None else screen_h
dp = lambda px: round(px * 160 / dpi)
problems = []
if y1 < 0 or x1 < 0 or x2 > screen_w: problems.append("cut off at an edge")
if y2 > limit: problems.append(f"bottom {dp(y2)} dp below the {'navigation bar' if nav_top is not None else 'screen'} top {dp(limit)} dp")
if dp(y2 - y1) < 48 or dp(x2 - x1) < 48: problems.append(f"target {dp(x2 - x1)}x{dp(y2 - y1)} dp < 48")
src = "navigation bar frame" if nav_top is not None else "screen height (no navigation bar frame found)"
print(f"{label}: reserve button {dp(x1)},{dp(y1)}–{dp(x2)},{dp(y2)} dp; limit {dp(limit)} dp from {src}: " + ("OK" if not problems else "FAIL " + "; ".join(problems)))
sys.exit(1 if problems else 0)
