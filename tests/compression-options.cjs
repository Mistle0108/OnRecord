const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  await fs.mkdir(path.join(root, 'work'), { recursive: true });
  const output = await fs.mkdtemp(path.join(root, 'work', 'compression-options-'));
  const file = path.join(output, 'preferences.json');
  const env = { ...process.env, ONRECORD_TEST_OUTPUT: output, ONRECORD_TEST_PREFERENCES: file };
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
  try {
    let page = await launch();
    assert.equal(await page.locator('#compression').inputValue(), 'medium');
    assert.equal(await page.locator('#compression').isEnabled(), true);
    assert.equal(await page.locator('.settings-group').nth(1).locator('select').last().getAttribute('id'), 'compression');
    assert.deepEqual(await page.locator('#compression option').allTextContents(), ['빠른 저장', '빠른 압축', '용량 우선']);
    await page.locator('#compression-help').click();
    assert.equal(await page.locator('#compression-dialog').isVisible(), true);
    assert.deepEqual(await page.locator('#compression-dialog dt').allTextContents(), ['빠른 저장', '빠른 압축', '용량 우선']);
    assert.match(await page.locator('#compression-dialog').textContent(), /MP4에만 적용/);
    await page.screenshot({ path: path.join(output, 'help.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#compression-dialog').isVisible(), false);
    await page.locator('#compression-help').click();
    await page.locator('#close-compression-dialog').click();
    for (const [width, height] of [[980, 600], [880, 540]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(win => win.getTitle() === 'OnRecord').setSize(...size), [width, height]);
      await page.locator('#compression').scrollIntoViewIfNeeded();
      const layout = await page.locator('#compression').evaluate(input => {
        const row = input.closest('.select-row'), panel = input.closest('.settings');
        return { rowWidth: row.clientWidth, rowScroll: row.scrollWidth, panelWidth: panel.clientWidth, panelScroll: panel.scrollWidth };
      });
      assert.ok(layout.rowScroll <= layout.rowWidth + 1 && layout.panelScroll <= layout.panelWidth + 1, JSON.stringify(layout));
      await page.screenshot({ path: path.join(output, `settings-${width}.png`) });
    }
    await page.locator('#compression').selectOption('none');
    await page.locator('#compression').selectOption('fast');
    await page.locator('#format').selectOption('webm');
    assert.equal(await page.locator('#compression').isDisabled(), true);
    await app.close(); app = null;
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.compression, 'fast');
    page = await launch();
    assert.equal(await page.locator('#compression').inputValue(), 'fast');
    assert.equal(await page.locator('#compression').isDisabled(), true);
    await page.locator('#format').selectOption('mp4');
    assert.equal(await page.locator('#compression').isEnabled(), true);
    assert.equal(await page.locator('#compression').inputValue(), 'fast');
    const rejected = await page.evaluate(async () => {
      try { await window.onrecord.begin({ format: 'mp4', compression: 'invalid' }); return false; }
      catch (error) { return error.message.includes('저장 압축 설정'); }
    });
    assert.equal(rejected, true);
    console.log(JSON.stringify({ passed: true, output, checks: ['video section placement and default', 'click popup, close button and Escape', 'layout at 980 and 880 pixels', 'WebM disables compression', 'restart restores selection', 'invalid compression rejected'] }, null, 2));
  } finally { if (app) await app.close().catch(() => {}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
