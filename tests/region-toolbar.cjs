const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const output = await fs.mkdtemp(path.join(root, 'work', 'region-toolbar-'));
  const env = { ...process.env, ONRECORD_TEST_PREFERENCES: path.join(output, 'preferences.json'), ONRECORD_TEST_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('body[data-ready="true"]');
    const overlayEvent = app.waitForEvent('window');
    await page.locator('[data-mode="region"]').click();
    const overlay = await overlayEvent;
    await overlay.waitForFunction(() => document.querySelector('#region-size').textContent.includes('×'));
    async function layout() {
      return overlay.evaluate(() => {
        const rect = (id) => { const b = document.querySelector(id).getBoundingClientRect(); return { x:b.x, y:b.y, width:b.width, height:b.height, right:b.right }; };
        return { toolbar:rect('#region-toolbar'), move:rect('#region-move'), close:rect('#region-close') };
      });
    }
    const normal = await layout();
    assert.equal(normal.toolbar.width, 292);
    assert.equal(normal.move.right, normal.close.x);
    assert.equal(normal.close.right, normal.toolbar.right);
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'OnRecord 녹화 영역').getBounds());
    await overlay.mouse.move(normal.move.x + 30, normal.move.y + 15);
    await overlay.mouse.down();
    await overlay.mouse.move(normal.move.x + 54, normal.move.y + 31);
    await overlay.mouse.up();
    await page.waitForTimeout(150);
    const moved = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'OnRecord 녹화 영역').getBounds());
    assert.equal(moved.x - bounds.x, 24);
    assert.equal(moved.y - bounds.y, 16);
    const handle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'OnRecord 녹화 영역').getNativeWindowHandle().readBigUInt64LE().toString());
    const hit = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class HitTest { [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int a,int b,int c,int d); [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr w,IntPtr r); [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr r,int x,int y); [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr r); }'; $r=[HitTest]::CreateRectRgn(0,0,0,0); $kind=[HitTest]::GetWindowRgn([IntPtr]::new([long]${handle}),$r); if($kind -eq 0 -or -not [HitTest]::PtInRegion($r,286,17) -or [HitTest]::PtInRegion($r,${bounds.width - 24},17)){exit 1}; [void][HitTest]::DeleteObject($r)`], { encoding:'utf8', windowsHide:true });
    assert.equal(hit.status, 0, hit.stderr);
    await page.evaluate(() => window.onrecord.regionPhase('recording'));
    await overlay.waitForFunction(() => document.querySelector('#region-close').disabled && document.body.classList.contains('recording'));
    await page.evaluate(() => window.onrecord.regionPhase('idle'));
    await overlay.waitForFunction(() => !document.querySelector('#region-close').disabled);
    await overlay.screenshot({ path: path.join(output, 'toolbar.png') });
    await overlay.evaluate(() => window.onrecord.updateRegion({ action:'resize', rect:{ x:100, y:0, width:64, height:64 } }));
    await overlay.waitForFunction(() => document.body.classList.contains('toolbar-inside') && document.querySelector('#region-toolbar').getBoundingClientRect().width === 68);
    const small = await layout();
    assert.equal(small.close.width, 32);
    assert.equal(small.move.right, small.close.x);
    assert.equal(small.close.right, small.toolbar.right);
    await overlay.locator('#region-close').click();
    await page.waitForFunction(() => document.querySelector('#target-name').textContent === '녹화 대상 없음');
    assert.equal(await page.locator('#record').isDisabled(), true);
    console.log('PASS: grouped toolbar layout, native click region, drag, recording lock, minimum-size/top-edge close');
    console.log('Screenshot:', path.join(output, 'toolbar.png'));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
