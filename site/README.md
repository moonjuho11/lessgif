# The lessgif website

GIF tools that run in the visitor's browser: video to GIF, images to GIF, compress, resize, crop,
cut, speed, reverse, rotate and flip, add text, split into frames, and GIF to MP4, plus a download
page for the app. Files are never uploaded; the pages are static, so any static host can serve
them.

## Build and try it

```sh
sh web/build.sh                      # the WebAssembly encoder (needs the wasm32 Rust target)
node site/build.mjs                  # writes site/dist
python3 -m http.server -d site/dist  # then open http://localhost:8000
```

`site/build.mjs` wraps each page in `pages/` with `layout.html`, copies `assets/` and
`static/`, adds the encoder from `web/`, and writes `sitemap.xml` and `robots.txt`. It has no
dependencies. Settings are in `site.config.json`:

- `baseUrl`: the address the site will live at, used for search engines (the `LESSGIF_BASE_URL`
  environment variable overrides it);
- `repo`: the GitHub repository the download links point to;
- `adsense.client` and `adsense.slots`: an AdSense publisher ID (`ca-pub-...`) and ad unit IDs.
  While `client` is empty there are no ads, no ad scripts and no cookies. Once it is set, the
  build adds the AdSense script, fills the three ad spaces (`top`, `result` beside each tool's
  result, and `side` on wide screens), writes `ads.txt`, and switches the privacy page to its
  advertising text. Add `?ads=preview` to any page's address to see where the ads go.

## How it fits together

- `assets/app.js`: the parts every tool page shares (file picking, previews, output settings,
  progress, results, passing a result to another tool through IndexedDB).
- `assets/worker.js`: runs in a worker. Reads GIFs, applies edits and runs the encoder;
  frames are moved between page and worker without copying.
- `assets/gifdecode.js`: a GIF reader in plain JavaScript that shows frames exactly as Chrome
  does, so every browser gets the same frames and exact palette colours.
- `assets/ops.js` and `assets/resample.js`: the edits (cut, speed, reverse, drop frames, crop,
  rotate, flip, resize, and drawing a picture such as text over chosen frames).
- `assets/load.js`: reading videos (by seeking a `<video>`), still images, and animated WebP
  and PNG (through the browser's `ImageDecoder` where available).
- `assets/zip.js`: a ZIP writer for the split tool (PNG and JPG are already compressed, so files
  are stored as they are).
- `assets/mp4mux.js`: an MP4 writer for GIF to MP4. The browser's own video encoder (WebCodecs)
  makes H.264, or VP9 where H.264 isn't available, and each GIF frame becomes one video frame
  with its own duration.
- `assets/fonts/`: Anton, the meme font of the add-text tool (SIL Open Font License, see
  `OFL.txt`).
- `assets/tools/*.js`: one small script per page.

Each tool keeps every frame in memory as RGBA, so the browser version limits the total number
of pixels to what the device can hold (based on `navigator.deviceMemory`); the app has no such
limit.

## Tests

```sh
node site/test/unit.mjs              # edits, resizer, GIF reader
sh site/test/make-fixtures.sh        # test inputs (needs ffmpeg and Python with Pillow)
node site/test/e2e.mjs               # every page in Chromium (needs Playwright)
```

`e2e.mjs` uploads files to each page, runs it, and decodes the GIF the page made: crop, cut,
speed, reverse and rotate at quality 100 must match the expected frames exactly. Split must give
back every frame exactly as PNG, and GIF to MP4 must write one video frame per GIF frame with the
same timing, in a file the browser plays. Playwright's own Chromium has no H.264 encoder, so
there GIF to MP4 makes VP9; to test H.264 as well, point `CHROME` at a Chrome or Chrome for
Testing binary. Screenshots land in `site/test/out/`. `site/test/decoder/` holds the checks of
the GIF reader against Chromium's own decoder.

## Hosting

The `Website` workflow builds the site on every push and can publish it from `main`:

- **Cloudflare Pages** (recommended: free, unlimited bandwidth, and fine for a site with ads).
  Add the repository secrets `CLOUDFLARE_API_TOKEN` (a token with the "Cloudflare Pages: Edit"
  permission) and `CLOUDFLARE_ACCOUNT_ID`, and the variable `CLOUDFLARE_PROJECT` (any name, such
  as `lessgif`): the first run creates the Pages project. Then add your domain under the
  project's Custom domains. `static/_headers` sets Cloudflare's response headers.
- **GitHub Pages**: set Settings > Pages > Source to "GitHub Actions" and add the variable
  `PAGES_DEPLOY` = `true`. GitHub's terms don't allow sites run mainly for business, so move to
  another host before adding ads.

Set the variable `SITE_URL` to the site's real address. All links inside the site are
relative, so it also works from a sub-folder such as `user.github.io/lessgif/`.
