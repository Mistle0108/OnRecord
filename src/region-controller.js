const { ipcMain, screen, desktopCapturer } = require('electron');

const PADDING = 12, HEADER = 36, MIN_SIZE = 64;

module.exports = function createRegionController({ mainWindow, createWindow, onChanged, onClosed, readRegion, onRemember }) {
  let window, rect, display, sources = [], phase = 'idle';
  const trusted = (event) => event.sender === mainWindow.webContents;
  const fromRegion = (event) => event.sender === window?.webContents;

  function state() {
    const source = sources.find((item) => item.display_id === String(display.id));
    const bounds = display.bounds;
    return {
      rect: { ...rect }, phase, scaleFactor: display.scaleFactor, toolbarInside: rect.y - bounds.y < HEADER,
      source: { id: source.id, name: source.name, displayId: source.display_id, width: Math.round(bounds.width * display.scaleFactor), height: Math.round(bounds.height * display.scaleFactor) },
      crop: { x: (rect.x - bounds.x) / bounds.width, y: (rect.y - bounds.y) / bounds.height, width: rect.width / bounds.width, height: rect.height / bounds.height }
    };
  }
  function render(notify = true) {
    if (!window) return;
    window.setBounds({ x: rect.x - PADDING, y: rect.y - HEADER, width: rect.width + PADDING * 2, height: rect.height + HEADER + PADDING });
    // Native window shape leaves a real hole: interior clicks reach the app below.
    const x = PADDING - 6, y = HEADER - 6;
    const toolbarY = rect.y - display.bounds.y < HEADER ? HEADER + 6 : 0;
    window.setShape([
      { x, y, width: rect.width + 12, height: 12 },
      { x, y: HEADER + rect.height - 6, width: rect.width + 12, height: 12 },
      { x, y, width: 12, height: rect.height + 12 },
      { x: PADDING + rect.width - 6, y, width: 12, height: rect.height + 12 },
      { x: PADDING - 2, y: toolbarY, width: Math.min(292, rect.width + 4), height: HEADER }
    ]);
    const value = state();
    onRemember({ displayId: String(display.id), rect: { x: rect.x - display.bounds.x, y: rect.y - display.bounds.y, width: rect.width, height: rect.height } });
    window.webContents.send('region-state', value);
    if (notify) onChanged(value);
  }
  function constrain(next, moving) {
    const candidate = moving && phase === 'idle' ? screen.getDisplayNearestPoint({ x: Math.round(next.x + next.width / 2), y: Math.round(next.y + next.height / 2) }) : display;
    if (sources.some((item) => item.display_id === String(candidate.id))) display = candidate;
    const bounds = display.bounds;
    const width = Math.min(bounds.width, Math.max(MIN_SIZE, Math.round(next.width)));
    const height = Math.min(bounds.height, Math.max(MIN_SIZE, Math.round(next.height)));
    return { x: Math.round(Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, next.x))), y: Math.round(Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, next.y))), width, height };
  }
  async function show() {
    if (phase !== 'idle') return null;
    if (window) { window.showInactive(); return state(); }
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const saved = readRegion();
    display = screen.getAllDisplays().find((item) => String(item.id) === saved?.displayId) || screen.getDisplayMatching(mainWindow.getBounds());
    if (!sources.some((item) => item.display_id === String(display.id))) throw new Error('녹화할 화면을 찾지 못했습니다.');
    const bounds = display.workArea;
    const width = Math.min(960, Math.floor(bounds.width * .7)), height = Math.min(540, Math.floor(bounds.height * .65));
    rect = { x: bounds.x + Math.round((bounds.width - width) / 2), y: bounds.y + Math.max(HEADER, Math.round((bounds.height - height) / 2)), width, height };
    if (saved) rect = constrain({ x: display.bounds.x + saved.rect.x, y: display.bounds.y + saved.rect.y, width: saved.rect.width, height: saved.rect.height }, false);
    window = createWindow({ x: rect.x - PADDING, y: rect.y - HEADER, width: rect.width + PADDING * 2, height: rect.height + HEADER + PADDING, frame: false, transparent: true, show: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false, title: 'OnRecord 녹화 영역' }, 'region.html');
    window.on('close', (event) => { if (phase !== 'idle') event.preventDefault(); });
    window.on('closed', () => { window = null; onClosed(); });
    await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
    render(false);
    window.showInactive();
    return state();
  }
  function close(force = false) {
    if (!window || (!force && phase !== 'idle')) return;
    if (force) window.destroy(); else window.close();
  }

  ipcMain.handle('choose-region', (event) => trusted(event) ? show() : null);
  ipcMain.handle('close-region', (event) => { if (trusted(event) || fromRegion(event)) close(); });
  ipcMain.on('region-phase', (event, value) => {
    if (!trusted(event) || !['idle', 'starting', 'countdown', 'recording', 'saving'].includes(value)) return;
    phase = value;
    if (window) window.webContents.send('region-state', state());
  });
  ipcMain.on('update-region', (event, update) => {
    if (!fromRegion(event) || !['idle', 'recording'].includes(phase)) return;
    if (!update || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(update.rect?.[key]))) return;
    if (phase === 'recording' && (update.action !== 'move' || update.rect.width !== rect.width || update.rect.height !== rect.height)) return;
    rect = constrain(update.rect, update.action === 'move');
    render();
  });
  return { close };
};
