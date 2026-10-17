const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..'), output = path.join(root, 'work', 'preferences');
  await fs.mkdir(output, { recursive: true });
  const stateDirectory = await fs.mkdtemp(path.join(output, 'run-'));
  const file = path.join(stateDirectory, 'preferences.json');
  const chosenDirectory = path.join(stateDirectory, 'chosen');
  await fs.mkdir(chosenDirectory);
  await fs.writeFile(file, JSON.stringify({ directory: stateDirectory }));
  const env = { ...process.env, ONRECORD_TEST_PREFERENCES: file };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ONRECORD_TEST_OUTPUT;
  let app;
  async function launch() {
    app = await electron.launch({ ...(env.ONRECORD_EXECUTABLE ? { executablePath: env.ONRECORD_EXECUTABLE, args: [] } : { args: [root] }), env });
    await app.firstWindow();
    let page;
    for (let n = 0; n < 200 && !page; n++) { page = app.windows().find((window) => window.url().endsWith('/index.html')); if (!page) await new Promise((resolve) => setTimeout(resolve, 50)); }
    assert.ok(page);
    await page.waitForSelector('body[data-ready="true"]');
    return page;
  }
  try {
    let page = await launch();
    const layout = await page.evaluate(() => {
      const strip = document.querySelector('.record-strip').getBoundingClientRect(), preview = document.querySelector('#preview-stage').getBoundingClientRect(), settings = document.querySelector('.settings').getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, top: strip.top, previewBottom: preview.bottom, stripRight: strip.right, settingsLeft: settings.left, headings: document.querySelectorAll('.section-heading,.live-badge,.notice,.region-help,footer,#audio-quality').length };
    });
    assert.deepEqual([layout.width, layout.height], [980, 600]);
    assert.equal(layout.headings, 0);
    assert.ok(layout.top >= layout.previewBottom && layout.stripRight < layout.settingsLeft);
    await page.locator('#resolution').selectOption('720');
    await page.locator('#fps').selectOption('60');
    await page.locator('#quality').selectOption('standard');
    await page.locator('#format').selectOption('webm');
    await page.locator('#delay').selectOption('0');
    await page.locator('#webcam-position').evaluate((input) => { input.value = 'top-left'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, chosenDirectory);
    await page.locator('#choose-folder').click();
    const regionEvent = app.waitForEvent('window');
    await page.locator('[data-mode="region"]').click();
    const region = await regionEvent;
    await page.waitForFunction(() => document.querySelector('#preview').width > 2 && !document.querySelector('#record').disabled);
    await region.evaluate(() => window.onrecord.updateRegion({ action: 'resize', rect: { x: 150, y: 180, width: 640, height: 360 } }));
    await page.waitForFunction(() => document.querySelector('#preview').width === 640 && document.querySelector('#preview').height === 360);
    await page.evaluate(() => window.onrecord.preferences());
    // Close immediately: pending debounced settings must still be flushed.
    await app.close(); app = null;
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.format, 'webm'); assert.equal(saved.fps, '60');
    assert.equal(saved.resolution, '720'); assert.equal(saved.quality, 'standard');
    assert.equal(saved.directory, chosenDirectory); assert.equal(saved.webcamPosition, 'top-left');
    assert.deepEqual(saved.region.rect, { x: 150, y: 180, width: 640, height: 360 });
    assert.equal(saved.captureMode, 'region');
    page = await launch();
    const restored = await page.evaluate(() => ({ format: document.querySelector('#format').value, fps: document.querySelector('#fps').value, quality: document.querySelector('#quality').value, resolution: document.querySelector('#resolution').value, delay: document.querySelector('#delay').value, webcamPosition: document.querySelector('#webcam-position').value, directory: document.querySelector('#directory').title, mode: document.querySelector('[data-mode].selected').dataset.mode, width: document.querySelector('#preview').width, height: document.querySelector('#preview').height, canRecord: !document.querySelector('#record').disabled }));
    assert.deepEqual(restored, { format: 'webm', fps: '60', quality: 'standard', resolution: '720', delay: '0', webcamPosition: 'top-left', directory: chosenDirectory, mode: 'region', width: 640, height: 360, canRecord: true });
    const restoredBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'OnRecord 녹화 영역').getBounds());
    assert.deepEqual(restoredBounds, { x: 138, y: 144, width: 664, height: 408 });
    await page.screenshot({ path: path.join(output, 'restored.png') });
    await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#timer').textContent >= '00:00:02');
    await page.locator('#record').click();
    await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
    const video = await page.locator('#result-path').getAttribute('title');
    assert.ok(video.startsWith(chosenDirectory)); assert.ok(video.endsWith('.webm'));
    const probe = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-i', video], { windowsHide: true, encoding: 'utf8' });
    assert.match(probe.stderr, /Audio: opus/);
    const decode = spawnSync(require('ffmpeg-static'), ['-v', 'error', '-i', video, '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' });
    assert.equal(decode.status, 0, decode.stderr);
    await app.close(); app = null;
    const disconnected = JSON.parse(await fs.readFile(file, 'utf8'));
    disconnected.region = { displayId: 'removed-monitor', rect: { x: 3500, y: 180, width: 640, height: 360 } };
    await fs.writeFile(file, JSON.stringify(disconnected));
    page = await launch();
    const fallback = await app.evaluate(({ BrowserWindow, screen }) => ({ region: BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'OnRecord 녹화 영역').getBounds(), display: screen.getDisplayMatching(BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'OnRecord').getBounds()).bounds }));
    assert.ok(fallback.region.x + 12 >= fallback.display.x && fallback.region.x + 12 + 640 <= fallback.display.x + fallback.display.width);
    assert.equal(await page.locator('#record').isDisabled(), false);
    await page.locator('[data-mode="screen"]').click();
    await page.locator('.source-card').first().click();
    await page.waitForFunction(() => !document.querySelector('#record').disabled);
    await app.close(); app = null;
    page = await launch();
    assert.equal(await page.locator('[data-mode="screen"]').getAttribute('class'), 'selected');
    assert.equal(await page.locator('#record').isDisabled(), false);
    const report = { passed: true, file, restored, video, checks: ['compact layout without heading or footer', 'settings flushed on quit', 'real app restart restores settings, output directory and region', 'live preview ready without reselection', 'WebM records system audio as Opus using restored settings', 'removed monitor falls back within visible screen', 'full-screen capture target restores on restart'] };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { if (app) { console.error(await app.windows().find((page) => page.url().endsWith('/index.html'))?.locator('#toast').textContent().catch(() => '')); await app.evaluate(({ app }) => app.exit(1)).catch(() => {}); } throw error; }
  finally { if (app) await app.close().catch(() => {}); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
