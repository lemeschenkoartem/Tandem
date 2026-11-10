'use strict';
globalThis.TandemPlayer = {
  create({ state, input, motion, error, nativeExit }) {
    const stage = document.getElementById('stage'), video = document.getElementById('video');
    const capture = document.getElementById('capture-pointer'), cursor = document.getElementById('virtual-cursor');
    const virtual = { x: 0.5, y: 0.5 };
    let hostCursorHidden = false;
    const locked = () => document.pointerLockElement === video;
    const box = () => TandemQuality.videoBox(video.getBoundingClientRect(), video.videoWidth, video.videoHeight);
    const release = () => { if (state().controlling) input({ kind: 'release' }); };
    function refresh() {
      const s = state(), full = Boolean(document.fullscreenElement);
      const needsCapture = s.controlling && !locked() && (full || s.mode === 'game');
      stage.classList.toggle('captured', locked());
      stage.classList.toggle('host-cursor-hidden', s.hideCursor && hostCursorHidden && s.controlling);
      capture.hidden = !needsCapture;
      document.getElementById('fullscreen-tip').hidden = !full;
      cursor.hidden = !(s.controlling && locked() && (s.mode === 'desktop' || !s.hideCursor));
      if (!cursor.hidden) { const b = box(), r = stage.getBoundingClientRect(); cursor.style.left = `${b.left - r.left + (s.mode === 'game' ? 0.5 : virtual.x) * b.width}px`; cursor.style.top = `${b.top - r.top + (s.mode === 'game' ? 0.5 : virtual.y) * b.height}px`; }
      document.getElementById('mouse-lock').textContent = locked() ? 'Мышь захвачена · Esc' : 'Захват мыши';
    }
    async function lock() {
      if (!state().controlling || locked()) return;
      stage.focus();
      try { await video.requestPointerLock({ unadjustedMovement: true }); }
      catch { await video.requestPointerLock(); }
      stage.focus(); refresh();
    }
    async function exitFullscreen() {
      release();
      if (document.pointerLockElement) document.exitPointerLock();
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      await nativeExit?.(); refresh();
    }
    async function fullscreen() {
      if (document.fullscreenElement) return exitFullscreen();
      stage.focus();
      // Start pointer lock before fullscreen consumes the transient user gesture.
      const pointer = state().controlling ? lock().catch(() => {}) : Promise.resolve();
      await stage.requestFullscreen(); await pointer; refresh();
    }
    function canInput() {
      const s = state();
      return s.controlling && (locked() || (s.mode === 'desktop' && !document.fullscreenElement && document.activeElement === stage));
    }
    document.addEventListener('mousemove', event => {
      const s = state(); if (!s.controlling) return;
      if (locked()) {
        if (s.mode === 'game') motion({ kind: 'relative', dx: event.movementX, dy: event.movementY });
        else {
          const b = box();
          virtual.x = Math.max(0, Math.min(1, virtual.x + event.movementX / Math.max(1, b.width)));
          virtual.y = Math.max(0, Math.min(1, virtual.y + event.movementY / Math.max(1, b.height)));
          motion({ kind: 'move', ...virtual });
          const r = stage.getBoundingClientRect(); cursor.style.left = `${b.left - r.left + virtual.x * b.width}px`; cursor.style.top = `${b.top - r.top + virtual.y * b.height}px`;
        }
      } else if (canInput() && stage.contains(event.target)) {
        const point = TandemQuality.point(box(), event.clientX, event.clientY); if (point) motion(point);
      }
    });
    stage.addEventListener('mousedown', event => {
      if (event.target.closest('button')) return;
      stage.focus();
      if (!state().controlling || ![0, 1, 2].includes(event.button)) return;
      event.preventDefault();
      if (!canInput()) { lock().catch(error); return; }
      if (!locked()) { const point = TandemQuality.point(box(), event.clientX, event.clientY); if (!point) return; input(point); }
      input({ kind: 'button', button: event.button, down: true });
    });
    window.addEventListener('mouseup', event => { if (state().controlling && [0, 1, 2].includes(event.button)) input({ kind: 'button', button: event.button, down: false }); });
    stage.addEventListener('contextmenu', event => event.preventDefault());
    stage.addEventListener('wheel', event => { if (canInput()) { event.preventDefault(); input({ kind: 'wheel', delta: -Math.sign(event.deltaY) * 120 }); } }, { passive: false });
    for (const type of ['keydown', 'keyup']) window.addEventListener(type, event => {
      if (event.ctrlKey && !event.altKey && event.code === 'F12') { event.preventDefault(); event.stopImmediatePropagation(); if (type === 'keydown') exitFullscreen().catch(error); return; }
      if (event.ctrlKey && event.altKey && event.code === 'F12') return;
      if (!canInput() || (!locked() && document.activeElement !== stage)) return;
      if (event.code === 'Escape' && locked()) { release(); return; }
      event.preventDefault(); if (!event.repeat) input({ kind: 'key', code: event.code, down: type === 'keydown' });
    }, true);
    window.addEventListener('blur', release); stage.addEventListener('blur', () => { if (!locked()) release(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
    document.addEventListener('pointerlockchange', () => { if (!locked()) release(); else stage.focus(); refresh(); });
    document.addEventListener('fullscreenchange', refresh);
    capture.onclick = () => lock().catch(error);
    return { lock, fullscreen, exitFullscreen, release, refresh, hostCursor: visible => { hostCursorHidden = visible === false; refresh(); }, unlock: () => { release(); if (locked()) document.exitPointerLock(); refresh(); } };
  }
};
