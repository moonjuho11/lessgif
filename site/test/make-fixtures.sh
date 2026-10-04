#!/bin/sh
# Makes the inputs for e2e.mjs in site/test/fixtures (needs ffmpeg and Python with Pillow).
# Set FILM=<video> to also cut a real film clip; the synthetic ones are enough for the checks.
set -e
cd "$(dirname "$0")"
mkdir -p fixtures
cd fixtures
ff="ffmpeg -v error -y"
$ff -f lavfi -i testsrc2=size=640x360:rate=30 -t 4 -c:v libvpx-vp9 -b:v 1M -pix_fmt yuv420p clip.webm
$ff -i clip.webm -vf "fps=15,scale=320:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=255[p];[b][p]paletteuse" -loop 0 film.gif
if [ -n "$FILM" ]; then
  $ff -ss 60 -t 4 -i "$FILM" -an -c:v libvpx-vp9 -b:v 1.5M -vf scale=640:-2 real.webm
  $ff -i real.webm -vf "fps=15,scale=400:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 real.gif
fi
python3 - <<'PY'
from PIL import Image, ImageDraw
# transparent sticker with disposal 2 (clear to transparent), loops forever
fr = []
for i in range(12):
    im = Image.new('RGBA', (120, 96), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((10 + i * 6, 20, 50 + i * 6, 60), fill=(230, 60 + i * 12, 40, 255))
    d.rectangle((0, 80, 119, 95), fill=(30, 90, 200, 255))
    d.text((5, 2), f"frame {i}", fill=(20, 20, 20, 255))
    fr.append(im)
fr[0].save('sticker.gif', save_all=True, append_images=fr[1:], duration=[60, 80, 100] * 4, loop=0, disposal=2)
# opaque GIF that plays once (no loop block)
fr = []
for i in range(8):
    im = Image.new('RGB', (64, 48), (240, 240, 240))
    ImageDraw.Draw(im).rectangle((i * 7, 10, i * 7 + 12, 30), fill=(10, 120, 60))
    fr.append(im)
fr[0].save('once.gif', save_all=True, append_images=fr[1:], duration=100)
# odd size with transparency and uneven timing, for GIF to MP4
fr = []
for i in range(10):
    im = Image.new('RGBA', (61, 45), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle((i * 4, 5, i * 4 + 15, 30), fill=(250, 200, 0, 255))
    fr.append(im)
fr[0].save('odd.gif', save_all=True, append_images=fr[1:], duration=[20, 30, 100, 40] * 2 + [70, 70], loop=0, disposal=2)
# stills of different shapes for the maker
Image.new('RGB', (300, 200), (200, 40, 40)).save('red.png')
im = Image.new('RGB', (200, 300), (40, 160, 60)); ImageDraw.Draw(im).ellipse((20, 20, 180, 180), fill=(250, 250, 250)); im.save('green.jpg', quality=92)
im = Image.new('RGBA', (240, 240), (0, 0, 0, 0)); ImageDraw.Draw(im).rectangle((40, 40, 200, 200), fill=(40, 60, 220, 255)); im.save('blue.webp', lossless=True)
PY
ls -l
