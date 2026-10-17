const $ = (selector) => document.querySelector(selector);
const api = window.onrecord;
const canvas = $('#preview'), context = canvas.getContext('2d', { alpha: false });
const video = $('#source-video'), camera = $('#webcam-video');
let mode = 'screen', source = null, crop = null, screenStream, micStream, cameraStream;
let recorder, recordedStream, audioContext, audioDestination, analyser, micNode;
let drawTimer, clockTimer, startedAt = 0, pauseAt = 0, pausedTime = 0;
let phase = 'idle', captureHasAudio = false, chunkQueue = Promise.resolve(), writeError = null;
let previewOperation = false, latestRegion = null, initializing = true;

const preferenceFields = { systemAudio: '#system-audio', microphone: '#microphone', micDevice: '#mic-device', resolution: '#resolution', fps: '#fps', quality: '#quality', format: '#format', webcam: '#webcam', webcamPosition: '#webcam-position', delay: '#delay' };
function rememberPreferences() {
  if (initializing) return;
  const values = { captureMode: mode };
  for (const [key, selector] of Object.entries(preferenceFields)) {
    const input = $(selector);
    values[key] = input.type === 'checkbox' ? input.checked : input.value;
  }
  if (source) values.captureSource = { kind: source.id.startsWith('window:') ? 'window' : 'screen', id: source.id, name: source.name, displayId: source.displayId };
  api.savePreferences(values).catch((error) => notify(`설정을 저장하지 못했습니다. ${error.message}`));
}
function setCaptureMode(value) {
  mode = value;
  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.mode === mode);
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
}

function notify(message) { $('#toast').textContent = message; $('#toast').hidden = false; }
function clearNotice() { $('#toast').hidden = true; }
function timeLabel(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':');
}
function elapsed() { return startedAt ? (pauseAt || performance.now()) - startedAt - pausedTime : 0; }
function tick() {
  const time = timeLabel(elapsed());
  $('#timer').textContent = time;
  api.state({ time, paused: recorder?.state === 'paused' });
}
function setPhase(next) {
  phase = next;
  api.regionPhase(next);
  const locked = next !== 'idle';
  $('#settings-fields').disabled = locked;
  for (const button of document.querySelectorAll('[data-mode],#choose-source,#choose-folder')) button.disabled = locked;
  $('#record').disabled = ['countdown', 'saving', 'starting'].includes(next) || (!source && next === 'idle');
  $('#record').classList.toggle('is-recording', next === 'recording');
  window.recordIcons.set('.record-dot', next === 'recording' ? 'stop' : 'record');
  $('#record-label').textContent = { idle: '녹화 시작', starting: '준비 중', countdown: '시작 대기', recording: '녹화 종료', saving: '저장 중' }[next];
  $('#status').textContent = { idle: '녹화 준비', starting: '장치 확인 중', countdown: '잠시 후 시작합니다', recording: '녹화 중', saving: '영상을 저장하고 있어요' }[next];
  $('#capture-label').textContent = next === 'recording' ? '녹화 중' : '준비';
}
function stopTracks(stream) { stream?.getTracks().forEach((track) => track.stop()); }
function sizeCanvas() {
  if (!video.videoWidth) return;
  const width = video.videoWidth * (crop?.width || 1), height = video.videoHeight * (crop?.height || 1);
  const maximum = $('#resolution').value;
  const scale = maximum === 'native' ? 1 : Math.min(1, (maximum === '1080' ? 1920 : 1280) / width, Number(maximum) / height);
  canvas.width = Math.max(2, Math.floor(width * scale / 2) * 2);
  canvas.height = Math.max(2, Math.floor(height * scale / 2) * 2);
  $('#dimensions').textContent = `${canvas.width} × ${canvas.height} · ${$('#fps').value} fps${crop ? ' · 지정 영역' : ''}`;
}
function draw() {
  if (video.readyState < 2) return;
  const width = video.videoWidth, height = video.videoHeight;
  context.drawImage(video, (crop?.x || 0) * width, (crop?.y || 0) * height, (crop?.width || 1) * width, (crop?.height || 1) * height, 0, 0, canvas.width, canvas.height);
  if (cameraStream && camera.readyState >= 2) {
    const w = Math.round(canvas.width * .22), h = Math.round(w * camera.videoHeight / camera.videoWidth);
    const pad = Math.round(canvas.width * .018), position = $('#webcam-position').value;
    context.drawImage(camera, position.endsWith('right') ? canvas.width - w - pad : pad, position.startsWith('bottom') ? canvas.height - h - pad : pad, w, h);
  }
  if (analyser && micStream) {
    const values = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(values);
    const rms = Math.sqrt(values.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / values.length);
    $('#mic-level').style.width = `${Math.min(100, rms * 400)}%`;
  }
}
function restartDrawing() { clearInterval(drawTimer); drawTimer = setInterval(draw, 1000 / Number($('#fps').value)); }

async function connectScreen(nextSource, nextCrop) {
  const withAudio = $('#system-audio').checked;
  // Release the previous Windows capture session before requesting the same window again.
  // Overlapping sessions can leave the replacement stream at its initial 2×2 frame.
  const previous = screenStream;
  screenStream = null;
  stopTracks(previous);
  video.srcObject = null;
  await api.selectSource(nextSource.id, withAudio);
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: Number($('#fps').value), ...(nextSource.width ? { width: { ideal: nextSource.width }, height: { ideal: nextSource.height } } : {}) }, audio: withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } } : false });
  for (const track of stream.getAudioTracks()) track.contentHint = 'music';
  screenStream = stream;
  captureHasAudio = withAudio;
  source = nextSource; crop = nextCrop;
  video.srcObject = stream;
  let timeout;
  try {
    await Promise.race([video.play(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('화면 응답이 없습니다. 대상 창을 열어 둔 상태에서 다시 선택해 주세요.')), 10000); })]);
  } finally { clearTimeout(timeout); }
  if (video.videoWidth <= 2 || video.videoHeight <= 2) {
    await new Promise((resolve, reject) => {
      const started = performance.now();
      const interval = setInterval(() => {
        if (video.videoWidth > 2 && video.videoHeight > 2) { clearInterval(interval); resolve(); }
        else if (performance.now() - started > 10000) { clearInterval(interval); reject(new Error('대상 창의 화면을 가져오지 못했습니다. 창이 최소화되어 있지 않은지 확인해 주세요.')); }
      }, 50);
    });
  }
  sizeCanvas(); restartDrawing(); draw();
  $('#empty-state').hidden = true;
  canvas.hidden = false;
  $('#target-name').textContent = `${nextSource.name}${crop ? ' · 영역 지정' : ''}`;
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    if (screenStream !== stream) return;
    notify('녹화 대상이 종료되었습니다. 다른 대상을 선택해 주세요.');
    source = null;
    if (phase === 'recording') stopRecording();
    else if (phase === 'idle') setPhase('idle');
  });
  setPhase('idle');
  rememberPreferences();
}
async function chooseSources() {
  if (phase !== 'idle' || previewOperation) return;
  clearNotice();
  if (mode === 'region') {
    previewOperation = true;
    try {
      const region = await api.chooseRegion();
      if (!region) return;
      latestRegion = region;
      await syncRegionCapture();
    } catch (error) { notify(`영역을 표시하지 못했습니다. ${error.message}`); }
    finally { previewOperation = false; }
    return;
  }
  $('#source-title').textContent = mode === 'window' ? '녹화할 창 선택' : '녹화할 화면 선택';
  $('#source-help').textContent = '선택한 대상의 실제 화면이 미리보기에 표시됩니다.';
  const list = $('#source-list'); list.replaceChildren();
  if (!$('#source-dialog').open) $('#source-dialog').showModal();
  try {
    const sources = await api.sources(mode === 'window' ? 'window' : 'screen');
    if (!sources.length) { list.textContent = '선택 가능한 대상이 없습니다. 녹화할 프로그램을 열고 새로고침해 주세요.'; return; }
    for (const item of sources) {
      const button = document.createElement('button'); button.className = 'source-card';
      const image = document.createElement('img'); image.src = item.thumbnail; image.alt = '';
      const name = document.createElement('span'); name.textContent = item.name;
      const badge = document.createElement('span'); badge.className = 'source-card-badge'; badge.append(window.recordIcons.create(mode === 'window' ? 'window' : 'monitor'));
      button.append(image, name, badge); list.append(button);
      button.onclick = async () => {
        if (previewOperation) return;
        previewOperation = true;
        $('#source-dialog').close();
        try {
          await connectScreen(item, null);
        } catch (error) { notify(`화면을 가져오지 못했습니다. ${error.message}`); }
        finally { previewOperation = false; }
      };
    }
  } catch (error) { list.textContent = `목록을 불러오지 못했습니다: ${error.message}`; }
}
function applyRegion(region) {
  if (!region || mode !== 'region') return;
  crop = region.crop;
  if (phase === 'idle') sizeCanvas();
  draw();
  $('#target-name').textContent = `지정 영역 · ${Math.round(region.rect.width * region.scaleFactor)} × ${Math.round(region.rect.height * region.scaleFactor)}`;
  $('#choose-source-label').textContent = '영역 테두리 표시';
  window.recordIcons.set('#choose-source [data-icon]', 'region');
}
async function syncRegionCapture() {
  while (mode === 'region' && latestRegion) {
    const region = latestRegion;
    if (source?.id !== region.source.id || source?.width !== region.source.width || !screenStream?.active) await connectScreen(region.source, region.crop);
    if (latestRegion?.source.id === source?.id) { applyRegion(latestRegion); return; }
  }
  if (!latestRegion) resetPreview();
}
api.onRegionChanged(async (region) => {
  latestRegion = region;
  if (mode !== 'region' || previewOperation) return;
  if (source?.id === region.source.id && screenStream?.active) { applyRegion(region); return; }
  if (phase !== 'idle') return;
  previewOperation = true;
  try { await syncRegionCapture(); }
  catch (error) { notify(`영역 미리보기를 갱신하지 못했습니다. ${error.message}`); }
  finally { previewOperation = false; }
});
function resetPreview() {
  stopTracks(screenStream); screenStream = null;
  source = null; crop = null;
  video.srcObject = null; canvas.hidden = true;
  $('#empty-state').hidden = false;
  $('#target-name').textContent = '녹화 대상 없음';
  $('#dimensions').textContent = '';
  setPhase('idle');
}
api.onRegionClosed(() => {
  latestRegion = null;
  resetPreview();
});
async function ensureAudioContext() {
  if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContext();
  await audioContext.resume();
}
async function connectMic() {
  stopTracks(micStream); micStream = null;
  micNode?.disconnect(); micNode = null; analyser = null;
  $('#mic-level').style.width = '0%';
  $('#mic-device').disabled = !$('#microphone').checked;
  if (!$('#microphone').checked) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: $('#mic-device').value ? { exact: $('#mic-device').value } : undefined, echoCancellation: true, noiseSuppression: true }, video: false });
    await ensureAudioContext();
    micNode = audioContext.createMediaStreamSource(micStream);
    analyser = audioContext.createAnalyser(); analyser.fftSize = 256;
    micNode.connect(analyser);
    const selected = micStream.getAudioTracks()[0].getSettings().deviceId;
    await listMicrophones(selected);
    if (!drawTimer) restartDrawing();
  } catch (error) {
    $('#microphone').checked = false; $('#mic-device').disabled = true;
    notify(`마이크를 사용할 수 없습니다. Windows의 마이크 권한과 연결을 확인해 주세요.\n${error.message}`);
    throw error;
  }
}
async function listMicrophones(selected) {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === 'audioinput');
  const previous = selected || $('#mic-device').value;
  $('#mic-device').replaceChildren(new Option('기본 마이크', ''));
  for (const device of devices) $('#mic-device').add(new Option(device.label || `마이크 ${$('#mic-device').length}`, device.deviceId));
  if (previous && ![...$('#mic-device').options].some((option) => option.value === previous)) $('#mic-device').add(new Option('이전 마이크 (연결 안 됨)', previous));
  $('#mic-device').value = previous;
}
async function connectCamera() {
  stopTracks(cameraStream); cameraStream = null;
  $('#webcam-position-row').hidden = !$('#webcam').checked;
  if (!$('#webcam').checked) return;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: false });
    camera.srcObject = cameraStream; await camera.play();
  } catch (error) { $('#webcam').checked = false; $('#webcam-position-row').hidden = true; notify(`웹캠을 사용할 수 없습니다. ${error.message}`); throw error; }
}
async function startRecording() {
  if (initializing || phase !== 'idle' || !source || previewOperation) return;
  clearNotice(); $('#result').hidden = true;
  setPhase('starting');
  try {
    if (captureHasAudio !== $('#system-audio').checked) {
      await connectScreen(source, crop);
      if (mode === 'region') applyRegion(latestRegion);
      setPhase('starting');
    }
    if ($('#system-audio').checked && !screenStream.getAudioTracks().length) throw new Error('시스템 소리 입력을 가져오지 못했습니다. 소리 설정을 확인하거나 시스템 소리를 꺼 주세요.');
    if (!screenStream.getVideoTracks().some((track) => track.readyState === 'live')) throw new Error('녹화 대상이 종료되었습니다. 대상을 다시 선택해 주세요.');
    if ($('#microphone').checked && !micStream?.active) await connectMic();
    if ($('#webcam').checked && !cameraStream?.active) await connectCamera();
    const delay = Number($('#delay').value);
    setPhase('countdown');
    for (let n = delay; n > 0; n--) { $('#countdown').hidden = false; $('#countdown').textContent = n; await new Promise((resolve) => setTimeout(resolve, 1000)); }
    $('#countdown').hidden = true;
    if (!source || !screenStream.getVideoTracks().some((track) => track.readyState === 'live')) throw new Error('녹화 대상이 종료되었습니다. 대상을 다시 선택해 주세요.');
    recordedStream = canvas.captureStream(Number($('#fps').value));
    const audioInputs = [];
    if ($('#system-audio').checked && screenStream.getAudioTracks().length) audioInputs.push(screenStream);
    if ($('#microphone').checked && micStream) audioInputs.push(micStream);
    if (audioInputs.length === 1) {
      // Clone so stopping the recorder does not stop the live capture source.
      audioInputs[0].getAudioTracks().forEach((track) => recordedStream.addTrack(track.clone()));
    } else if (audioInputs.length > 1) {
      await ensureAudioContext();
      audioDestination = audioContext.createMediaStreamDestination();
      for (const stream of audioInputs) audioContext.createMediaStreamSource(stream).connect(audioDestination);
      audioDestination.stream.getAudioTracks().forEach((track) => recordedStream.addTrack(track));
    }
    const hasAudio = recordedStream.getAudioTracks().length > 0;
    const candidates = !hasAudio ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'] : $('#format').value === 'webm' ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'] : ['video/mp4;codecs=vp9,mp4a.40.2', 'video/mp4;codecs=avc1.42001E,mp4a.40.2'];
    const mimeType = candidates.find((mime) => MediaRecorder.isTypeSupported(mime));
    if (!mimeType) throw new Error('현재 환경에서 선택한 녹화 형식을 지원하지 않습니다. 다른 파일 형식을 선택해 주세요.');
    recorder = new MediaRecorder(recordedStream, { mimeType, videoBitsPerSecond: $('#quality').value === 'high' ? 12000000 : 6000000, audioBitsPerSecond: 320000 });
    writeError = null; chunkQueue = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      chunkQueue = chunkQueue.then(async () => {
        if (writeError) return;
        await api.chunk(await event.data.arrayBuffer());
      }).catch((error) => { writeError = error; if (phase === 'recording') stopRecording(); });
    };
    recorder.onerror = (event) => { writeError = event.error || new Error('녹화 장치 오류'); if (phase === 'recording') stopRecording(); };
    await api.begin({ format: $('#format').value, hasAudio, quality: $('#quality').value, fps: Number($('#fps').value) });
    recorder.start(1000);
    startedAt = performance.now(); pausedTime = 0; pauseAt = 0;
    setPhase('recording'); tick(); clockTimer = setInterval(tick, 250);
  } catch (error) {
    $('#countdown').hidden = true;
    stopTracks(recordedStream);
    if (audioContext) { await audioContext.close().catch(() => {}); audioContext = null; micNode = null; analyser = null; }
    await api.abort(); setPhase('idle'); notify(`녹화를 시작하지 못했습니다. ${error.message}`);
  }
}
async function stopRecording() {
  if (phase !== 'recording') return;
  setPhase('saving'); clearInterval(clockTimer); tick();
  try {
    await new Promise((resolve) => { recorder.onstop = resolve; if (recorder.state !== 'inactive') recorder.stop(); else resolve(); });
    await chunkQueue;
    if (writeError) throw writeError;
    const result = await api.finish();
    $('#result-path').textContent = result.path.split(/[\\/]/).pop();
    $('#result-path').title = result.path;
    $('#result').hidden = false;
  } catch (error) {
    const partial = await api.abort();
    notify(`저장하지 못했습니다. ${error.message}${partial ? `\n복구용 원본: ${partial}` : ''}`);
  } finally {
    stopTracks(recordedStream); recordedStream = null;
    if (audioContext) { await audioContext.close().catch(() => {}); audioContext = null; }
    micNode = null; analyser = null;
    setPhase('idle');
    if ($('#microphone').checked) connectMic().catch(() => {});
  }
}
function pauseRecording() {
  if (phase !== 'recording') return;
  if (recorder.state === 'recording') { recorder.pause(); pauseAt = performance.now(); $('#status').textContent = '일시정지'; }
  else if (recorder.state === 'paused') { recorder.resume(); pausedTime += performance.now() - pauseAt; pauseAt = 0; $('#status').textContent = '녹화 중'; }
  tick();
}
api.onWindowState((maximized) => {
  const button = $('[data-window="maximize"]');
  button.setAttribute('aria-label', maximized ? '복원' : '최대화');
  button.title = maximized ? '복원' : '최대화';
  window.recordIcons.set(button.querySelector('[data-icon]'), maximized ? 'restore' : 'maximize');
});
for (const button of document.querySelectorAll('[data-window]')) button.onclick = () => api.window(button.dataset.window);
for (const button of document.querySelectorAll('[data-mode]')) button.onclick = async () => {
  if (phase !== 'idle' || previewOperation) return;
  setCaptureMode(button.dataset.mode);
  rememberPreferences();
  if (mode !== 'region') {
    await api.closeRegion();
    $('#choose-source-label').textContent = '대상 선택';
    window.recordIcons.set('#choose-source [data-icon]', 'down');
  }
  chooseSources();
};
$('#choose-source').onclick = chooseSources; $('#empty-choose').onclick = chooseSources;
$('#refresh-sources').onclick = chooseSources;
$('#close-dialog').onclick = () => $('#source-dialog').close();
function showDirectory(directory) {
  $('#directory').textContent = directory.split(/[\\/]/).filter(Boolean).slice(-2).join(' / ');
  $('#directory').title = directory;
}
$('#choose-folder').onclick = async () => { try { const directory = await api.folder(); if (directory) showDirectory(directory); } catch (error) { notify(error.message); } };
$('#record').onclick = () => phase === 'recording' ? stopRecording() : startRecording();
$('#resolution').onchange = sizeCanvas;
$('#fps').onchange = () => { sizeCanvas(); restartDrawing(); };
$('#microphone').onchange = () => connectMic().catch(() => {});
$('#mic-device').onchange = () => connectMic().catch(() => {});
$('#webcam').onchange = () => connectCamera().catch(() => {});
$('#play-result').onclick = async () => { const error = await api.openFile(); if (error) notify(error); };
$('#reveal-result').onclick = () => api.revealFile();
$('#close-result').onclick = () => { $('#result').hidden = true; };
api.onCommand((command) => {
  if (command === 'toggle') phase === 'recording' ? stopRecording() : startRecording();
  if (command === 'stop') stopRecording();
  if (command === 'pause') pauseRecording();
});
navigator.mediaDevices.addEventListener('devicechange', () => listMicrophones().catch(() => {}));
$('#settings-fields').addEventListener('change', rememberPreferences);
api.onPreferencesError(notify);
window.initializeOnRecord = async () => {
  setPhase('starting');
  try {
    const preferences = await api.preferences();
    for (const [key, selector] of Object.entries(preferenceFields)) {
      if (key === 'micDevice') continue;
      const input = $(selector);
      if (input.type === 'checkbox') input.checked = preferences[key]; else input.value = preferences[key];
    }
    setCaptureMode(preferences.captureMode);
    showDirectory(preferences.directory);
    await listMicrophones(preferences.micDevice);
    if (mode === 'region') {
      // Region creation prepares a target before recording; keep UI controls locked.
      api.regionPhase('idle');
      latestRegion = await api.chooseRegion();
      api.regionPhase('starting');
      await syncRegionCapture();
    } else if (preferences.captureSource?.kind === mode) {
      const sources = await api.sources(mode);
      const saved = preferences.captureSource;
      const item = mode === 'screen' ? sources.find((item) => item.displayId === saved.displayId) || sources[0] : sources.find((item) => item.id === saved.id && item.name === saved.name) || sources.find((item) => item.name === saved.name);
      if (item) await connectScreen(item, null);
      else notify('이전 녹화 창을 찾지 못했습니다. 대상을 다시 선택해 주세요.');
    }
    if ($('#microphone').checked) await connectMic().catch(() => {});
    if ($('#webcam').checked) await connectCamera().catch(() => {});
  } catch (error) { notify(`이전 녹화 설정을 복원하지 못했습니다. ${error.message}`); }
  finally { initializing = false; setPhase('idle'); document.body.dataset.ready = 'true'; }
};
