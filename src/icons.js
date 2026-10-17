// Shared 24px icons for the main window, recording controls and region frame.
window.recordIcons = (() => {
  const paths = {
    monitor: 'M4 4h16a1 1 0 0 1 1 1v11H3V5a1 1 0 0 1 1-1ZM8 21h8m-4-5v5',
    window: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM3 9h18M7 6.5h.01m3 0h.01',
    region: 'M8 3H3v5m13-5h5v5m0 8v5h-5M8 21H3v-5M8 8h8v8H8Z',
    speaker: 'M11 4 6 8H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
    camera: 'M4 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm11 4 6-3v10l-6-3',
    settings: 'm10 3-.6 2.4-2 .9-2.2-.7-2 3.4 1.6 1.8v2.4L3.2 15l2 3.4 2.2-.7 2 .9L10 21h4l.6-2.4 2-.9 2.2.7 2-3.4-1.6-1.8v-2.4L20.8 9l-2-3.4-2.2.7-2-.9L14 3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    folder: 'M3 7V5h7l2 3h9v12H3Zm0 1h9',
    minimize: 'M5 12h14',
    maximize: 'M5 5h14v14H5Z',
    restore: 'M8 8V4h12v12h-4M4 8h12v12H4Z',
    close: 'm6 6 12 12M18 6 6 18',
    down: 'm7 10 5 5 5-5',
    refresh: 'M20 10a8 8 0 1 0-1 7M20 4v6h-6',
    play: 'm9 5 11 7-11 7Z',
    pause: 'M8 5v14m8-14v14',
    stop: 'M6 6h12v12H6Z',
    record: 'M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
    move: 'M12 3v18M3 12h18m-12-6 3-3 3 3m-6 12 3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3',
    check: 'm5 12 4 4L19 6',
    more: 'M5 12h.01M12 12h.01M19 12h.01'
  };
  function create(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: ['record', 'stop', 'play'].includes(name) ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[name]);
    svg.append(path);
    return svg;
  }
  function set(target, name) {
    if (typeof target === 'string') target = document.querySelector(target);
    if (target) { target.dataset.icon = name; target.replaceChildren(create(name)); }
  }
  document.querySelectorAll('[data-icon]').forEach((target) => set(target, target.dataset.icon));
  return { create, set };
})();
