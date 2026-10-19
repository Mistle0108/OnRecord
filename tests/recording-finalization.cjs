const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const ffmpeg = require('ffmpeg-static');
const duration = Number(process.env.ONRECORD_TEST_SECONDS || 8);
const shellProbe = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ShellProbe { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c,string n); [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr w,uint m,UIntPtr p,IntPtr l,uint f,uint t,out UIntPtr r); }'; $checks=@(); foreach($class in @('Shell_TrayWnd','Progman')) { $handle=[ShellProbe]::FindWindow($class,$null); if($handle -ne [IntPtr]::Zero) { $reply=[UIntPtr]::Zero; $ok=[ShellProbe]::SendMessageTimeout($handle,0,[UIntPtr]::Zero,[IntPtr]::Zero,2,1000,[ref]$reply); $checks+=@{class=$class;responding=($ok -ne [IntPtr]::Zero)} } }; ConvertTo-Json -Compress -InputObject @($checks)`;
function checkShell() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', shellProbe], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const checks = JSON.parse(result.stdout);
  assert.ok(checks.some(item => item.class === 'Shell_TrayWnd'));
  assert.ok(checks.every(item => item.responding), result.stdout);
  return checks;
}
function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  assert.equal(result.stderr?.toString().trim(), '', 'FFmpeg must not report decoding or remuxing errors');
  return result.stdout;
}
function videoHash(file) {
  return run(['-i', file, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'hash', '-hash', 'sha256', 'pipe:1']).toString().trim();
}
function audioHash(file) {
  return run(['-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', 'pipe:1']).toString().trim();
}
function videoFrames(file) {
  return run(['-i', file, '-map', '0:v:0', '-fps_mode:v', 'passthrough', '-enc_time_base:v', '-1', '-f', 'framehash', 'pipe:1']).toString().split('\n').filter(line => /^\d+,/.test(line)).length;
}
function decode(file) {
  // Validate every frame, including interrupted captures with duplicate timestamps.
  // Saved-file timing is checked separately using the original packet timestamps.
  run(['-i', file, '-vf', 'setpts=N/(60*TB)', '-fps_mode:v', 'passthrough', '-enc_time_base:v', '-1', '-f', 'null', '-']);
}
function streamRange(file, stream) {
  const lines = run(['-i', file, '-map', stream, '-c', 'copy', '-f', 'framehash', 'pipe:1']).toString().split('\n');
  const [, numerator, denominator] = lines.find(line => line.startsWith('#tb')).match(/(\d+)\/(\d+)/);
  const scale = Number(numerator) / Number(denominator);
  const packets = lines.filter(line => /^\d+,/.test(line)).map(line => line.split(',').map(value => Number(value.trim())));
  assert.ok(packets.length > 0);
  return { start: Math.min(...packets.map(packet => packet[2])) * scale, end: Math.max(...packets.map(packet => packet[2] + packet[3])) * scale };
}

(async () => {
  await fs.mkdir(path.join(root, 'work'), { recursive: true });
  const output = await fs.mkdtemp(path.join(root, 'work', 'finalization-'));
  const env = { ...process.env, ONRECORD_TEST_OUTPUT: output, ONRECORD_TEST_PREFERENCES: path.join(output, 'preferences.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--user-data-dir=' + path.join(output, 'profile'), '--enable-logging=file', '--log-file=' + path.join(output, 'chromium.log'), '--vmodule=video_track_recorder*=2,media_recorder_encoder_wrapper*=2,video_encode_accelerator_adapter*=2'];
  const app = await electron.launch({ ...(env.ONRECORD_EXECUTABLE ? { executablePath: env.ONRECORD_EXECUTABLE, args } : { args: [root, ...args] }), env });
  const errors = [], recordings = [];
  try {
    await app.firstWindow();
    let page;
    for (let attempt = 0; attempt < 200 && !page; attempt++) {
      page = app.windows().find(window => window.url().endsWith('/index.html'));
      if (!page) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(page, 'Main recording window must load');
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('body[data-ready="true"]');
    await app.evaluate(({ ipcMain }) => {
      const fs = process.mainModule.require('node:fs/promises'), path = process.mainModule.require('node:path');
      const finish = ipcMain._invokeHandlers.get('finish');
      ipcMain.removeHandler('finish');
      ipcMain.handle('finish', async (event, ...args) => {
        const directory = process.env.ONRECORD_TEST_OUTPUT;
        const capture = (await fs.readdir(directory)).filter(file => file.startsWith('OnRecord-') && file.endsWith('.capture.mp4')).sort().pop();
        if (capture) await fs.copyFile(path.join(directory, capture), path.join(directory, 'original-' + capture));
        if (global.failNextSave) {
          global.failNextSave = false;
          // A conflicting temporary output makes FFmpeg fail without touching the original.
          await fs.writeFile(path.join(directory, capture.replace('.capture.mp4', '.mp4.finalizing')), 'occupied');
        }
        return finish(event, ...args);
      });
    });
    await page.locator('#delay').selectOption('0');
    await page.locator('#resolution').selectOption('1080');
    await page.locator('#format').selectOption('mp4');
    await page.locator('#empty-choose').click();
    await page.locator('.source-card').first().click();
    await page.waitForFunction(() => document.querySelector('#source-video').videoWidth > 2);
    const gpu = await app.evaluate(async ({ app }) => ({ features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('complete') }));
    const shellBefore = checkShell();
    for (const [compression, audio, seconds, fps] of [['medium', true, duration, '30'], ['fast', true, 4, '30'], ['none', false, 4, '60']]) {
      await page.locator('#compression').selectOption(compression);
      await page.locator('#system-audio').setChecked(audio);
      await page.locator('#fps').selectOption(fps);
      await page.locator('#record').click();
      await page.waitForFunction(() => document.querySelector('#record-label').textContent === '녹화 종료');
      const samples = [];
      for (let elapsed = 0; elapsed < seconds;) {
        const wait = Math.min(10000, (seconds - elapsed) * 1000);
        await page.waitForTimeout(wait); elapsed += wait / 1000;
        const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, cpu: p.cpu.percentCPUUsage, workingSetKiB: p.memory.workingSetSize })));
        const nvenc = spawnSync('nvidia-smi', ['--query-gpu=encoder.stats.sessionCount,encoder.stats.averageFps,utilization.encoder', '--format=csv,noheader,nounits'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
        const currentCapture = (await fs.readdir(output)).filter(name => name.startsWith('OnRecord-') && name.endsWith('.capture.mp4')).sort().pop();
        const writtenBytes = (await fs.stat(path.join(output, currentCapture))).size;
        assert.ok(writtenBytes > 0, 'Recording must stream fragments to disk before stopping');
        samples.push({ processes, nvenc: nvenc.status === 0 ? nvenc.stdout.trim() : null, writtenBytes, shell: checkShell() });
        console.log(JSON.stringify({ progressSeconds: elapsed, targetSeconds: seconds, audio, fps, writtenBytes, workingSetMiB: Math.round(processes.reduce((sum, p) => sum + p.workingSetKiB, 0) / 1024), nvenc: samples.at(-1).nvenc }));
      }
      await page.evaluate(() => {
        window.testTracks = [...screenStream.getTracks(), ...recordedStream.getTracks(), ...(micStream?.getTracks() || []), ...(cameraStream?.getTracks() || [])];
      });
      const stopAt = Date.now();
      await page.locator('#record').click();
      await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
      await page.waitForFunction(() => !document.querySelector('#record').disabled);
      const saveMs = Date.now() - stopAt;
      assert.ok(await page.evaluate(() => window.testTracks.every(track => track.readyState === 'ended') && screenStream === null && recordedStream === null && micStream === null && cameraStream === null && drawTimer === null));
      const saved = await page.locator('#result-path').getAttribute('title');
      const captured = path.join(output, 'original-' + path.basename(saved).replace('.mp4', '.capture.mp4'));
      const hash = videoHash(captured);
      if (compression === 'none') assert.equal(videoHash(saved), hash, 'Quick save must preserve encoded video packets');
      else assert.notEqual(videoHash(saved), hash, 'Video must be compressed on save');
      assert.equal(videoFrames(saved), videoFrames(captured), 'Compression must preserve every video frame');
      if (audio) assert.equal(audioHash(saved), audioHash(captured), 'Compressed audio packets must remain unchanged');
      const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', saved], { windowsHide: true, encoding: 'utf8' }).stderr;
      assert.match(probe, /Video: h264/);
      if (audio) assert.match(probe, /Audio: aac/); else assert.doesNotMatch(probe, /Audio:/);
      const timing = { video: streamRange(saved, '0:v:0'), ...(audio ? { audio: streamRange(saved, '0:a:0') } : {}) };
      const originalTiming = streamRange(captured, '0:v:0');
      assert.ok(Math.abs(timing.video.start - originalTiming.start) < .05, 'Compression must preserve video start time');
      assert.ok(Math.abs(timing.video.end - originalTiming.end) < .05, 'Compression must preserve video duration');
      if (audio) {
        assert.ok(Math.abs(timing.video.start - timing.audio.start) < .15, 'Audio/video start timestamps must align');
        assert.ok(Math.abs(timing.video.end - timing.audio.end) < .25, 'Audio/video end timestamps must not drift');
      }
      decode(saved);
      const atoms = await fs.readFile(saved);
      assert.ok(atoms.indexOf(Buffer.from('moov')) < atoms.indexOf(Buffer.from('mdat')), 'Seek index must precede media data');
      const playbackFile = path.join(output, 'playback.html');
      await fs.writeFile(playbackFile, `<video src="${pathToFileURL(saved).href}"></video>`, 'utf8');
      const playback = await app.evaluate(async ({ BrowserWindow }, file) => {
        const win = new BrowserWindow({ show: false });
        await win.loadFile(file);
        try { return await win.webContents.executeJavaScript(`(async()=>{const v=document.querySelector('video');v.muted=true;if(v.readyState<1)await new Promise((r,j)=>{v.onloadedmetadata=r;v.onerror=j});const duration=v.duration;v.currentTime=duration/2;await new Promise((r,j)=>{v.onseeked=r;v.onerror=j});await v.play();return {duration,seekTime:v.currentTime,width:v.videoWidth,height:v.videoHeight}})()`); }
        finally { win.destroy(); }
      }, playbackFile);
      assert.ok(playback.duration > seconds - 1);
      assert.ok(playback.seekTime > seconds / 3);
      const sizes = { original: (await fs.stat(captured)).size, compressed: (await fs.stat(saved)).size };
      if (compression !== 'none') assert.ok(sizes.compressed < sizes.original, 'Screen recording must shrink after compression');
      recordings.push({ compression, audio, fps, seconds, saveMs, saved, captured, sizes, timing, playback, samples, shellAfterSave: checkShell() });
    }
    // Simulate finalization failure and check that the next recording can still start.
    await app.evaluate(() => { global.failNextSave = true; });
    await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#record-label').textContent === '녹화 종료');
    await page.waitForTimeout(3500);
    await page.locator('#record').click();
    await page.waitForFunction(() => !document.querySelector('#record').disabled);
    assert.match(await page.locator('#toast').textContent(), /복구용 원본/);
    const partials = (await fs.readdir(output)).filter(name => name.startsWith('OnRecord-') && name.endsWith('.capture.mp4'));
    assert.equal(partials.length, 1);
    decode(path.join(output, partials[0]));
    await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#record-label').textContent === '녹화 종료');
    await page.waitForTimeout(3500);
    await page.locator('#record').click();
    await page.waitForSelector('#result:not([hidden])');
    await page.waitForFunction(() => !document.querySelector('#record').disabled);
    // Unsupported capture codecs must still produce a clear message.
    await page.evaluate(() => {
      window.testSupported = MediaRecorder.isTypeSupported;
      MediaRecorder.isTypeSupported = mime => !mime.startsWith('video/mp4') && window.testSupported(mime);
    });
    await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('WebM'));
    await page.waitForFunction(() => !document.querySelector('#record').disabled);
    await page.evaluate(() => { MediaRecorder.isTypeSupported = window.testSupported; });
    // Exit during recording without recorder.stop(): completed fragments must remain usable.
    const beforeCrash = new Set(await fs.readdir(output));
    await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#record-label').textContent === '녹화 종료');
    await page.waitForTimeout(5500);
    await app.evaluate(({ app }) => app.exit(17)).catch(() => {});
    const interrupted = (await fs.readdir(output)).find(name => !beforeCrash.has(name) && name.endsWith('.capture.mp4'));
    assert.ok(interrupted, 'Interrupted recording must retain its capture file');
    decode(path.join(output, interrupted));
    assert.deepEqual(errors, []);
    const report = { passed: true, output, gpu, shellBefore, recordings, recovery: { preserved: partials[0], decodable: true, nextRecordingSucceeded: true, interrupted, interruptedDecodable: true }, unsupportedCodecHandled: true };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: true, report: path.join(output, 'report.json'), recordings: recordings.map(({ samples, ...r }) => r) }, null, 2));
  } catch (error) {
    console.error('Artifacts:', output);
    await app.evaluate(({ app }) => app.exit(1)).catch(() => {});
    throw error;
  } finally { await app.close().catch(() => {}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
