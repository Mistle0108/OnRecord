const fs = require('node:fs');
const path = require('node:path');

module.exports = function createPreferencesStore(file, defaultDirectory, onError) {
  let timer, dirty = false;
  const values = { directory: defaultDirectory, systemAudio: true, microphone: false, micDevice: '', resolution: '1080', fps: '30', quality: 'high', format: 'mp4', webcam: false, webcamPosition: 'bottom-right', delay: '3', captureMode: 'screen', captureSource: null, region: null };
  function apply(input) {
    if (!input || typeof input !== 'object') return;
    for (const key of ['systemAudio', 'microphone', 'webcam']) if (typeof input[key] === 'boolean') values[key] = input[key];
    const choices = { resolution: ['1080', '720', 'native'], fps: ['30', '60'], quality: ['high', 'standard'], format: ['mp4', 'webm'], webcamPosition: ['bottom-right', 'bottom-left', 'top-right', 'top-left'], delay: ['0', '3', '5'], captureMode: ['screen', 'window', 'region'] };
    for (const [key, options] of Object.entries(choices)) if (options.includes(input[key])) values[key] = input[key];
    if (typeof input.micDevice === 'string') values.micDevice = input.micDevice;
    if (typeof input.directory === 'string' && path.isAbsolute(input.directory)) values.directory = input.directory;
    const source = input.captureSource;
    if (source && ['screen', 'window'].includes(source.kind) && typeof source.name === 'string') values.captureSource = { kind: source.kind, name: source.name, id: String(source.id || ''), displayId: String(source.displayId || '') };
    const region = input.region;
    if (region?.rect && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(region.rect[key])) && region.rect.width >= 64 && region.rect.height >= 64) values.region = { displayId: String(region.displayId || ''), rect: { x: region.rect.x, y: region.rect.y, width: region.rect.width, height: region.rect.height } };
  }
  try { apply(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') onError(error); }
  function flush() {
    clearTimeout(timer);
    if (!dirty) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(values, null, 2), 'utf8');
      fs.renameSync(`${file}.tmp`, file);
      dirty = false;
    } catch (error) { onError(error); }
  }
  return {
    get: () => structuredClone(values),
    update: (input) => { apply(input); dirty = true; clearTimeout(timer); timer = setTimeout(flush, 250); return structuredClone(values); },
    flush
  };
};
