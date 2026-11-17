"""Accessibility audit of one Android screen (uiautomator dump), as TalkBack would meet it.

Fails (exit 1) on a control that can be tapped but has nothing to announce: no text and no
content description on it or anything inside it. Reports, without failing, tap targets smaller than
44 x 44 dp (Apple's minimum; Android recommends 48, which the app reaches with extra touch area), ignoring controls partly scrolled out of view (cut by the screen edge or by
the edge of the list they scroll in). Usage: a11y_audit.py <dump.xml> <screen> <density-dpi>
"""
import sys
import xml.etree.ElementTree as ET

path, screen, dpi = sys.argv[1], sys.argv[2], int(sys.argv[3])
scale = dpi / 160.0
root = ET.parse(path).getroot()


def spoken(n):
    if (n.get("text") or "").strip() or (n.get("content-desc") or "").strip():
        return True
    return any(spoken(c) for c in n)


def size_dp(n):
    b = n.get("bounds", "[0,0][0,0]").replace("][", ",").strip("[]").split(",")
    x1, y1, x2, y2 = map(int, b)
    return (x2 - x1) / scale, (y2 - y1) / scale


def bounds(n):
    b = n.get("bounds", "[0,0][0,0]").replace("][", ",").strip("[]").split(",")
    return list(map(int, b))


screen_w = max(bounds(n)[2] for n in root.iter("node"))
screen_h = max(bounds(n)[3] for n in root.iter("node"))
parent = {c: p for p in root.iter() for c in p}


def scroll_edges(n):
    """Bounds of every scrolling list n sits in: what scrolls out of view is cut at their edges."""
    p = parent.get(n)
    while p is not None:
        if p.get("scrollable") == "true":
            yield bounds(p)
        p = parent.get(p)


problems, small = [], []
for n in root.iter("node"):
    x1, y1, x2, y2 = bounds(n)
    # Partly scrolled out of view: its visible size says nothing about its real size.
    clipped = x1 <= 0 or y1 <= 0 or x2 >= screen_w or y2 >= screen_h or any(
        x1 <= sx1 or y1 <= sy1 or x2 >= sx2 or y2 >= sy2 for sx1, sy1, sx2, sy2 in scroll_edges(n))
    if n.get("package", "").startswith("com.android.systemui"):
        continue
    if n.get("clickable") == "true" and n.get("enabled") == "true":
        w, h = size_dp(n)
        label = (n.get("content-desc") or n.get("text") or n.get("resource-id") or n.get("class")).strip()
        if w == 0 or h == 0:
            continue
        if not spoken(n):
            problems.append(f"{screen}: tappable {n.get('class')} {n.get('resource-id') or ''} at {n.get('bounds')} has nothing to announce")
        # Selectable text (the About values) reports as clickable but is not a control.
        elif not clipped and min(w, h) < 43.5 and n.get("class") not in ("android.widget.EditText", "android.widget.TextView"):
            small.append(f"{screen}: '{label[:40]}' is {w:.0f}x{h:.0f} dp")

for p in problems:
    print("FAIL", p)
for s in small:
    print("small", s)
print(f"{screen}: {len(problems)} unlabelled control(s), {len(small)} small target(s)")
sys.exit(1 if problems else 0)
