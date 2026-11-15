"""Writes src/dark.css: dark-mode stand-ins for the light colours the
dashboard hard-codes (bg-white, ink text, ivory cards, pale badge tints).

Many screens were drawn with fixed colours instead of the theme tokens, so
this scans every .tsx/.ts file for colour classes, works out how light each
colour is, and repaints only the ones that would look wrong at night:
  - light backgrounds  -> the dark card / muted surfaces (tints keep a hint of their hue)
  - dark text          -> light text (coloured text -> a lighter shade of the same hue)
  - light borders/rings -> the dark border
Dark panels, white text and the gold stay as they are. Anything inside
.keep-light (customer-page mockups) is left alone.

Run again after adding screens or upgrading Tailwind:
    python3 scripts/gen-dark-css.py
"""
import math
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
theme = (root / "node_modules/tailwindcss/theme.css").read_text()
PAL = dict(re.findall(r"--color-([a-z]+-\d+):\s*([^;]+);", theme))
BRAND = {"ivory": "#F8F3E7", "ink": "#15130F", "white": "#ffffff", "black": "#000000", "paper": "#F8F3E7"}
HUES = "red orange amber yellow lime green emerald teal cyan sky blue indigo violet purple fuchsia pink rose".split()
NEUTRAL = "gray slate stone zinc neutral".split()
SKIP = ":not(.keep-light, .keep-light *)"

TOKEN = re.compile(
    r"(?<![\w-])((?:hover:)?)(bg|text|border|ring|from|via|to)-("
    r"\[#[0-9a-fA-F]{6}\]|white|black|ivory|ink|paper|"
    r"(?:" + "|".join(HUES + NEUTRAL) + r")-(?:50|100|200|300|400|500|600|700|800|900|950)"
    r")(/\d{1,3})?(?![\w-])"
)


def oklch_of(css: str):
    """(L 0-1, C, h) for a hex or an oklch() string."""
    css = css.strip()
    m = re.match(r"oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)", css)
    if m:
        return float(m[1]) / 100, float(m[2]), float(m[3])
    h = css.lstrip("#")
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    r, g, b = lin
    l_ = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m_ = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s_ = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return L, math.hypot(A, B), math.degrees(math.atan2(B, A)) % 360


def color_of(name: str) -> str:
    if name.startswith("["):
        return name[1:-1]
    if name in BRAND:
        return BRAND[name]
    return PAL[name]


def esc(cls: str) -> str:
    return re.sub(r"([\[\]#/.:%])", r"\\\1", cls)


def alpha(value: str, a):
    return value if a is None else f"color-mix(in oklch, {value} {a}%, transparent)"


def repaint(prop: str, name: str, a):
    """CSS declaration for this class in dark mode, or None to leave it."""
    col = color_of(name)
    L, C, _ = oklch_of(col)
    hue = name.split("-")[0] if name.split("-")[0] in HUES else None
    shade = int(name.split("-")[1]) if hue else None

    if prop in ("bg", "from", "via", "to"):
        if L < 0.80:
            return None                      # dark panels, gold, strong fills stay
        if a is not None and int(a) <= 25 and not hue:
            return None                      # bg-white/10 glass on a dark panel: already right
        if hue:
            pct = {50: 12, 100: 20, 200: 30}.get(shade)
            if pct is None:
                return None                  # 300/400 fills: bright chips, keep
            val = f"color-mix(in oklch, {PAL[hue + '-500']} {pct}%, var(--card))"
        elif C > 0.02:
            val = f"color-mix(in oklch, {col} 14%, var(--card))"
        else:
            val = "var(--card)" if L >= 0.90 else "var(--muted)"
        val = alpha(val, a)
        var = {"bg": "background-color", "from": "--tw-gradient-from", "via": "--tw-gradient-via", "to": "--tw-gradient-to"}[prop]
        return f"{var}: {val};"

    if prop == "text":
        if hue:
            if shade < 600:
                return None
            light = PAL[f"{hue}-{300 if shade <= 700 else 200}"]
            return f"color: {alpha(light, a)};"
        if L > 0.62:
            return None                      # already light text (white, ivory, gold-light)
        if C > 0.05:                         # brown/bronze/cedar text: lift it
            return f"color: {alpha(f'color-mix(in oklch, {col} 45%, white)', a)};"
        if L <= 0.42:
            return f"color: {alpha('var(--foreground)', a)};"
        return f"color: {alpha('var(--muted-foreground)', a)};"

    # border / ring
    var = "border-color" if prop == "border" else "--tw-ring-color"
    if hue:
        pct = {50: 30, 100: 35, 200: 35, 300: 55}.get(shade)
        if pct is None:
            return None
        return f"{var}: color-mix(in oklch, {PAL[hue + '-500']} {pct}%, var(--card));"
    if L >= 0.80 or (L <= 0.30 and a is not None and int(a) <= 30):
        return f"{var}: var(--border);"   # light lines, and faint ink hairlines
    if L <= 0.30:
        return f"{var}: color-mix(in oklch, var(--foreground) 35%, transparent);"
    return None


found = set()
for f in (root / "src").rglob("*"):
    if f.suffix in (".tsx", ".ts") and f.is_file():
        for m in TOKEN.finditer(f.read_text(errors="ignore")):
            found.add((m[1], m[2], m[3], m[4][1:] if m[4] else None))

groups: dict[str, list[str]] = {}
for hover, prop, name, a in sorted(found, key=lambda t: (t[0], t[1], t[2], t[3] or "")):
    decl = repaint(prop, name, a)
    if not decl:
        continue
    cls = f"{hover}{prop}-{name}" + (f"/{a}" if a else "")
    sel = f".dark .{esc(cls)}" + (":hover" if hover else "") + SKIP
    groups.setdefault(decl, []).append(sel)

out = [",\n".join(sels) + " {\n  " + decl + "\n}" for decl, sels in groups.items()]

# Dark text that sits on a bright fill (gold button, amber-400 chip) stays dark.
bright = [".bg-primary", ".bg-gold", ".bg-gold-light", ".from-gold", ".bg-\\[\\#C9972F\\]", ".bg-\\[\\#E3BE63\\]",
          ".bg-\\[\\#FFB3C7\\]"] + [f".bg-{h}-{n}" for h in HUES for n in (300, 400)] + [".bg-yellow-500", ".bg-amber-500", ".bg-lime-500"]
inks = [".text-black", ".text-ink", ".text-primary-foreground"] + [f".text-{h}-{n}" for h in HUES for n in (700, 800, 900, 950)] + \
       [f".text-\\[\\#{x}\\]" for x in ("15130F", "1F1A14", "111110", "1a1a1a", "1c1917", "1C2235")]
b, i = ", ".join(bright), ", ".join(inks)
out.append(f".dark :is({b}):is({i}),\n.dark :is({b}) :is({i}) {{\n  color: revert-layer;\n}}")

head = "/* GENERATED by scripts/gen-dark-css.py: do not edit by hand. */\n"
(root / "src/dark.css").write_text(head + "\n".join(out) + "\n")
print(f"{len(found)} colour classes found, {sum(len(v) for v in groups.values())} repainted in {len(out)} rules")
