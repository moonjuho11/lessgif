# Benchmark: lessgif vs gifski

Reproduces the video-to-GIF numbers in the main README: how much smaller lessgif's GIFs are than
gifski's at the same SSIMULACRA2 score, on 363 three-second film clips.

## What you need

- the lessgif release build: `cargo build --release` in the repository root
- [gifski](https://gif.ski) (the published numbers used 1.34.0)
- [ssimulacra2_rs](https://github.com/rust-av/ssimulacra2_bin) (0.5.2): `cargo install ssimulacra2_rs`
- optionally [dssim](https://github.com/kornelski/dssim) for the second metric: `cargo install dssim`
- ffmpeg (6.1 was used), Python 3 with numpy and Pillow
- about 1.6 GB for the source videos and 1 GB for the extracted frames

## Run it

```sh
sh bench/fetch.sh                  # download the 28 source videos and check their hashes
python3 bench/compare.py extract   # cut the 363 clips into PNG frames
python3 bench/compare.py run       # 7,260 encodes; resumable
python3 bench/compare.py report
```

`run` takes a few hours on 4 cores (each encode is decoded and scored on 15 frames). It appends
to `bench/data/results.jsonl` and skips what is already there, so it can be stopped and
restarted. Set `JOBS` to change the number of parallel encodes.

## Method

- **Clips** (`clips.csv`): 150 from *Tears of Steel* and 150 from *Big Buck Bunny* at random
  start times, 15 from the *Sintel* trailer, and two from each of the 25 Xiph.org test sequences
  that are long enough (48). Each is 45 frames at 15 fps, scaled to at most 400 px.
- **Encodes.** lessgif at 9 `--lambda`/`--tbias` settings and gifski at 11 `--quality` levels
  (50 to 100), both at `--fps 15` on one thread.
- **Scoring.** Each GIF is decoded with Pillow and sampled at 45 evenly spaced times, so merged
  frames are judged by what is on screen. SSIMULACRA2 (and DSSIM) against the source PNG is
  averaged over every third frame.
- **Comparison.** For each clip and encoder, the bytes needed to reach a target score are
  interpolated on the upper hull of its size/score points (log-linear between neighbours). The
  saving is `1 - lessgif / gifski` per clip; the report gives the median and the geometric mean
  over the clips where both encoders reach the target.
- **Exactness.** lessgif writes the frames it intends to show to `LESSGIF_DUMP`; every lessgif
  encode records whether Pillow decoded exactly those frames.

Results depend a little on the versions of ffmpeg (frame extraction), gifski and the metrics.
`fetch.sh` warns if a downloaded source differs from the one the published numbers used.
