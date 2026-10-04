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
