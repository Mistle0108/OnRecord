document.querySelector('#pause').onclick = () => window.onrecord.command('pause');
document.querySelector('#stop').onclick = () => window.onrecord.command('stop');
window.onrecord.onState((state) => {
  document.querySelector('#controls-timer').textContent = state.time;
  document.querySelector('#controls-label').textContent = state.paused ? '일시정지 · F10 재개' : '녹화 중 · F9 종료';
  window.recordIcons.set('#pause [data-icon]', state.paused ? 'play' : 'pause');
  document.querySelector('#pause').setAttribute('aria-pressed', String(state.paused));
  document.querySelector('#pause').title = state.paused ? '녹화 재개 (F10)' : '일시정지 (F10)';
  document.body.classList.toggle('paused', state.paused);
  document.querySelector('#pause').setAttribute('aria-label', state.paused ? '녹화 재개' : '일시정지');
});
