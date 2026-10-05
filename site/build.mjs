// Builds the static site into site/dist. No dependencies: node site/build.mjs
//
// Each file in pages/ starts with a JSON comment giving its title, description and URL path, and
// is wrapped in layout.html. Assets are copied as they are, plus the encoder (web/lessgif.js and
// web/lessgif.wasm, which `sh web/build.sh` makes). Settings, including the ad account, are in
// site.config.json; LESSGIF_BASE_URL overrides baseUrl.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'dist');
const cfg = JSON.parse(readFileSync(join(here, 'site.config.json'), 'utf8'));
const base = (process.env.LESSGIF_BASE_URL || cfg.baseUrl).replace(/\/$/, '');
const repoUrl = `https://github.com/${cfg.repo}`;
const ads = cfg.adsense?.client ? cfg.adsense : null;
// shown in the header and on the home page
const version = readFileSync(join(root, 'Cargo.toml'), 'utf8').match(/^version = "(.+)"$/m)[1];

const wasm = join(root, 'web', 'lessgif.wasm');
if (!existsSync(wasm)) {
  console.error('web/lessgif.wasm is missing: run `sh web/build.sh` first');
  process.exit(1);
}
const wasmKB = String(Math.round(statSync(wasm).size / 1024));

// Navigation, in order. `short` is the label in the top bar.
const NAV = [
  ['video-to-gif/', 'Video to GIF'],
  ['maker/', 'Images to GIF'],
  ['compress/', 'Compress'],
  ['resize/', 'Resize'],
  ['crop/', 'Crop'],
  ['cut/', 'Cut'],
  ['speed/', 'Speed'],
  ['reverse/', 'Reverse'],
  ['rotate/', 'Rotate'],
  ['add-text/', 'Add text'],
  ['split/', 'Split'],
  ['gif-to-mp4/', 'GIF to MP4'],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The Content-Security-Policy of every page, sent in a <meta> tag and, on Cloudflare, as a header
// (static/_headers). Only the site's own files may run; 'wasm-unsafe-eval' lets the encoder's
// WebAssembly compile, and pictures and videos the page makes itself are blob: URLs. Nothing can be
// sent to another site. AdSense loads code, pictures and frames from many Google hosts, so with ads
// on, those may come from any https: address.
const csp = [
  "default-src 'self'",
  ads ? "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' 'unsafe-eval' https:" : "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob:${ads ? ' https:' : ''}`,
  "media-src 'self' blob:",
  `connect-src 'self'${ads ? ' https:' : ''}`,
  ...(ads ? ['frame-src https:'] : []),
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function adSlot(name) {
  if (!ads) return `<div class="ad ad-${name}" data-ad="${name}" hidden></div>`;
  return `<div class="ad ad-${name}" data-ad="${name}"><ins class="adsbygoogle" style="display:block" data-ad-client="${esc(ads.client)}" data-ad-slot="${esc(ads.slots?.[name] || '')}" data-ad-format="auto" data-full-width-responsive="true"></ins></div>`;
}

const layout = readFileSync(join(here, 'layout.html'), 'utf8');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const pages = [];
for (const file of readdirSync(join(here, 'pages')).sort()) {
  if (!file.endsWith('.html')) continue;
  const src = readFileSync(join(here, 'pages', file), 'utf8');
  const m = src.match(/^<!--\s*(\{[\s\S]*?\})\s*-->\s*/);
  if (!m) throw new Error(`${file}: missing the JSON header comment`);
  const meta = JSON.parse(m[1]);
  let body = src.slice(m[0].length);
  const path = meta.path; // '' for the home page, 'compress/' for a tool
  const depth = path.split('/').filter(Boolean).length;
  const rel = depth ? '../'.repeat(depth) : './';
  const nav = NAV.map(([p, label]) => `<a href="${rel}${p}"${p === path ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const vars = {
    title: esc(meta.title),
    description: esc(meta.description),
    canonical: `${base}/${path}`,
    base,
    root: rel,
    nav,
    repo: repoUrl,
    repoName: esc(cfg.repo),
    year: String(new Date().getUTCFullYear()),
    version: esc(version),
    wasmKB,
    head: ads ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${esc(ads.client)}" crossorigin="anonymous"></script>` : '',
    script: meta.script ? `<script type="module" src="${rel}assets/tools/${meta.script}.js"></script>` : '',
    adsOn: ads ? '1' : '',
    csp,
  };
  // text that only applies with (or without) ads: <!--ads-->...<!--/ads-->, <!--noads-->...<!--/noads-->
  body = body.replace(ads ? /<!--noads-->[\s\S]*?<!--\/noads-->/g : /<!--ads-->[\s\S]*?<!--\/ads-->/g, '');
  body = body.replace(/\{\{ad:(\w+)\}\}/g, (_, n) => adSlot(n));
  let html = layout.replace('{{content}}', () => body);
  html = html.replace(/\{\{ad:(\w+)\}\}/g, (_, n) => adSlot(n));
  html = html.replace(/\{\{(\w+)\}\}/g, (all, k) => (k in vars ? vars[k] : all));
  const left = html.match(/\{\{[^}]*\}\}/);
  if (left) throw new Error(`${file}: unknown template variable ${left[0]}`);
  const dest = join(out, path, 'index.html');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, html);
  if (!meta.noindex) pages.push(path);
}

cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });
cpSync(join(root, 'web', 'lessgif.js'), join(out, 'assets', 'lessgif.js'));
cpSync(wasm, join(out, 'assets', 'lessgif.wasm'));
cpSync(join(here, 'static'), out, { recursive: true });
writeFileSync(join(out, '_headers'), readFileSync(join(out, '_headers'), 'utf8').replace(/\{\{csp\}\}/g, csp));

writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${base}/${p}</loc></url>`).join('\n')}
</urlset>
`);
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
if (ads) writeFileSync(join(out, 'ads.txt'), `google.com, ${ads.client.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n`);
console.log(`site/dist: ${pages.length} pages for ${base}${ads ? ', ads on' : ''}`);
