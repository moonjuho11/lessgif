#!/bin/sh
# Builds web/lessgif.wasm. Needs the wasm target: rustup target add wasm32-unknown-unknown
# Then serve the folder (module workers need http, not file://): python3 -m http.server -d web
set -e
cd "$(dirname "$0")/.."
cargo build -p lessgif-wasm --profile wasm --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/wasm/lessgif_wasm.wasm web/lessgif.wasm
echo "web/lessgif.wasm: $(wc -c < web/lessgif.wasm) bytes, $(gzip -9c web/lessgif.wasm | wc -c) gzipped"
