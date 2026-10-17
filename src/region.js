let state, drag;
window.onrecord.onRegionState((value) => {
  state = value;
  const recording = value.phase === 'recording';
  document.body.classList.toggle('recording', recording);
  document.body.classList.toggle('toolbar-inside', value.toolbarInside);
  document.body.classList.toggle('locked', value.phase !== 'idle');
  document.body.classList.toggle('busy', !['idle', 'recording'].includes(value.phase));
  document.querySelector('#region-close').disabled = value.phase !== 'idle';
  document.querySelector('#region-size').textContent = `${recording ? '녹화 중' : '녹화 영역'} · ${Math.round(value.rect.width * value.scaleFactor)} × ${Math.round(value.rect.height * value.scaleFactor)}`;
});
document.addEventListener('pointerdown', (event) => {
  const edge = event.target.closest('[data-edge]')?.dataset.edge;
  if (!state || !edge || event.button !== 0 || !['idle', 'recording'].includes(state.phase) || (state.phase === 'recording' && edge !== 'move')) return;
  drag = { edge, x: event.screenX, y: event.screenY, rect: { ...state.rect } };
  event.target.setPointerCapture(event.pointerId);
  event.preventDefault();
});
document.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
  const rect = { ...drag.rect }, edge = drag.edge;
  if (edge === 'move') { rect.x += dx; rect.y += dy; }
  else {
    if (edge.includes('e')) rect.width = Math.max(64, rect.width + dx);
    if (edge.includes('s')) rect.height = Math.max(64, rect.height + dy);
    if (edge.includes('w')) { rect.width = Math.max(64, drag.rect.width - dx); rect.x = drag.rect.x + drag.rect.width - rect.width; }
    if (edge.includes('n')) { rect.height = Math.max(64, drag.rect.height - dy); rect.y = drag.rect.y + drag.rect.height - rect.height; }
  }
  window.onrecord.updateRegion({ action: edge === 'move' ? 'move' : 'resize', rect });
});
document.addEventListener('pointerup', () => { drag = null; });
document.addEventListener('pointercancel', () => { drag = null; });
document.querySelector('#region-close').onclick = () => window.onrecord.closeRegion();
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state?.phase === 'idle') window.onrecord.closeRegion(); });
