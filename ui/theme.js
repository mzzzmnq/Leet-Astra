// Follow explicit LeetCode theme markers first, then the browser's preference.
function installThemeSync(panel, launcher) {
  const targets = [panel, launcher].filter(Boolean);
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let active = false;
  const themeValue = value => /^(light|dark)$/.test(String(value || '').trim().toLowerCase())
    ? String(value).trim().toLowerCase() : null;

  function readTheme() {
    const roots = [document.documentElement, document.body].filter(Boolean);
    for (const root of roots) {
      for (const attribute of ['data-theme', 'data-color-mode']) {
        const theme = themeValue(root.getAttribute(attribute));
        if (theme) return theme;
      }
      const dark = root.classList.contains('dark');
      const light = root.classList.contains('light');
      if (dark !== light) return dark ? 'dark' : 'light';
    }
    // A two-value color-scheme advertises support; it does not select a theme.
    for (const root of roots) {
      const theme = themeValue(root.style.colorScheme);
      if (theme) return theme;
    }
    for (const root of roots) {
      const theme = themeValue(window.getComputedStyle(root).colorScheme);
      if (theme) return theme;
    }
    return media.matches ? 'dark' : 'light';
  }

  function sync() {
    if (!active) return;
    const theme = readTheme();
    for (const target of targets) {
      if (target.getAttribute('data-ocleet-theme') !== theme) {
        target.setAttribute('data-ocleet-theme', theme);
      }
    }
  }

  const observer = new MutationObserver(sync);
  function resume() {
    if (active) return;
    active = true;
    for (const root of [document.documentElement, document.body].filter(Boolean)) {
      observer.observe(root, {
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'data-color-mode', 'style'],
      });
    }
    if (media.addEventListener) media.addEventListener('change', sync);
    else media.addListener(sync);
    sync();
  }
  function pause() {
    active = false;
    observer.disconnect();
    if (media.removeEventListener) media.removeEventListener('change', sync);
    else media.removeListener(sync);
  }
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', resume);
  resume();
  return function dispose() {
    pause();
    window.removeEventListener('pagehide', pause);
    window.removeEventListener('pageshow', resume);
  };
}
