import { EASINGS, getEasing } from './animator.js';

let nextClipId = 1;

export const CLIP_META = {
  open:  { label: 'Obrir llibre',    color: '#22c55e', track: 0, defaultDur: 1.0 },
  flip:  { label: 'Passar pàgines',  color: '#f59e0b', track: 1, defaultDur: 3.6 },
  close: { label: 'Tancar llibre',   color: '#a855f7', track: 0, defaultDur: 1.0 },
  turn:  { label: 'Volta 360º',      color: '#4f7cff', track: 2, defaultDur: 4.0 },
};

export const TIMELINE_PRESETS = {
  flip: () => [
    makeClip('open',  0.0, 1.0),
    makeClip('flip',  0.35, 3.6, { sheets: 20 }),
    makeClip('close', 3.5, 1.0),
  ],
  turn360: () => [
    makeClip('turn', 0.0, 4.0, { angle: 360, easing: 'cubic' }),
  ],
  combo: () => [
    makeClip('open',  0.6,  1.0,  { easing: 'cubic' }),
    makeClip('flip',  1.05, 2.95, { easing: 'cubic', sheets: 20 }),
    makeClip('close', 3.5,  1.0,  { easing: 'cubic' }),
    makeClip('turn',  3.05, 2.45, { angle: 360, easing: 'cubic' }),
  ],
};

export function makeClip(type, start, duration, extra = {}) {
  const meta = CLIP_META[type] || CLIP_META.turn;
  const clip = {
    id: `c${nextClipId++}`,
    type,
    start: Math.max(0, Math.round(start * 20) / 20),
    duration: Math.max(0.2, Math.round((duration ?? meta.defaultDur) * 20) / 20),
    angle: type === 'turn' ? (extra.angle ?? 360) : undefined,
    easing: extra.easing ?? 'cubic',
    sheets: type === 'flip' ? (extra.sheets ?? 20) : undefined,
  };
  return clip;
}

export function getClipLabel(clip) {
  if (clip.type === 'turn') {
    const dir = clip.angle >= 0 ? '↻' : '↺';
    return `${dir} Volta ${Math.abs(clip.angle)}º`;
  }
  if (clip.type === 'flip') return `Pàgines (${clip.sheets || 20})`;
  return CLIP_META[clip.type]?.label || clip.type;
}

export function getTimelineDuration(clips) {
  if (!clips || !clips.length) return 4.0;
  let maxEnd = 0;
  for (const c of clips) {
    maxEnd = Math.max(maxEnd, c.start + c.duration);
  }
  return Math.max(0.5, Math.round(maxEnd * 100) / 100);
}

/**
 * Deterministic timeline evaluator for any timeSec in [0 .. totalDuration].
 * Supports overlapping clips across tracks (e.g., flipping pages while opening/closing,
 * or rotating while flipping!).
 */
export function evaluateTimeline(clips, timeSec) {
  const t = Math.max(0, timeSec);
  const smooth = EASINGS.cubic;

  let rotY = 0;
  let openAmount = 0;
  let flipProgress = 0;
  let flipSheetCount = 20;

  // Sort clips by start time so sequential open/close/flip clips combine naturally
  const sorted = [...clips].sort((a, b) => a.start - b.start);

  for (const c of sorted) {
    const localRaw = (t - c.start) / Math.max(0.001, c.duration);
    const local = Math.max(0, Math.min(1, localRaw));
    const ease = getEasing(c.easing || 'cubic');

    if (c.type === 'turn') {
      rotY += (c.angle ?? 360) * ease(local);
    } else if (c.type === 'open') {
      openAmount += smooth(local);
    } else if (c.type === 'close') {
      openAmount -= smooth(local);
    } else if (c.type === 'flip') {
      if (t >= c.start) {
        flipSheetCount = c.sheets ?? 20;
        flipProgress = EASINGS.sine(local);
      }
    }
  }

  return {
    rotY,
    rotX: 0,
    posX: 0,
    openAmount: Math.max(0, Math.min(1, openAmount)),
    flipProgress: Math.max(0, Math.min(1, flipProgress)),
    flipSheetCount,
  };
}

/**
 * Interactive multi-track timeline DOM controller:
 * - Drag clips horizontally to change start time
 * - Drag left/right edges to resize clip duration
 * - Click clip to select & edit properties (angle, easing, sheets, delete)
 * - Drag ruler/playhead to scrub smoothly
 */
export class TimelineUI {
  constructor(rootEl, callbacks) {
    this.root = rootEl;
    this.cb = callbacks; // { getClips, setClips, getTime, setTime, onCommit, onSelect }
    this.selectedId = null;
    this.dragState = null;

    this.rulerEl = rootEl.querySelector('#tl-ruler');
    this.tracksEl = rootEl.querySelector('#tl-tracks');
    this.playheadEl = rootEl.querySelector('#tl-playhead');
    this.inspectorEl = rootEl.querySelector('#tl-inspector');

    this._bindGlobalPointer();
    this._bindRulerScrub();
  }

  getDisplayMaxTime() {
    const dur = getTimelineDuration(this.cb.getClips());
    return Math.max(5.0, Math.ceil(dur + 1.0));
  }

  selectClip(id) {
    this.selectedId = id;
    this.render();
    this.cb.onSelect?.(this.getSelectedClip());
  }

  getSelectedClip() {
    return this.cb.getClips().find((c) => c.id === this.selectedId) || null;
  }

  _bindRulerScrub() {
    const scrubAtClientX = (clientX) => {
      const rect = this.tracksEl.getBoundingClientRect();
      if (rect.width <= 0) return;
      const maxT = this.getDisplayMaxTime();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const dur = getTimelineDuration(this.cb.getClips());
      const t = Math.min(dur, frac * maxT);
      this.cb.setTime(t);
    };

    const startScrub = (e) => {
      e.preventDefault();
      this.dragState = { mode: 'scrub' };
      scrubAtClientX(e.clientX);
    };

    this.rulerEl.addEventListener('pointerdown', startScrub);
    this.tracksEl.addEventListener('pointerdown', (e) => {
      // Only scrub on empty track space (clips stopPropagation on their own pointerdown)
      if (e.target.closest?.('.tl-clip')) return;
      startScrub(e);
    });

    // Hover skimming (Final Cut style): moving mouse over ruler or tracks previews that exact time
    // automatically whenever not actively playing or dragging a clip!
    const onHoverMove = (e) => {
      if (this.dragState) return;
      if (this.cb.isPlaying?.()) return;
      // Don't skim while hovering directly on resize handles so user can grab them calmly
      if (e.target.classList?.contains('tl-handle')) return;
      scrubAtClientX(e.clientX);
    };

    this.rulerEl.addEventListener('pointermove', onHoverMove);
    this.tracksEl.addEventListener('pointermove', onHoverMove);

    this._scrubAtClientX = scrubAtClientX;
  }

  _bindGlobalPointer() {
    window.addEventListener('pointermove', (e) => {
      if (!this.dragState) return;
      if (this.dragState.mode === 'scrub') {
        this._scrubAtClientX(e.clientX);
        return;
      }

      const rect = this.tracksEl.getBoundingClientRect();
      // Keep scale frozen during drag so the clip never jumps under the cursor!
      const maxT = this.dragState.frozenMaxT;
      const dxSec = ((e.clientX - this.dragState.startX) / rect.width) * maxT;

      const clips = this.cb.getClips();
      const clip = clips.find((c) => c.id === this.dragState.clipId);
      if (!clip) return;

      const snap = (v) => Math.round(v * 20) / 20; // 0.05s snap

      if (this.dragState.mode === 'move') {
        clip.start = Math.max(0, snap(this.dragState.origStart + dxSec));
      } else if (this.dragState.mode === 'resize-right') {
        clip.duration = Math.max(0.2, snap(this.dragState.origDuration + dxSec));
      } else if (this.dragState.mode === 'resize-left') {
        const end = this.dragState.origStart + this.dragState.origDuration;
        const newStart = Math.max(0, Math.min(end - 0.2, snap(this.dragState.origStart + dxSec)));
        clip.start = newStart;
        clip.duration = Math.max(0.2, snap(end - newStart));
      }

      // Update dragged clip DOM directly (no full DOM rebuild mid-drag -> ultra smooth!)
      const clipEl = this.tracksEl.querySelector(`.tl-clip[data-id="${clip.id}"]`);
      if (clipEl) {
        clipEl.style.left = `${(clip.start / maxT) * 100}%`;
        clipEl.style.width = `${Math.max(2, (clip.duration / maxT) * 100)}%`;
        const durEl = clipEl.querySelector('.tl-clip-dur');
        if (durEl) durEl.textContent = `${clip.duration.toFixed(1)}s`;
      }
      const inspStart = this.inspectorEl?.querySelector('#insp-start');
      const inspDur = this.inspectorEl?.querySelector('#insp-dur');
      if (inspStart) inspStart.value = clip.start.toFixed(2);
      if (inspDur) inspDur.value = clip.duration.toFixed(2);

      this.cb.setClips(clips, false);
    });

    window.addEventListener('pointerup', () => {
      if (!this.dragState) return;
      const wasClipDrag = this.dragState.mode !== 'scrub';
      this.dragState = null;
      if (wasClipDrag) {
        this.render(); // Unfreeze scale smoothly on drop
        this.cb.onCommit?.();
      }
    });
  }

  getActiveDisplayMaxTime() {
    if (this.dragState && this.dragState.frozenMaxT) {
      return this.dragState.frozenMaxT;
    }
    return this.getDisplayMaxTime();
  }

  updatePlayhead() {
    const maxT = this.getActiveDisplayMaxTime();
    const t = this.cb.getTime();
    const pct = Math.max(0, Math.min(100, (t / maxT) * 100));
    this.playheadEl.style.left = `${pct}%`;
  }

  render() {
    const clips = this.cb.getClips();
    const maxT = this.getActiveDisplayMaxTime();
    const totalDur = getTimelineDuration(clips);

    // 1. Render ruler ticks
    this.rulerEl.innerHTML = '';
    const step = maxT > 12 ? 2 : 1;
    for (let s = 0; s <= maxT; s += step) {
      const tick = document.createElement('div');
      tick.className = 'tl-tick';
      tick.style.left = `${(s / maxT) * 100}%`;
      tick.textContent = `${s}s`;
      this.rulerEl.appendChild(tick);
    }

    // End-of-timeline marker
    const endMarker = document.createElement('div');
    endMarker.className = 'tl-end-marker';
    endMarker.style.left = `${(totalDur / maxT) * 100}%`;
    this.rulerEl.appendChild(endMarker);

    // 2. Render 3 track lanes: 0=Obrir/Tancar, 1=Pàgines, 2=Volta/Gir
    const laneNames = ['Tapes', 'Pàgines', 'Gir'];
    this.tracksEl.innerHTML = '';

    for (let laneIdx = 0; laneIdx < 3; laneIdx++) {
      const lane = document.createElement('div');
      lane.className = 'tl-lane';
      const label = document.createElement('span');
      label.className = 'tl-lane-label';
      label.textContent = laneNames[laneIdx];
      lane.appendChild(label);

      const laneClips = clips.filter((c) => (CLIP_META[c.type]?.track ?? 2) === laneIdx);
      for (const clip of laneClips) {
        const el = document.createElement('div');
        el.className = `tl-clip ${clip.id === this.selectedId ? 'selected' : ''}`;
        el.dataset.id = clip.id;
        el.style.left = `${(clip.start / maxT) * 100}%`;
        el.style.width = `${Math.max(2, (clip.duration / maxT) * 100)}%`;
        el.style.setProperty('--clip-color', CLIP_META[clip.type]?.color || '#4f7cff');

        el.innerHTML = `
          <div class="tl-handle left" data-handle="left" title="Arrossega per ajustar l'inici"><span></span></div>
          <span class="tl-clip-title">${getClipLabel(clip)}</span>
          <span class="tl-clip-dur">${clip.duration.toFixed(1)}s</span>
          <div class="tl-handle right" data-handle="right" title="Arrossega per allargar o escurçar"><span></span></div>
        `;

        el.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const handleEl = e.target.closest?.('.tl-handle');
          const handle = handleEl?.dataset?.handle;
          this.dragState = {
            mode: handle === 'left' ? 'resize-left' : handle === 'right' ? 'resize-right' : 'move',
            clipId: clip.id,
            startX: e.clientX,
            origStart: clip.start,
            origDuration: clip.duration,
            frozenMaxT: this.getDisplayMaxTime(),
          };
          if (this.selectedId !== clip.id) {
            this.selectClip(clip.id);
          }
        });

        lane.appendChild(el);
      }

      this.tracksEl.appendChild(lane);
    }

    this.tracksEl.appendChild(this.playheadEl);
    this.updatePlayhead();
    this._renderInspector();
  }

  _renderInspector() {
    if (!this.inspectorEl) return;
    const clip = this.getSelectedClip();
    if (!clip) {
      this.inspectorEl.innerHTML = `<span class="tl-insp-hint">Clica un clip per editar-lo · Arrossega per moure · Estira les vores per canviar la durada</span>`;
      return;
    }

    let extraHtml = '';
    if (clip.type === 'turn') {
      const isCW = clip.angle >= 0;
      const absAngle = Math.abs(clip.angle || 360);
      extraHtml = `
        <div class="tl-dir-toggle" title="Sentit de gir">
          <button id="insp-dir-cw" class="tl-dir-btn ${isCW ? 'active' : ''}">↻ Sentit rellotge</button>
          <button id="insp-dir-ccw" class="tl-dir-btn ${!isCW ? 'active' : ''}">↺ Al revés</button>
        </div>
        <label>Volta:
          <select id="insp-angle-mag">
            <option value="360" ${absAngle === 360 ? 'selected' : ''}>360º</option>
            <option value="180" ${absAngle === 180 ? 'selected' : ''}>180º</option>
          </select>
        </label>
        <label>Frenada:
          <select id="insp-easing">
            <option value="cubic" ${clip.easing === 'cubic' ? 'selected' : ''}>Cubic</option>
            <option value="quart" ${clip.easing === 'quart' ? 'selected' : ''}>Quartic</option>
            <option value="quint" ${clip.easing === 'quint' ? 'selected' : ''}>Quintic</option>
            <option value="sine" ${clip.easing === 'sine' ? 'selected' : ''}>Sine</option>
          </select>
        </label>
      `;
    } else if (clip.type === 'flip') {
      extraHtml = `
        <label>Fulles:
          <input id="insp-sheets" type="number" min="4" max="30" step="1" value="${clip.sheets || 20}" />
        </label>
      `;
    }

    this.inspectorEl.innerHTML = `
      <span class="tl-insp-badge" style="background:${CLIP_META[clip.type]?.color}">${getClipLabel(clip)}</span>
      <label>Inici (s):
        <input id="insp-start" type="number" min="0" max="60" step="0.1" value="${clip.start.toFixed(2)}" />
      </label>
      <label>Durada (s):
        <input id="insp-dur" type="number" min="0.2" max="30" step="0.1" value="${clip.duration.toFixed(2)}" />
      </label>
      ${extraHtml}
      <button id="insp-delete" class="tl-del-btn" title="Eliminar clip">✕ Eliminar</button>
    `;

    const commitUpdate = (fn) => {
      const clips = this.cb.getClips();
      const target = clips.find((c) => c.id === clip.id);
      if (!target) return;
      fn(target);
      this.cb.setClips(clips, true);
      this.render();
    };

    this.inspectorEl.querySelector('#insp-start')?.addEventListener('change', (e) => {
      commitUpdate((c) => { c.start = Math.max(0, parseFloat(e.target.value) || 0); });
    });
    this.inspectorEl.querySelector('#insp-dur')?.addEventListener('change', (e) => {
      commitUpdate((c) => { c.duration = Math.max(0.2, parseFloat(e.target.value) || 0.5); });
    });
    this.inspectorEl.querySelector('#insp-dir-cw')?.addEventListener('click', () => {
      commitUpdate((c) => { c.angle = Math.abs(c.angle || 360); });
    });
    this.inspectorEl.querySelector('#insp-dir-ccw')?.addEventListener('click', () => {
      commitUpdate((c) => { c.angle = -Math.abs(c.angle || 360); });
    });
    this.inspectorEl.querySelector('#insp-angle-mag')?.addEventListener('change', (e) => {
      const mag = parseFloat(e.target.value) || 360;
      commitUpdate((c) => { c.angle = (c.angle >= 0 ? 1 : -1) * mag; });
    });
    this.inspectorEl.querySelector('#insp-easing')?.addEventListener('change', (e) => {
      commitUpdate((c) => { c.easing = e.target.value; });
    });
    this.inspectorEl.querySelector('#insp-sheets')?.addEventListener('change', (e) => {
      commitUpdate((c) => { c.sheets = Math.max(4, Math.min(30, parseInt(e.target.value, 10) || 20)); });
    });
    this.inspectorEl.querySelector('#insp-delete')?.addEventListener('click', () => {
      const next = this.cb.getClips().filter((c) => c.id !== clip.id);
      this.selectedId = null;
      this.cb.setClips(next, true);
      this.render();
    });
  }
}
