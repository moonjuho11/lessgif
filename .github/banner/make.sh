#!/bin/sh
# Makes the README banner (.github/banner.gif, encoded by lessgif itself) and the image GitHub
# shows when the repository is shared (.github/social-preview.png, uploaded by hand under
# Settings > General > Social preview). Needs Node with Playwright and a release build:
#   cargo build --release && sh .github/banner/make.sh
set -e
cd "$(dirname "$0")"
node render.mjs 32 frames
../../target/release/lessgif frames ../banner.gif --fps 12 --quality 80
node render.mjs 1 social social
cp social/0000.png ../social-preview.png
rm -rf frames social
