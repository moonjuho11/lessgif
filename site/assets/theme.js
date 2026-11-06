// Loaded in <head> before the page draws, so a visitor who picked the light theme never sees a
// flash of the dark one. The toggle itself is wired up in site.js.
try {
  if (localStorage.getItem('lessgif-theme') === 'light') document.documentElement.dataset.theme = 'light';
} catch {
  // storage blocked: stay on the default dark theme
}
