"""lessgif vs gifski at equal visual quality, on the 363 clips in clips.csv.

  sh bench/fetch.sh                  # source videos -> bench/data/sources (about 1.6 GB)
  python3 bench/compare.py extract   # 3 s clips -> bench/data/clips/<clip>/f_0001.png ... f_0045.png
  python3 bench/compare.py run       # every encode, resumable -> bench/data/results.jsonl
  python3 bench/compare.py report    # the table in the README

Each clip is encoded at several settings by both encoders (a rate-quality curve per clip and
encoder), every GIF is decoded and scored with SSIMULACRA2 against the source frames, and the
size each encoder needs to reach a target score is interpolated on its curve. The saving at a
target is 1 - ours/gifski for each clip; the report gives the median over clips.

Needs: python3 with numpy and Pillow, ffmpeg, gifski, ssimulacra2_rs (cargo install
ssimulacra2_rs), optionally dssim (cargo install dssim) for a second metric, and a release
build of lessgif (cargo build --release). Tools are found on PATH, or set LESSGIF, GIFSKI,
SSIMULACRA2, DSSIM. JOBS sets the number of parallel encodes (default: all cores).
Every encode runs on one thread, so the timings compare single-core speed.
"""

import csv, glob, json, os, random, shutil, subprocess, sys, tempfile, time
import numpy as np
from multiprocessing import Pool
from PIL import Image, ImageSequence

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RES = os.path.join(DATA, "results.jsonl")
LESSGIF = os.environ.get("LESSGIF", os.path.join(HERE, "..", "target", "release", "lessgif"))
GIFSKI = os.environ.get("GIFSKI", "gifski")
S2 = os.environ.get("SSIMULACRA2", "ssimulacra2_rs")
DSSIM = os.environ.get("DSSIM", shutil.which("dssim") or "")
JOBS = int(os.environ.get("JOBS", os.cpu_count() or 4))

# lessgif --lambda/--tbias pairs (from low to high quality), and gifski --quality values.
# Dense on both sides: with few points, interpolating across a wide gap misjudges the curve.
OURS = [(400, 260), (200, 260), (130, 195), (90, 130), (60, 97.5), (45, 97.5), (30, 97.5), (20, 65), (0, 26)]
GIFSKI_Q = [50, 60, 70, 75, 80, 85, 88, 90, 92, 95, 100]
TARGETS = [50, 60, 70, 80]


def clips():
    with open(os.path.join(HERE, "clips.csv")) as f:
        return list(csv.DictReader(f))


def extract_one(c):
    d = os.path.join(DATA, "clips", c["clip"])
    if os.path.exists(f"{d}/f_0045.png"):
        return
    os.makedirs(d, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", c["start_seconds"], "-t", "3", "-i", os.path.join(DATA, "sources", c["source"]),
                    "-vf", "fps=15,scale='if(gte(iw,ih),min(400,iw),-2)':'if(gte(iw,ih),-2,min(400,ih))':flags=lanczos",
                    "-frames:v", "45", f"{d}/f_%04d.png"], check=True)


def extract():
    with Pool(JOBS) as p:
        p.map(extract_one, clips())
    short = [c["clip"] for c in clips() if len(glob.glob(os.path.join(DATA, "clips", c["clip"], "f_*.png"))) != 45]
    print(f"{len(clips()) - len(short)} clips ready" + (f"; {len(short)} came out short: {short}" if short else ""))


def decode_timeline(path, n):
    """The GIF's frames at n evenly spaced times, so merged or dropped frames are judged fairly."""
    im = Image.open(path)
    fr, du = [], []
    for f in ImageSequence.Iterator(im):
        fr.append(np.asarray(f.convert("RGB")))
        du.append(max(f.info.get("duration", 100), 10))
    ends = np.cumsum(du)
    return [fr[int(np.searchsorted(ends, (i + 0.5) / n * ends[-1], side="right"))] for i in range(n)], fr


def score(srcpaths, frames):
    """Mean SSIMULACRA2 (and DSSIM) over every third frame."""
    s2, ds = [], []
    with tempfile.TemporaryDirectory() as td:
        for i in range(0, len(srcpaths), 3):
            tp = f"{td}/f{i}.png"
            Image.fromarray(frames[i]).save(tp, compress_level=0)
            r = subprocess.run([S2, "image", srcpaths[i], tp], capture_output=True, text=True, check=True)
            s2.append(float(r.stdout.split(":")[1]))
            if DSSIM:
                r = subprocess.run([DSSIM, srcpaths[i], tp], capture_output=True, text=True, check=True)
                ds.append(float(r.stdout.split()[0]))
    out = dict(s2=float(np.mean(s2)), s2_min=float(np.min(s2)))
    if ds:
        out["dssim"] = float(np.mean(ds))
    return out


def run_one(job):
    clip, enc, setting = job
    d = os.path.join(DATA, "clips", clip)
    srcpaths = sorted(glob.glob(f"{d}/f_*.png"))
    row = dict(clip=clip, enc=enc, setting=setting)
    with tempfile.TemporaryDirectory() as td:
        gif, dump = f"{td}/o.gif", f"{td}/dump.raw"
        t0 = time.perf_counter()
        if enc == "gifski":
            r = subprocess.run([GIFSKI, "-q", "--fps", "15", "--quality", str(setting), "-o", gif, *srcpaths],
                               env=dict(os.environ, RAYON_NUM_THREADS="1"), capture_output=True, text=True)
        else:
            lam, tb = setting
            # LESSGIF_DUMP: the encoder writes the exact frames it means the GIF to show
            r = subprocess.run([LESSGIF, d, gif, "--fps", "15", "--lambda", str(lam), "--tbias", str(tb), "--threads", "1"],
                               env=dict(os.environ, LESSGIF_DUMP=dump), capture_output=True, text=True)
        row["seconds"] = round(time.perf_counter() - t0, 3)
        if r.returncode != 0:
            row["error"] = r.stderr[-300:]
            return row
        row["bytes"] = os.path.getsize(gif)
        timeline, raw = decode_timeline(gif, len(srcpaths))
        if enc == "lessgif":  # does Pillow decode exactly what the encoder intended?
            h, w = raw[0].shape[:2]
            intended = np.fromfile(dump, np.uint8).reshape(-1, h, w, 3)
            row["exact"] = len(intended) == len(raw) and all(np.array_equal(a, b) for a, b in zip(intended, raw))
        row.update(score(srcpaths, timeline))
    return row


def load():
    if not os.path.exists(RES):
        return []
    return [json.loads(line) for line in open(RES)]


def run():
    done = {(r["clip"], r["enc"], json.dumps(r["setting"])) for r in load() if "error" not in r}
    jobs = [(c["clip"], "gifski", q) for c in clips() for q in GIFSKI_Q] + [(c["clip"], "lessgif", s) for c in clips() for s in OURS]
    jobs = [j for j in jobs if (j[0], j[1], json.dumps(list(j[2]) if isinstance(j[2], tuple) else j[2])) not in done]
    random.seed(1)
    random.shuffle(jobs)  # mixes slow and fast encodes, so the progress rate means something
    print(f"{len(jobs)} encodes to run on {JOBS} workers", flush=True)
    t0, errors = time.time(), 0
    with open(RES, "a") as log, Pool(JOBS) as p:
        for i, r in enumerate(p.imap_unordered(run_one, jobs)):
            errors += "error" in r
            log.write(json.dumps(r) + "\n")
            log.flush()
            if (i + 1) % 200 == 0 or i + 1 == len(jobs):
                print(f"{i + 1}/{len(jobs)} ({time.time() - t0:.0f} s, {errors} errors)", flush=True)


def interp_size(points, target):
    """Bytes needed to reach `target` on the clip's curve: monotone hull, log-linear between points."""
    hull = []
    for b, q in sorted(points):
        if not hull or q > hull[-1][1]:
            hull.append((b, q))
    for (b0, q0), (b1, q1) in zip(hull, hull[1:]):
        if q0 <= target <= q1:
            t = (target - q0) / (q1 - q0) if q1 > q0 else 0
            return float(np.exp(np.log(b0) + t * (np.log(b1) - np.log(b0))))
    return None  # outside the measured range


def curves(rows, key):
    by = {}
    for r in rows:
        if key == "dssim":
            if "dssim" not in r:
                continue
            q = -np.log10(max(r["dssim"], 1e-6))
        else:
            q = r[key]
        by.setdefault(r["clip"], {}).setdefault(r["enc"], []).append((r["bytes"], q))
    return by


def ratios(by, target):
    out = {}
    for clip, e in by.items():
        if "lessgif" in e and "gifski" in e:
            a, b = interp_size(e["lessgif"], target), interp_size(e["gifski"], target)
            if a and b:
                out[clip] = a / b
    return out


def report():
    rows = [r for r in load() if "error" not in r]
    errors = sum("error" in r for r in load())
    ours = [r for r in rows if r["enc"] == "lessgif"]
    print(f"{len({r['clip'] for r in rows})} clips, {len(rows)} encodes, {errors} errors; "
          f"lessgif output decoded exactly as intended: {sum(r.get('exact', False) for r in ours)} of {len(ours)}")
    print("\nSize of lessgif's GIF vs gifski's at the same SSIMULACRA2 (median over clips):")
    print("| SSIMULACRA2 | clips | median saving | geometric mean | lessgif smaller on |")
    print("|---|---|---|---|---|")
    by = curves(rows, "s2")
    for t in TARGETS:
        r = np.array(list(ratios(by, t).values()))
        if len(r):
            print(f"| {t} | {len(r)} | {1 - np.median(r):.1%} | {1 - np.exp(np.mean(np.log(r))):.1%} | {np.mean(r < 1):.0%} |")
    r70 = ratios(by, 70)
    src = {}
    for clip, x in r70.items():
        src.setdefault(clip.split("_")[0], []).append(x)
    print("\nAt SSIMULACRA2 70 by source: " + ", ".join(f"{k} {1 - np.median(v):.1%} ({len(v)} clips)" for k, v in sorted(src.items())))
    worst = sorted(r70.items(), key=lambda kv: -kv[1])[:3]
    print("Closest clips at 70: " + ", ".join(f"{c} {1 - x:.1%}" for c, x in worst))
    gd = [r for r in rows if r["enc"] == "gifski" and r["setting"] == 90 and "dssim" in r]
    if gd:
        tgt = float(np.median([-np.log10(r["dssim"]) for r in gd]))
        d = np.array(list(ratios(curves(rows, "dssim"), tgt).values()))
        print(f"At equal DSSIM ({10 ** -tgt:.5f}, gifski quality 90's median): {1 - np.median(d):.1%} smaller (median of {len(d)} clips)")
    for e in ("lessgif", "gifski"):
        s = [r["seconds"] for r in rows if r["enc"] == e]
        broken = np.mean([r["s2_min"] < 0 for r in rows if r["enc"] == e])
        print(f"{e}: median {np.median(s):.2f} s per clip on one core; encodes with a frame scoring below 0: {broken:.1%}")


if __name__ == "__main__":
    cmds = {"extract": extract, "run": run, "report": report}
    if len(sys.argv) != 2 or sys.argv[1] not in cmds:
        sys.exit(__doc__)
    os.makedirs(DATA, exist_ok=True)
    cmds[sys.argv[1]]()
