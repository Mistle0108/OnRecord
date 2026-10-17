const { app, BrowserWindow, desktopCapturer, ipcMain, session, dialog, shell, screen, globalShortcut, powerSaveBlocker } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

let mainWindow, controlsWindow, regionController, preferences;
let selectedSource, captureAudio = false, outputDirectory, recordingFile, fileHandle, lastFile;
let writeQueue = Promise.resolve(), recording = false, busy = false, blocker;
let recordingOptions;
const trusted = (event) => event.sender === mainWindow?.webContents;
const command = (value) => mainWindow?.webContents.send('command', value);
const settings = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false };

function secureWindow(options, file) {
  const win = new BrowserWindow({ icon: path.join(__dirname, 'assets', 'onrecord-icon.png'), ...options, webPreferences: settings });
  win.setContentProtection(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, file));
  return win;
}
function showMain() {
  controlsWindow?.hide();
  mainWindow?.show();
  mainWindow?.focus();
}
function stopBlocker() {
  if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
  blocker = undefined;
}
async function abort() {
  await writeQueue.catch(() => {});
  await fileHandle?.close().catch(() => {});
  fileHandle = null;
  recording = false;
  stopBlocker();
  showMain();
  // Preserve partial footage if recording or conversion fails.
  return recordingFile;
}
app.whenReady().then(async () => {
  const defaultDirectory = path.join(app.getPath('videos'), 'OnRecord');
  preferences = require('./preferences-store')(process.env.ONRECORD_TEST_PREFERENCES || path.join(app.getPath('userData'), 'preferences.json'), defaultDirectory, (error) => {
    console.error('Preferences:', error.message);
    mainWindow?.webContents.send('preferences-error', '설정을 저장하거나 읽지 못했습니다. ' + error.message);
  });
  outputDirectory = process.env.ONRECORD_TEST_OUTPUT || preferences.get().directory;
  await fs.mkdir(outputDirectory, { recursive: true });
  mainWindow = secureWindow({ width: 980, height: 600, minWidth: 880, minHeight: 540, frame: false, backgroundColor: '#f8fafc', title: 'OnRecord' }, 'index.html');
  mainWindow.webContents.once('did-finish-load', () => { mainWindow.webContents.executeJavaScript('window.initializeOnRecord()', true).catch((error) => console.error('Initialize:', error.message)); });
  const sendWindowState = () => mainWindow.webContents.send('window-state', mainWindow.isMaximized());
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
  mainWindow.webContents.on('did-finish-load', sendWindowState);
  regionController = require('./region-controller')({
    mainWindow, createWindow: secureWindow,
    readRegion: () => preferences.get().region,
    onRemember: (region) => preferences.update({ region }),
    onChanged: (state) => mainWindow.webContents.send('region-changed', state),
    onClosed: () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('region-closed'); }
  });
  const area = screen.getPrimaryDisplay().workArea;
  controlsWindow = secureWindow({ width: 350, height: 94, x: area.x + area.width - 374, y: area.y + area.height - 118, frame: false, show: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#ffffff' }, 'controls.html');
  controlsWindow.on('close', (event) => { if (recording) { event.preventDefault(); command('stop'); } });
  mainWindow.on('close', (event) => {
    if (recording || busy) { event.preventDefault(); if (recording) command('stop'); return; }
    controlsWindow?.destroy();
    regionController.close(true);
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents === mainWindow.webContents && ['media', 'display-capture'].includes(permission)));
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((item) => item.id === selectedSource);
      callback(source ? { video: source, ...(captureAudio ? { audio: 'loopback' } : {}) } : {});
    } catch { callback({}); }
  });
  globalShortcut.register('F9', () => command('toggle'));
  globalShortcut.register('F10', () => command('pause'));
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => preferences?.flush());
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopBlocker(); });

ipcMain.handle('preferences', (event) => trusted(event) ? { ...preferences.get(), directory: outputDirectory } : null);
ipcMain.handle('save-preferences', (event, input) => { if (trusted(event)) preferences.update(input); });
ipcMain.handle('sources', async (event, type) => {
  if (!trusted(event)) return [];
  const ownWindows = BrowserWindow.getAllWindows().map((win) => String(win.getMediaSourceId()));
  const sources = await desktopCapturer.getSources({ types: [type === 'window' ? 'window' : 'screen'], thumbnailSize: { width: 400, height: 240 }, fetchWindowIcons: true });
  return sources.filter((source) => !ownWindows.includes(source.id)).map((source) => ({ id: source.id, name: source.name, displayId: source.display_id, thumbnail: source.thumbnail.toDataURL() }));
});
ipcMain.handle('select-source', (event, id, audio) => { if (trusted(event) && !recording) { selectedSource = id; captureAudio = !!audio; } });
ipcMain.handle('folder', async (event) => {
  if (!trusted(event) || recording || busy) return null;
  const result = await dialog.showOpenDialog(mainWindow, { defaultPath: outputDirectory, properties: ['openDirectory', 'createDirectory'] });
  if (!result.canceled) { outputDirectory = result.filePaths[0]; preferences.update({ directory: outputDirectory }); }
  return outputDirectory;
});
ipcMain.handle('begin', async (event, options) => {
  if (!trusted(event) || recording || busy) throw new Error('이미 녹화 또는 저장 중입니다.');
  if (!options || !['mp4', 'webm'].includes(options.format)) throw new Error('녹음 설정이 올바르지 않습니다.');
  recordingOptions = { ...options, hasAudio: !!options.hasAudio };
  await fs.mkdir(outputDirectory, { recursive: true });
  const name = `OnRecord-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const extension = recordingOptions.hasAudio && recordingOptions.format === 'mp4' ? 'mp4' : 'webm';
  recordingFile = path.join(outputDirectory, `${name}.capture.${extension}`);
  fileHandle = await fs.open(recordingFile, 'wx');
  writeQueue = Promise.resolve();
  recording = true;
  blocker = powerSaveBlocker.start('prevent-display-sleep');
  controlsWindow.showInactive();
  return true;
});
ipcMain.handle('chunk', (event, data) => {
  if (!trusted(event) || !fileHandle) throw new Error('저장 파일이 열려 있지 않습니다.');
  const handle = fileHandle;
  writeQueue = writeQueue.then(async () => {
    const buffer = Buffer.from(data);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
      if (!bytesWritten) throw new Error('저장 공간을 확인해 주세요.');
      offset += bytesWritten;
    }
  });
  return writeQueue;
});
ipcMain.handle('finish', async (event) => {
  if (!trusted(event) || !recording) throw new Error('진행 중인 녹화가 없습니다.');
  busy = true;
  try {
    await writeQueue;
    await fileHandle.close(); fileHandle = null;
    recording = false; stopBlocker(); showMain();
    const options = recordingOptions;
    const output = recordingFile.replace(/\.capture\.(mp4|webm)$/, `.${options.format}`);
    if (options.format === 'webm') {
      await fs.rename(recordingFile, output);
      lastFile = output;
      return { path: lastFile };
    }
    const ffmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
    await new Promise((resolve, reject) => {
      const process = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', recordingFile, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', options.quality === 'high' ? '19' : '24', '-r', options.fps === 60 ? '60' : '30', '-pix_fmt', 'yuv420p', '-c:a', 'copy', ...(options.format === 'mp4' ? ['-movflags', '+faststart'] : []), output], { windowsHide: true });
      let error = '';
      process.stderr.on('data', (data) => { error = (error + data).slice(-4000); });
      process.on('error', reject);
      process.on('close', (code) => code === 0 ? resolve() : reject(new Error(`영상 저장 실패. 원본 보존: ${recordingFile}\n${error}`)));
    });
    lastFile = output;
    await fs.unlink(recordingFile);
    return { path: lastFile };
  } catch (error) { await abort(); throw error; }
  finally { busy = false; }
});
ipcMain.handle('abort', async (event) => { if (trusted(event)) return abort(); });
ipcMain.on('state', (event, state) => { if (trusted(event)) controlsWindow?.webContents.send('state', state); });
ipcMain.on('command', (event, value) => { if (event.sender === controlsWindow?.webContents && ['stop', 'pause'].includes(value)) command(value); });
ipcMain.on('window', (event, action) => {
  if (!trusted(event)) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  if (action === 'close') mainWindow.close();
});
ipcMain.handle('open-file', (event) => { if (trusted(event) && lastFile) return shell.openPath(lastFile); });
ipcMain.handle('reveal-file', (event) => { if (trusted(event) && lastFile) shell.showItemInFolder(lastFile); });
