#!/bin/sh
# Downloads the source videos listed in sources.txt into bench/data/sources (about 1.6 GB)
# and checks each one's SHA-256. Already-downloaded files are kept.
set -e
cd "$(dirname "$0")"
mkdir -p data/sources
grep -v '^#' sources.txt | while read -r url size sha; do
  f="data/sources/$(basename "$url")"
  if [ ! -s "$f" ]; then
    echo "downloading $(basename "$url") ($((size / 1048576)) MB)"
    curl -fL --retry 3 -A "lessgif-bench" -o "$f.part" "$url"
    mv "$f.part" "$f"
  fi
  got=$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d' ' -f1)
  if [ "$got" != "$sha" ]; then
    echo "WARNING: $(basename "$url") differs from the file the published results used (sha256 $got)"
  fi
done
echo "sources ready in bench/data/sources"
