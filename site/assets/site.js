// Runs on every page: fills the ad slots when an ad account is configured, and with ?ads=preview
// shows where the ads would go.
const slots = [...document.querySelectorAll('.ad')];
if (new URLSearchParams(location.search).get('ads') === 'preview') {
  document.body.dataset.ads = '1';
  for (const s of slots) {
    s.hidden = false;
    s.classList.add('preview');
    s.textContent = `ad: ${s.dataset.ad}`;
  }
} else if (document.body.dataset.ads === '1') {
  for (const s of slots) {
    if (s.querySelector('ins.adsbygoogle')) {
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch {
        // blocked by an ad blocker: the page works the same without ads
      }
    }
  }
}

// Light/dark toggle in the top bar. Dark is the default; the choice is remembered on this device.
const toggle = document.querySelector('.theme-toggle');
const themeColor = document.querySelector('meta[name="theme-color"]');
const showTheme = () => {
  const light = document.documentElement.dataset.theme === 'light';
  toggle?.setAttribute('aria-pressed', String(light));
  toggle?.setAttribute('title', light ? 'Switch to dark theme' : 'Switch to light theme');
  themeColor?.setAttribute('content', light ? '#f9f9f9' : '#0a0a0b');
};
showTheme();
toggle?.addEventListener('click', () => {
  const light = document.documentElement.dataset.theme !== 'light';
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  try {
    if (light) localStorage.setItem('lessgif-theme', 'light');
    else localStorage.removeItem('lessgif-theme');
  } catch {
    // storage blocked: the theme still changes for this page
  }
  showTheme();
});
