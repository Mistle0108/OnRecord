const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  await fs.mkdir(path.join(root, 'work'), { recursive: true });
  const output = await fs.mkdtemp(path.join(root, 'work', 'controls-position-'));
  const file = path.join(output, 'preferences.json');
  const env = { ...process.env, ONRECORD_TEST_PREFERENCES: file, ONRECORD_TEST_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  async function launch() {
    const args = ['--user-data-dir=' + path.join(output, 'profile')];
    app = await electron.launch({ ...(env.ONRECORD_EXECUTABLE ? { executablePath: env.ONRECORD_EXECUTABLE, args } : { args: [root, ...args] }), env });
    await app.firstWindow();
    let page;
    for (let n = 0; n < 200 && !page; n++) {
      page = app.windows().find(window => window.url().endsWith('/index.html'));
      if (!page) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(page);
    await page.waitForSelector('body[data-ready="true"]');
    return page;
  }
  async function bounds() {
    return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/controls.html')).getBounds());
  }
  try {
    const page = await launch();
    const primary = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    const initial = await bounds();
    assert.equal(initial.x, primary.x + primary.width - 374);
    assert.equal(initial.y, primary.y + primary.height - 118);
    const target = await app.evaluate(({ BrowserWindow, screen }) => {
      const area = screen.getAllDisplays().at(-1).workArea;
      const position = { x: area.x + 80, y: area.y + 100 };
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/controls.html'));
      win.showInactive();
      win.setPosition(position.x, position.y);
      return position;
    });
    await page.waitForFunction(async expected => {
      const actual = (await window.onrecord.preferences()).controlsPosition;
      return actual?.x === expected.x && actual?.y === expected.y;
    }, target);
    // Quit before the debounce timer expires: the final position must still flush.
    await app.close(); app = null;
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(saved.controlsPosition, target);
    await launch();
    const restored = await bounds();
    assert.deepEqual({ x: restored.x, y: restored.y }, target);
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/controls.html'));
      win.showInactive(); win.hide(); win.showInactive();
    });
    assert.deepEqual(await bounds(), restored);
    await app.close(); app = null;
    saved.controlsPosition = { x: 999999, y: 999999 };
    await fs.writeFile(file, JSON.stringify(saved), 'utf8');
    await launch();
    const corrected = await bounds();
    const areas = await app.evaluate(({ screen }) => screen.getAllDisplays().map(display => display.workArea));
    assert.ok(areas.some(area => corrected.x >= area.x && corrected.y >= area.y && corrected.x + corrected.width <= area.x + area.width && corrected.y + corrected.height <= area.y + area.height));
    console.log(JSON.stringify({ passed: true, output, target, restored, corrected, checks: ['default position preserved', 'move saved and flushed on quit', 'restart restores position', 'hide/show preserves position', 'off-screen position constrained to visible work area'] }, null, 2));
  } finally { if (app) await app.close().catch(() => {}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
