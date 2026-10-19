const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const executable = process.env.ONRECORD_EXECUTABLE || process.env.ONRECORD_PORTABLE || path.join(root, 'release', 'win-unpacked', 'OnRecord.exe');
  await fs.mkdir(path.join(root, 'work'), { recursive: true });
  const output = await fs.mkdtemp(path.join(root, 'work', 'portable-recording-'));
  const profile = path.join(output, 'profile');
  const env = { ...process.env, ONRECORD_TEST_OUTPUT: output, ONRECORD_TEST_PREFERENCES: path.join(output, 'preferences.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  // Attach through the local debugging endpoint for both folder and legacy portable builds.
  const child = spawn(executable, ['--remote-debugging-port=0', '--user-data-dir=' + profile], { env, windowsHide: true, stdio: 'ignore' });
  let browser, page, launchError;
  child.on('error', error => { launchError = error; });
  try {
    let port;
    for (let attempt = 0; attempt < 600 && !port; attempt++) {
      if (launchError) throw launchError;
      try { port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; } catch {}
      if (!port) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(port, 'Packaged app must start its browser endpoint');
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    for (let attempt = 0; attempt < 200 && !page; attempt++) {
      page = browser.contexts()[0].pages().find(window => window.url().endsWith('/index.html'));
      if (!page) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(page);
    await page.waitForSelector('body[data-ready="true"]');
    await page.locator('#delay').selectOption('0');
    await page.locator('#format').selectOption('mp4');
    await page.locator('#empty-choose').click();
    await page.locator('.source-card').first().click();
    await page.waitForFunction(() => document.querySelector('#source-video').videoWidth > 2);
    const recordings = [];
    for (const [compression, audio] of [['medium', true], ['fast', true], ['none', false]]) {
      await page.locator('#compression').selectOption(compression);
      await page.locator('#system-audio').setChecked(audio);
      await page.locator('#record').click();
      await page.waitForFunction(() => document.querySelector('#record-label').textContent === '녹화 종료');
      await page.waitForTimeout(3500);
      const start = Date.now();
      await page.locator('#record').click();
      await page.waitForSelector('#result:not([hidden])');
      await page.waitForFunction(() => !document.querySelector('#record').disabled);
      const saveMs = Date.now() - start;
      const saved = await page.locator('#result-path').getAttribute('title');
      const probe = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-i', saved], { windowsHide: true, encoding: 'utf8' });
      assert.match(probe.stderr, /Video: h264/);
      if (audio) assert.match(probe.stderr, /Audio: aac/); else assert.doesNotMatch(probe.stderr, /Audio:/);
      const decode = spawnSync(require('ffmpeg-static'), ['-v', 'error', '-i', saved, '-fps_mode:v', 'passthrough', '-enc_time_base:v', '-1', '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' });
      assert.equal(decode.status, 0, decode.stderr);
      assert.equal(decode.stderr.trim(), '');
      assert.ok(await page.evaluate(() => screenStream === null && recordedStream === null && drawTimer === null));
      recordings.push({ compression, audio, saved, saveMs, decoded: true });
    }
    const report = { passed: true, executable, output, recordings };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (page) {
      await page.evaluate(async () => { if (phase === 'recording') await stopRecording(); window.onrecord.window('close'); }).catch(() => {});
    }
    await browser?.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
