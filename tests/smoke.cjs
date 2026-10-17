const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'work', 'smoke');
  await fs.mkdir(output, { recursive: true });
  const env = { ...process.env, ONRECORD_TEST_OUTPUT: output, ONRECORD_TEST_PREFERENCES: path.join(await fs.mkdtemp(path.join(output, 'preferences-')), 'preferences.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ ...(process.env.ONRECORD_EXECUTABLE ? { executablePath: process.env.ONRECORD_EXECUTABLE, args: [] } : { args: [root] }), env });
  const errors = [];
  let target;
  try {
    await app.firstWindow();
    let page;
    for (let attempt = 0; attempt < 200 && !page; attempt++) {
      page = app.windows().find((window) => window.url().endsWith('/index.html'));
      if (!page) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(page, 'Main window must load');
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('body[data-ready="true"]');
    assert.equal(await page.title(), 'OnRecord');
    await page.screenshot({ path: path.join(output, '01-ready.png') });
    await page.locator('#system-audio').uncheck();
    await page.locator('#delay').selectOption('0');
    await page.locator('#empty-choose').click();
    await page.locator('.source-card').first().click();
    await page.waitForFunction(() => document.querySelector('#source-video').videoWidth > 0);
    assert.ok(await page.locator('#preview').evaluate((canvas) => canvas.width >= 2 && canvas.height >= 2));
    await page.screenshot({ path: path.join(output, '02-preview.png') });
    await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#record-label').textContent === '녹화 종료');
    const mainVisible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.getTitle() === 'OnRecord').isVisible());
    assert.equal(mainVisible, true);
    const controls = app.windows().find((win) => win.url().endsWith('/controls.html'));
    await controls.waitForSelector('#pause');
    await controls.waitForFunction(() => document.querySelector('#controls-timer').textContent >= '00:00:02');
    await controls.locator('#pause').click();
    await controls.waitForFunction(() => document.querySelector('#controls-label').textContent.includes('일시정지'));
    const paused = await controls.locator('#controls-timer').textContent();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await controls.locator('#controls-timer').textContent(), paused);
    await controls.screenshot({ path: path.join(output, '03-controls.png') });
    await controls.locator('#pause').click();
    await controls.waitForFunction(() => document.querySelector('#controls-label').textContent.includes('녹화 중'));
    await controls.locator('#stop').click();
    await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
    const saved = await page.locator('#result-path').getAttribute('title');
    assert.ok(saved.endsWith('.mp4'));
    assert.ok((await fs.stat(saved)).size > 1000);
    const decoded = spawnSync(require('ffmpeg-static'), ['-v', 'error', '-i', saved, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
    assert.equal(decoded.status, 0, decoded.stderr);
    await page.screenshot({ path: path.join(output, '04-saved.png') });
    target = await electron.launch({ args: [path.join(__dirname, 'capture-target.cjs')], env });
    const targetPage = await target.firstWindow();
    await targetPage.waitForSelector('h1');
    await targetPage.evaluate(() => { document.body.replaceChildren(); document.body.style.background = '#f1d7ea'; });
    await target.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find((item) => item.getTitle() === 'OnRecord'); win.show(); win.focus(); });
    // Region mode immediately creates a persistent native ring, without a source picker.
    const overlayEvent = app.waitForEvent('window');
    await page.locator('[data-mode="region"]').click();
    const overlay = await overlayEvent;
    overlay.on('pageerror', (error) => errors.push(error.message));
    await overlay.waitForFunction(() => document.querySelector('#region-size').textContent.includes('960'));
    await page.waitForFunction(() => document.querySelector('#target-name').textContent.includes('지정 영역'));
    assert.equal(await page.locator('#source-dialog').evaluate((dialog) => dialog.open), false);
    const initialBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.getTitle() === 'OnRecord 녹화 영역').getBounds());
    const grip = await overlay.locator('#region-move').boundingBox();
    await overlay.mouse.move(grip.x + 20, grip.y + 15);
    await overlay.mouse.down();
    await overlay.mouse.move(grip.x + 60, grip.y + 45);
    await overlay.mouse.up();
    await page.waitForTimeout(150);
    const movedBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.getTitle() === 'OnRecord 녹화 영역').getBounds());
    assert.equal(movedBounds.x - initialBounds.x, 40);
    assert.equal(movedBounds.y - initialBounds.y, 30);
    const corner = await overlay.locator('.handle.se').boundingBox();
    await overlay.mouse.move(corner.x + 5, corner.y + 5);
    await overlay.mouse.down();
    await overlay.mouse.move(corner.x + 5 - 320, corner.y + 5 - 180);
    await overlay.mouse.up();
    await page.waitForFunction(() => document.querySelector('#preview').width === 640 && document.querySelector('#preview').height === 360);
    // A known solid background makes a captured blue border or handle detectable.
    await page.waitForFunction(() => {
      const pixel = document.querySelector('#preview').getContext('2d').getImageData(320, 1, 1, 1).data;
      return Math.abs(pixel[0] - 241) < 8 && Math.abs(pixel[1] - 215) < 8 && Math.abs(pixel[2] - 234) < 8;
    });
    await overlay.screenshot({ path: path.join(output, '05-persistent-region.png') });
    const native = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.getTitle() === 'OnRecord 녹화 영역');
      return { handle: win.getNativeWindowHandle().readBigUInt64LE().toString(), protected: win.isContentProtected() };
    });
    assert.equal(native.protected, true);
    // Check the actual Windows hit region: the center must be a hole, the border interactive.
    const shapeCheck = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class RegionCheck { [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int a,int b,int c,int d); [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr w,IntPtr r); [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr r,int x,int y); [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr r); }'; $r=[RegionCheck]::CreateRectRgn(0,0,0,0); $kind=[RegionCheck]::GetWindowRgn([IntPtr]::new([long]${native.handle}),$r); if($kind -eq 0 -or [RegionCheck]::PtInRegion($r,332,216) -or -not [RegionCheck]::PtInRegion($r,12,216)){exit 1}; [void][RegionCheck]::DeleteObject($r)`], { encoding: 'utf8', windowsHide: true });
    assert.equal(shapeCheck.status, 0, shapeCheck.stderr);
    const dimensions = await page.locator('#preview').evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
    assert.ok(dimensions.width >= 640 && dimensions.height >= 360, JSON.stringify(dimensions));
    assert.ok(Math.abs(dimensions.width / dimensions.height - 640 / 360) < .03);
    await page.locator('#format').selectOption('webm');
    await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#record-label').textContent === '녹화 종료');
    await overlay.waitForFunction(() => document.body.classList.contains('recording'));
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.getTitle() === 'OnRecord 녹화 영역').isVisible()), true);
    assert.equal(await overlay.locator('.handle.se').isVisible(), false);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.getTitle() === 'OnRecord').isVisible()), true);
    await controls.waitForFunction(() => document.querySelector('#controls-timer').textContent >= '00:00:01');
    await targetPage.evaluate(() => { document.body.style.background = '#def3d8'; });
    await page.waitForFunction(() => {
      const pixel = document.querySelector('#preview').getContext('2d').getImageData(320, 180, 1, 1).data;
      return Math.abs(pixel[0] - 222) < 8 && Math.abs(pixel[1] - 243) < 8 && Math.abs(pixel[2] - 216) < 8;
    });
    await page.screenshot({ path: path.join(output, '06-live-preview-during-recording.png') });
    await targetPage.evaluate(() => { document.body.style.background = '#f1d7ea'; });
    await page.waitForFunction(() => {
      const pixel = document.querySelector('#preview').getContext('2d').getImageData(320, 180, 1, 1).data;
      return Math.abs(pixel[0] - 241) < 8 && Math.abs(pixel[1] - 215) < 8 && Math.abs(pixel[2] - 234) < 8;
    });
    const recordingBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.getTitle() === 'OnRecord 녹화 영역').getBounds());
    const recordingGrip = await overlay.locator('#region-move').boundingBox();
    await overlay.mouse.move(recordingGrip.x + 20, recordingGrip.y + 15);
    await overlay.mouse.down();
    await overlay.mouse.move(recordingGrip.x + 36, recordingGrip.y + 25);
    await overlay.mouse.up();
    await overlay.waitForTimeout(150);
    const updatedBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.getTitle() === 'OnRecord 녹화 영역').getBounds());
    assert.equal(updatedBounds.x - recordingBounds.x, 16);
    assert.equal(updatedBounds.y - recordingBounds.y, 10);
    assert.deepEqual(await page.locator('#preview').evaluate((canvas) => ({ width: canvas.width, height: canvas.height })), dimensions);
    await controls.waitForFunction(() => document.querySelector('#controls-timer').textContent >= '00:00:02');
    await controls.locator('#stop').click();
    await page.waitForSelector('#result:not([hidden])', { timeout: 30000 });
    const regionFile = await page.locator('#result-path').getAttribute('title');
    assert.ok(regionFile.endsWith('.webm'));
    const regionDecode = spawnSync(require('ffmpeg-static'), ['-v', 'error', '-i', regionFile, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
    assert.equal(regionDecode.status, 0, regionDecode.stderr);
    const frame = spawnSync(require('ffmpeg-static'), ['-v', 'error', '-i', regionFile, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true, maxBuffer: 640 * 360 * 4 });
    assert.equal(frame.status, 0, frame.stderr?.toString());
    for (const [x, y] of [[320, 1], [320, 358], [1, 180], [638, 180]]) {
      const offset = (y * 640 + x) * 3;
      const pixel = [...frame.stdout.subarray(offset, offset + 3)];
      assert.ok(pixel.length === 3 && pixel.every((value, index) => Math.abs(value - [241, 215, 234][index]) < 15), `Recorded border pixel ${x},${y}: ${pixel}`);
    }
    assert.equal(await overlay.locator('.handle.se').isVisible(), true);
    const displayBounds = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
    await overlay.evaluate((rect) => window.onrecord.updateRegion({ action: 'resize', rect }), displayBounds);
    await overlay.waitForFunction(() => document.body.classList.contains('toolbar-inside'));
    const edgeBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.getTitle() === 'OnRecord 녹화 영역').getBounds());
    assert.deepEqual(edgeBounds, { x: displayBounds.x - 12, y: displayBounds.y - 36, width: displayBounds.width + 24, height: displayBounds.height + 48 });
    const edgeGrip = await overlay.locator('#region-move').boundingBox();
    assert.ok(edgeBounds.y + edgeGrip.y >= displayBounds.y, 'Move handle stays reachable at the screen top');
    await overlay.evaluate(() => window.onrecord.updateRegion({ action: 'resize', rect: { x: 100, y: 100, width: 640, height: 360 } }));
    await page.waitForFunction(() => document.querySelector('#preview').width === 640 && document.querySelector('#preview').height === 360);
    await overlay.locator('#region-close').click();
    await page.waitForFunction(() => document.querySelector('#target-name').textContent === '녹화 대상 없음');
    assert.equal(await page.locator('#record').isDisabled(), true);
    try {
      // Use a fresh normal window: Windows capture enumeration can lag after leaving fullscreen.
      await target.close();
      target = await electron.launch({ args: [path.join(__dirname, 'capture-target.cjs')], env });
      await (await target.firstWindow()).waitForSelector('h1');
      await page.locator('[data-mode="window"]').click();
      await page.locator('.source-card').filter({ hasText: 'OnRecord capture test' }).first().click();
      await page.waitForFunction(() => document.querySelector('#target-name').textContent.includes('OnRecord capture test'));
      await page.locator('#system-audio').check();
      await page.locator('#microphone').check();
      await page.waitForFunction(() => document.querySelector('#mic-device').disabled === false);
      await page.locator('#format').selectOption('mp4');
      await page.locator('#record').click();
      await page.waitForFunction(() => document.querySelector('#record-label').textContent === '녹화 종료');
      await controls.waitForFunction(() => document.querySelector('#controls-timer').textContent >= '00:00:02');
      await controls.locator('#stop').click();
      await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
      const audioFile = await page.locator('#result-path').getAttribute('title');
      const probe = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-i', audioFile], { encoding: 'utf8', windowsHide: true });
      assert.match(probe.stderr, /Audio: aac/);
      const decode = spawnSync(require('ffmpeg-static'), ['-v', 'error', '-i', audioFile, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
      assert.equal(decode.status, 0, decode.stderr);
      console.log('Window capture with system + microphone audio saved:', audioFile);
    } finally { await target.close(); target = null; }
    assert.deepEqual(errors, []);
    const report = { passed: true, screenRecording: saved, regionRecording: regionFile, cropDimensions: dimensions, checks: ['launch', 'real desktop preview', 'MP4 encode and full decode', 'separate controls', 'main window remains visible during recording', 'preview follows real screen changes during recording', 'pause/resume timer', 'region appears without monitor picker', 'region move and resize updates 640x360 preview', 'native Windows hit-test hole passes interior clicks', 'persistent border and movement during recording with fixed resolution', 'app and border excluded in actual preview and decoded recording pixels', 'region close clears recording target', 'WebM encode and full decode', 'external window capture', 'system and microphone audio mixed into AAC'], errors };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const page = app.windows()[0];
    if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); console.error(await page.locator('#toast').textContent().catch(() => '')); }
    await app.evaluate(({ app }) => app.exit(1)).catch(() => {});
    throw error;
  } finally { if (target) await target.close().catch(() => {}); await app.close().catch(() => {}); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
