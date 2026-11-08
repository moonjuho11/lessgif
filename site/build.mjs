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

// Each tool page's name as search engines and AI assistants should show it.
const TOOL_NAMES = {
  'video-to-gif/': 'Video to GIF converter',
  'maker/': 'GIF maker',
  'compress/': 'GIF compressor',
  'resize/': 'GIF resizer',
  'crop/': 'GIF cropper',
  'cut/': 'GIF cutter',
  'speed/': 'GIF speed changer',
  'reverse/': 'GIF reverser',
  'rotate/': 'GIF rotator',
  'add-text/': 'Add text to GIF',
  'split/': 'GIF frame splitter',
  'gif-to-mp4/': 'GIF to MP4 converter',
};

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

// Plain text from a bit of page HTML, for structured data and llms.txt.
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/\{\{[^}]*\}\}/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Questions a page answers: each <h2> or <h3> ending in "?" inside a section with class "faq",
// with the paragraphs up to the next heading as its answer.
function faqOf(body) {
  const out = [];
  for (const sec of body.matchAll(/<section class="[^"]*\bfaq\b[^"]*">([\s\S]*?)<\/section>/g)) {
    const parts = sec[1].split(/(?=<h[23][^>]*>)/);
    for (const part of parts) {
      const m = part.match(/^<h[23][^>]*>([\s\S]*?)<\/h[23]>([\s\S]*)$/);
      if (!m) continue;
      const q = text(m[1]);
      const a = text(m[2]);
      if (q.endsWith('?') && a) out.push({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } });
    }
  }
  return out;
}

// schema.org structured data for a page, as one JSON-LD graph.
function structuredData(meta, body, path) {
  const url = `${base}/${path}`;
  const org = { '@type': 'Organization', '@id': `${base}/#org`, name: 'lessgif', url: `${base}/`, logo: `${base}/favicon.svg`, sameAs: [repoUrl] };
  const free = { '@type': 'Offer', price: '0', priceCurrency: 'USD' };
  const graph = [org];
  const crumbs = [{ '@type': 'ListItem', position: 1, name: 'lessgif', item: `${base}/` }];
  if (path === '') {
    graph.push({ '@type': 'WebSite', '@id': `${base}/#site`, name: 'lessgif', url: `${base}/`, description: meta.description, publisher: { '@id': `${base}/#org` } });
  }
  if (path === '' || path === 'download/') {
    graph.push({
      '@type': 'SoftwareApplication', '@id': `${base}/#app`, name: 'lessgif', url: `${base}/`,
      description: 'Open-source animated GIF encoder that turns videos into GIFs and compresses existing GIFs. In its published benchmark its GIFs are a median 50% smaller than gifski\'s and 40% smaller than gifsicle\'s lossy output at the same SSIMULACRA2 quality score.',
      applicationCategory: 'MultimediaApplication', applicationSubCategory: 'GIF encoder and compressor',
      operatingSystem: 'Windows, macOS, Linux, any modern web browser', softwareVersion: version,
      downloadUrl: `${base}/download/`, codeRepository: repoUrl, license: 'https://opensource.org/licenses/MIT',
      isAccessibleForFree: true, offers: free, publisher: { '@id': `${base}/#org` },
      featureList: NAV.map(([, label]) => label).join(', '),
    });
  }
  if (TOOL_NAMES[path]) {
    graph.push({
      '@type': 'WebApplication', '@id': `${url}#app`, name: `${TOOL_NAMES[path]} (lessgif)`, url,
      description: meta.description, applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Any; runs in a web browser', browserRequirements: 'Requires JavaScript and WebAssembly',
      isAccessibleForFree: true, offers: free, publisher: { '@id': `${base}/#org` },
      featureList: 'Runs in the browser, files are never uploaded, no watermark, no sign-up',
    });
  }
  if (meta.article) {
    graph.push({
      '@type': 'TechArticle', '@id': `${url}#article`, headline: meta.article, url, description: meta.description,
      author: { '@id': `${base}/#org` }, publisher: { '@id': `${base}/#org` },
      ...(meta.updated ? { dateModified: meta.updated } : {}),
    });
  }
  if (path) {
    crumbs.push({ '@type': 'ListItem', position: 2, name: TOOL_NAMES[path] || meta.title.replace(/ \| lessgif$/, ''), item: url });
    graph.push({ '@type': 'BreadcrumbList', itemListElement: crumbs });
  }
  const faq = faqOf(body);
  if (faq.length) graph.push({ '@type': 'FAQPage', '@id': `${url}#faq`, url, mainEntity: faq });
  // '<' is escaped so the JSON can never close the <script> element early
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

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
  // text that only applies with (or without) ads: <!--ads-->...<!--/ads-->, <!--noads-->...<!--/noads-->
  body = body.replace(ads ? /<!--noads-->[\s\S]*?<!--\/noads-->/g : /<!--ads-->[\s\S]*?<!--\/ads-->/g, '');
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
    head: structuredData(meta, body, path) + (ads ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${esc(ads.client)}" crossorigin="anonymous"></script>` : ''),
    script: meta.script ? `<script type="module" src="${rel}assets/tools/${meta.script}.js"></script>` : '',
    adsOn: ads ? '1' : '',
    csp,
  };
  body = body.replace(/\{\{ad:(\w+)\}\}/g, (_, n) => adSlot(n));
  let html = layout.replace('{{content}}', () => body);
  html = html.replace(/\{\{ad:(\w+)\}\}/g, (_, n) => adSlot(n));
  html = html.replace(/\{\{(\w+)\}\}/g, (all, k) => (k in vars ? vars[k] : all));
  const left = html.match(/\{\{[^}]*\}\}/);
  if (left) throw new Error(`${file}: unknown template variable ${left[0]}`);
  const dest = join(out, path, 'index.html');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, html);
  if (!meta.noindex) pages.push({ path, title: meta.title, description: meta.description });
}

cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });
// the side-by-side GIFs from the README, shown on the comparison page
cpSync(join(root, 'docs', 'compare'), join(out, 'assets', 'compare'), { recursive: true });
cpSync(join(root, 'web', 'lessgif.js'), join(out, 'assets', 'lessgif.js'));
cpSync(wasm, join(out, 'assets', 'lessgif.wasm'));
cpSync(join(here, 'static'), out, { recursive: true });
writeFileSync(join(out, '_headers'), readFileSync(join(out, '_headers'), 'utf8').replace(/\{\{csp\}\}/g, csp));

writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${base}/${p.path}</loc></url>`).join('\n')}
</urlset>
`);
// Every crawler is welcome, including AI search and assistant crawlers (GPTBot, OAI-SearchBot,
// ClaudeBot, PerplexityBot, Google-Extended): the site is free tools and public benchmark numbers.
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);

// llms.txt (https://llmstxt.org): a plain summary of the site for AI assistants and agents.
const pageLine = (p) => `- [${p.title.replace(/ \| lessgif$/, '')}](${base}/${p.path}): ${p.description}`;
const isTool = (p) => TOOL_NAMES[p.path];
const llms = readFileSync(join(here, 'llms.txt'), 'utf8')
  .replace('{{tools}}', NAV.map(([p]) => pages.find((q) => q.path === p)).filter(Boolean).map(pageLine).join('\n'))
  .replace('{{more}}', pages.filter((p) => !isTool(p)).sort((a, b) => (a.path === '' ? -1 : b.path === '' ? 1 : 0)).map(pageLine).join('\n'))
  .replace(/\{\{base\}\}/g, base).replace(/\{\{repo\}\}/g, repoUrl).replace(/\{\{version\}\}/g, version);
writeFileSync(join(out, 'llms.txt'), llms);
if (ads) writeFileSync(join(out, 'ads.txt'), `google.com, ${ads.client.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n`);
console.log(`site/dist: ${pages.length} pages for ${base}${ads ? ', ads on' : ''}`);
