"""The side-by-side GIFs in the README: each clip made by lessgif and by the tools people use now.

  node bench/showcase-screen.mjs     # the screen-recording clip (needs Playwright and site/dist)
  python3 bench/showcase.py          # downloads the films, encodes, writes docs/compare/*.gif

Each clip is 3 s at 15 fps, 360 pixels wide. It is made into a GIF by ffmpeg (its usual
palettegen + paletteuse recipe) and by gifski, both at their default settings, and by lessgif at
the lowest quality whose GIF scores at least as well as the better of the two. Then ffmpeg's GIF
of the first clip is re-compressed by gifsicle (-O3 --lossy=35) and by lessgif at the lowest
quality that scores at least as well. Scores are SSIMULACRA2, as in compare.py: against the source
frames, or for re-compression against the frames of the GIF being re-compressed.

The films are the Blender Foundation's open movies (CC BY 3.0), downloaded from blender.org.
Needs the same tools as compare.py, plus gifsicle.
"""

import glob, hashlib, json, os, shutil, subprocess, sys, urllib.request, zipfile
from multiprocessing import Pool
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compare import HERE, LESSGIF, GIFSKI, decode_timeline, score  # noqa: E402

GIFSICLE = os.environ.get("GIFSICLE", "gifsicle")
DATA = os.path.join(HERE, "data", "showcase")
OUT = os.path.join(HERE, "..", "docs", "compare")

SOURCES = {
    "bbb.m4v": ("https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_640x360.m4v.zip",
                "BigBuckBunny_640x360.m4v", "738e2f999860553d056dd79c952f58f63cbb73892a57c72342ce9e5330d9d2d7"),
    "tos.mov": ("https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov", None,
                "efa9062d9cdb7a338e40ad530dfdf234806743f29ae6a1a136b97ece4e588e8f"),
}

# name, source, start (s), crop for a letterboxed film
VIDEOS = [
    ("bunny", "bbb.m4v", 330, None),
    ("steel", "tos.mov", 30, None),
    ("screen", None, None, None),  # frames from showcase-screen.mjs
]
WIDTH = 360


def fetch(name):
    url, member, sha = SOURCES[name]
    path = os.path.join(DATA, "src", name)
    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    urllib.request.urlretrieve(url, tmp)
    if member:
        with zipfile.ZipFile(tmp) as z, z.open(member) as f, open(path + ".x", "wb") as o:
            shutil.copyfileobj(f, o)
        os.remove(tmp)
        tmp = path + ".x"
    if sha:
        got = hashlib.sha256(open(tmp, "rb").read()).hexdigest()
        if got != sha:
            sys.exit(f"{name}: sha256 {got}, expected {sha}")
    os.rename(tmp, path)
    return path


def frames(name, src, start, crop):
    d = os.path.join(DATA, "frames", name)
    if os.path.exists(f"{d}/f_0045.png"):
        return d
    os.makedirs(d, exist_ok=True)
    if name == "screen":
        raw = sorted(glob.glob(os.path.join(DATA, "screen", "*.png")))
        if len(raw) < 45:
            sys.exit("run node bench/showcase-screen.mjs first")
        inp = ["-framerate", "15", "-i", os.path.join(DATA, "screen", "%04d.png")]
    else:
        inp = ["-ss", str(start), "-t", "3", "-i", fetch(src)]
    vf = (f"crop={crop}," if crop else "") + f"fps=15,scale={WIDTH}:-2:flags=lanczos"
    subprocess.run(["ffmpeg", "-v", "error", "-y", *inp, "-vf", vf, "-frames:v", "45", f"{d}/f_%04d.png"], check=True)
    return d


def measure(gif, refs):
    timeline, _ = decode_timeline(gif, len(refs))
    return dict(bytes=os.path.getsize(gif), **score(refs, timeline))


def match(make, refs, target, out):
    """The lowest lessgif quality whose GIF scores at least `target`, by bisection."""
    lo, hi, best = 0, 100, None
    while lo <= hi:
        q = (lo + hi) // 2
        make(q, out + ".try")
        m = measure(out + ".try", refs)
        if m["s2"] >= target:
            best, hi = (q, m), q - 1
            os.replace(out + ".try", out)
        else:
            lo = q + 1
    if os.path.exists(out + ".try"):
        os.remove(out + ".try")
    q, m = best
    return dict(quality=q, **m)


def ffmpeg_gif(d, out):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "15", "-i", f"{d}/f_%04d.png",
                    "-lavfi", "split[a][b];[a]palettegen[p];[b][p]paletteuse", "-loop", "0", out], check=True)


def video_row(v):
    name, src, start, crop = v
    d = frames(name, src, start, crop)
    refs = sorted(glob.glob(f"{d}/f_*.png"))
    row = dict(name=name)
    ffmpeg_gif(d, f"{OUT}/{name}-ffmpeg.gif")
    row["ffmpeg"] = measure(f"{OUT}/{name}-ffmpeg.gif", refs)
    subprocess.run([GIFSKI, "-q", "--fps", "15", "-o", f"{OUT}/{name}-gifski.gif", *refs], check=True)
    row["gifski"] = measure(f"{OUT}/{name}-gifski.gif", refs)
    make = lambda q, o: subprocess.run([LESSGIF, d, o, "--fps", "15", "--quality", str(q)], check=True, capture_output=True)
    row["lessgif"] = match(make, refs, max(row["ffmpeg"]["s2"], row["gifski"]["s2"]), f"{OUT}/{name}-lessgif.gif")
    return row


def regif_row(name, inp):
    """Re-compress an existing GIF, scoring against the GIF's own frames."""
    ref = os.path.join(DATA, "frames", name + "-gif")
    shutil.rmtree(ref, ignore_errors=True)
    os.makedirs(ref)
    timeline, _ = decode_timeline(inp, 45)
    for i, f in enumerate(timeline):
        Image.fromarray(f).save(f"{ref}/f_{i + 1:04d}.png")
    refs = sorted(glob.glob(f"{ref}/f_*.png"))
    row = dict(name=name, input=dict(bytes=os.path.getsize(inp)))
    subprocess.run([GIFSICLE, "-O3", "--lossy=35", inp, "-o", f"{OUT}/{name}-gifsicle.gif"], check=True)
    row["gifsicle"] = measure(f"{OUT}/{name}-gifsicle.gif", refs)
    make = lambda q, o: subprocess.run([LESSGIF, inp, o, "--quality", str(q)], check=True, capture_output=True)
    row["lessgif"] = match(make, refs, row["gifsicle"]["s2"], f"{OUT}/{name}-lessgif.gif")
    return row


TITLES = {
    "bunny": "Cartoon: Big Buck Bunny",
    "steel": "Live action: Tears of Steel",
    "screen": "Screen recording: this project's website",
}


def readme_section(rows):
    """The README's comparison section, written between its <!-- showcase --> markers."""
    kb = lambda b: f"{b / 1024:,.0f} KB"
    cell = lambda name, t: f'<img src="docs/compare/{name}-{t}.gif" width="280" alt="{t}">'
    out = []
    for r in rows:
        name = r["name"]
        if name.endswith("-regif"):
            first = name[: -len("-regif")]
            out.append("#### Re-compressing a GIF: ffmpeg's GIF from the first row, scored against itself\n")
            out.append("| input (ffmpeg) | gifsicle `-O3 --lossy=35` | lessgif |\n|---|---|---|")
            out.append(f"| {cell(first, 'ffmpeg')} | {cell(name, 'gifsicle')} | {cell(name, 'lessgif')} |")
            g, o = r["gifsicle"], r["lessgif"]
            out.append(f"| {kb(r['input']['bytes'])} | {kb(g['bytes'])}, score {g['s2']:.1f} | **{kb(o['bytes'])}**, score {o['s2']:.1f}"
                       f"<br>{1 - o['bytes'] / g['bytes']:.0%} smaller than gifsicle |\n")
            continue
        out.append(f"#### {TITLES[name]}\n")
        out.append("| ffmpeg | gifski | lessgif |\n|---|---|---|")
        out.append("| " + " | ".join(cell(name, t) for t in ("ffmpeg", "gifski", "lessgif")) + " |")
        f, g, o = r["ffmpeg"], r["gifski"], r["lessgif"]
        out.append(f"| {kb(f['bytes'])}, score {f['s2']:.1f} | {kb(g['bytes'])}, score {g['s2']:.1f} | **{kb(o['bytes'])}**, score {o['s2']:.1f}"
                   f"<br>{1 - o['bytes'] / g['bytes']:.0%} smaller than gifski,<br>{1 - o['bytes'] / f['bytes']:.0%} smaller than ffmpeg |\n")
    return "\n".join(out)


def write_readme(rows):
    path = os.path.join(HERE, "..", "README.md")
    text = open(path).read()
    a, b = "<!-- showcase -->\n", "<!-- /showcase -->"
    if a in text and b in text:
        head, rest = text.split(a, 1)
        text = head + a + "\n" + readme_section(rows) + "\n" + b + rest.split(b, 1)[1]
        open(path, "w").write(text)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name in SOURCES:
        fetch(name)
    with Pool(len(VIDEOS)) as p:
        rows = p.map(video_row, VIDEOS)
    first = VIDEOS[0][0]
    rows.append(regif_row(first + "-regif", f"{OUT}/{first}-ffmpeg.gif"))
    json.dump(rows, open(os.path.join(DATA, "results.json"), "w"), indent=1)
    write_readme(rows)
    kb = lambda r: f"{r['bytes'] / 1024:.0f} KB"
    for r in rows:
        tools = [t for t in ("input", "ffmpeg", "gifski", "gifsicle", "lessgif") if t in r]
        print(r["name"] + ": " + ", ".join(f"{t} {kb(r[t])}" + (f" (S2 {r[t]['s2']:.1f})" if "s2" in r[t] else "") for t in tools)
              + f"; lessgif quality {r['lessgif']['quality']}")


if __name__ == "__main__":
    main()
