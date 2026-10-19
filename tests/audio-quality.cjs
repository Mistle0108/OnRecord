const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

(async () => {
  const root = path.resolve(__dirname, '..'), output = path.join(root, 'work', 'audio-quality');
  await fs.mkdir(output, { recursive: true });
  const env = { ...process.env, ONRECORD_TEST_OUTPUT: output, ONRECORD_TEST_PREFERENCES: path.join(await fs.mkdtemp(path.join(output, 'preferences-')), 'preferences.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ ...(env.ONRECORD_EXECUTABLE ? { executablePath: env.ONRECORD_EXECUTABLE, args: [] } : { args: [root] }), env });
  try {
    await app.firstWindow();
    let page;
    for (let n = 0; n < 200 && !page; n++) { page = app.windows().find((window) => window.url().endsWith('/index.html')); if (!page) await new Promise((resolve) => setTimeout(resolve, 50)); }
    assert.ok(page);
    await page.waitForSelector('body[data-ready="true"]');
    await page.locator('#delay').selectOption('0');
    await page.locator('#resolution').selectOption('720');
    assert.equal(await page.locator('#microphone').isChecked(), false);
    await page.locator('#empty-choose').click();
    await page.locator('.source-card').first().click();
    await page.waitForFunction(() => document.querySelector('#source-video').videoWidth > 2);
    const captureSettings = await page.evaluate(() => document.querySelector('#source-video').srcObject.getAudioTracks()[0].getSettings());
    assert.equal(captureSettings.channelCount, 2);
    for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) if (key in captureSettings) assert.equal(captureSettings[key], false, key);
    // Measure codec loss with a controlled signal: other applications can add
    // arbitrary audio to Windows loopback, so live sound cannot be an SNR reference.
    async function injectTone() { await page.evaluate(async () => {
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      const merger = ctx.createChannelMerger(2), destination = ctx.createMediaStreamDestination();
      const oscillators = [440, 997].map((frequency, channel) => {
        const oscillator = ctx.createOscillator(), gain = ctx.createGain();
        oscillator.frequency.value = frequency; gain.gain.value = .08;
        oscillator.connect(gain).connect(merger, 0, channel); oscillator.start(); return oscillator;
      });
      merger.connect(destination);
      const stream = document.querySelector('#source-video').srcObject;
      for (const track of stream.getAudioTracks()) { stream.removeTrack(track); track.stop(); }
      destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
      window.testTone = { ctx, oscillators };
      const NativeRecorder = window.testNativeRecorder || window.MediaRecorder;
      window.testNativeRecorder = NativeRecorder;
      window.MediaRecorder = class extends NativeRecorder {
        constructor(...args) {
          super(...args);
          window.testCaptureChunks = [];
          window.testCaptureMime = this.mimeType;
          this.addEventListener('dataavailable', (event) => window.testCaptureChunks.push(event.data));
        }
      };
    }); }
    const recordings = [];
    for (const { format, paused } of [{ format: 'mp4', paused: false }, { format: 'webm', paused: false }, { format: 'mp4', paused: true }, { format: 'webm', paused: true }]) {
      await page.locator('#format').selectOption(format);
      assert.equal(await page.locator('#format').inputValue(), format);
      if (!(await page.evaluate(() => !!document.querySelector('#source-video').srcObject))) {
        await page.evaluate(async () => { await connectScreen(source, crop); });
      }
      await injectTone();
      await page.locator('#record').click();
      await page.waitForFunction(() => document.querySelector('#record-label').textContent === '녹화 종료');
      if (paused) {
        const controls = app.windows().find((window) => window.url().endsWith('/controls.html'));
        await page.waitForFunction(() => document.querySelector('#timer').textContent >= '00:00:02');
        await controls.locator('#pause').click();
        await controls.waitForFunction(() => document.querySelector('#controls-label').textContent.includes('일시정지'));
        const time = await controls.locator('#controls-timer').textContent();
        await page.waitForTimeout(1000);
        assert.equal(await controls.locator('#controls-timer').textContent(), time);
        await controls.locator('#pause').click();
      }
      await page.waitForFunction(() => document.querySelector('#timer').textContent >= '00:00:04');
      await page.locator('#record').click();
      await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
      const saved = await page.locator('#result-path').getAttribute('title');
      assert.ok(saved.endsWith(`.${format}`));
      const capture = await page.evaluate(async () => {
        const blob = new Blob(window.testCaptureChunks);
        const data = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
        return { mime: window.testCaptureMime, data };
      });
      assert.ok(capture.mime.includes(format === 'mp4' ? 'mp4a.40.2' : 'opus'), capture.mime);
      const captured = path.join(output, `${format}${paused ? '-paused' : ''}-capture.${format}`);
      await fs.writeFile(captured, Buffer.from(capture.data, 'base64'));
      const audioBytes = (file) => {
        const args = ['-v', 'error', '-i', file, '-map', '0:a:0', '-vn', ...(format === 'mp4' ? ['-c:a', 'copy', '-f', 'adts'] : ['-c:a', 'pcm_f32le', '-f', 'f32le']), 'pipe:1'];
        const result = spawnSync(require('ffmpeg-static'), args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        assert.equal(result.status, 0, result.stderr?.toString());
        assert.ok(result.stdout.length > 1000);
        return result.stdout;
      };
      const originalAudio = audioBytes(captured), savedAudio = audioBytes(saved);
      assert.ok(originalAudio.equals(savedAudio), `${format}: saved audio must match the captured audio exactly`);
      const audioHash = createHash('sha256').update(savedAudio).digest('hex');
      assert.equal(await page.evaluate(() => document.querySelector('#source-video').srcObject), null);
      await page.evaluate(async () => { await window.testTone.ctx.close(); });
      const decode = spawnSync(require('ffmpeg-static'), ['-v', 'error', '-i', saved, '-vn', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(decode.status, 0, decode.stderr?.toString());
      const pcm = new Float32Array(decode.stdout.buffer, decode.stdout.byteOffset, decode.stdout.byteLength / 4);
      const rate = 48000, frames = pcm.length / 2;
      assert.ok(frames > rate * 2);
      if (paused) assert.ok(frames / rate > 3.8 && frames / rate < 4.6, `Paused audio duration must exclude the pause: ${frames / rate}`);
      const start = Math.floor(rate * .5), end = Math.min(frames - Math.floor(rate * .5), rate * (paused ? 1.5 : 3));
      const channels = [440, 997].map((frequency, channel) => {
        let energy = 0, peak = 0, windows = 0, residualEnergy = 0, fundamentalEnergy = 0;
        const amplitudes = [];
        // Fit short sine windows so independent playback/capture clocks cannot skew SNR.
        for (let offset = start; offset + 2400 < end; offset += 2400) {
          let ss = 0, cc = 0, sc = 0, xs = 0, xc = 0;
          for (let n = 0; n < 2400; n++) {
            const value = pcm[(offset + n) * 2 + channel], angle = 2 * Math.PI * frequency * n / rate;
            const s = Math.sin(angle), c = Math.cos(angle);
            ss += s * s; cc += c * c; sc += s * c; xs += value * s; xc += value * c;
            energy += value * value; peak = Math.max(peak, Math.abs(value));
          }
          const determinant = ss * cc - sc * sc;
          const a = (xs * cc - xc * sc) / determinant, b = (xc * ss - xs * sc) / determinant;
          amplitudes.push(Math.hypot(a, b));
          for (let n = 0; n < 2400; n++) {
            const angle = 2 * Math.PI * frequency * n / rate, fitted = a * Math.sin(angle) + b * Math.cos(angle);
            const error = pcm[(offset + n) * 2 + channel] - fitted;
            residualEnergy += error * error; fundamentalEnergy += fitted * fitted;
          }
          windows++;
        }
        const rms = Math.sqrt(energy / (windows * 2400));
        const snrDb = 10 * Math.log10(fundamentalEnergy / Math.max(1e-15, residualEnergy));
        assert.ok(rms > .005, `Channel ${channel} has no system audio: ${rms}`);
        assert.ok(peak < .95, `Channel ${channel} clips: ${peak}`);
        assert.ok(snrDb > 30, `Channel ${channel} has distortion or channel mixing: ${snrDb.toFixed(1)} dB`);
        const sorted = [...amplitudes].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
        assert.ok(amplitudes.every((amplitude) => amplitude > median * .5), 'Audio has dropouts');
        return { channel, frequency, rms, peak, snrDb, windows };
      });
      recordings.push({ format, paused, saved, captured, mime: capture.mime, audioHash, byteIdentical: true, duration: frames / rate, channels });
    }
    await page.evaluate(() => window.testTone.oscillators.forEach((oscillator) => oscillator.stop()));
    const report = { passed: true, captureSettings, recordings, checks: ['real Windows loopback settings: stereo and speech processing disabled', 'AAC captured directly, encoded packets identical after MP4 save', 'WebM directly records Opus stereo audio without transcoding on save', 'both audio codecs pause and resume without retaining pause duration', 'controlled synthetic stereo SNR over 30 dB', 'no clipping of test signal', 'no 50 ms test-tone dropouts in measured continuous segment', 'capture inputs released after each recording; repeated recordings reconnect'] };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await app.evaluate(({ app }) => app.exit(1)).catch(() => {});
    throw error;
  } finally { await app.close().catch(() => {}); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
