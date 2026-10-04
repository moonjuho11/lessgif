// Highlights the download that matches this computer.
const ua = navigator.userAgent;
const os = /Windows/.test(ua) ? 'windows' : /Mac OS X|Macintosh/.test(ua) && !/iPhone|iPad/.test(ua) ? 'mac' : /Linux/.test(ua) && !/Android/.test(ua) ? (/aarch64|arm/i.test(ua) ? 'linux-arm' : 'linux') : null;
const a = os && document.querySelector(`[data-os="${os}"]`);
if (a) {
  a.classList.add('mine');
  a.querySelector('span').textContent += ' · for this computer';
}
