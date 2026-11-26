import {
  loadCoverPdf,
  loadInteriorPdf,
  sliceCoverCanvas,
  detectBookFormat,
} from './pdfLoader.js';
import { Book3DEngine } from './book3d.js';
import {
  TimelineUI,
  TIMELINE_PRESETS,
  makeClip,
  evaluateTimeline,
  getTimelineDuration,
} from './timeline.js';
import { exportBookVideo } from './exporter.js';

const $ = (id) => document.getElementById(id);

const canvas = $('three-canvas');
const viewport = $('viewport-container');
const engine = new Book3DEngine(canvas);

// App state
const state = {
  coverBuffer: null,
  coverData: null,
  interiorData: null,
  extraCoverCropMm: 0,
  animConfig: {
    turnDuration: 4.0,
    turnAngle: 360,
    easing: 'cubic',
    flipDuration: 4.5,
    flipSheetCount: 20,
  },
  clips: TIMELINE_PRESETS.combo(),
  playback: {
    active: false,
    startTime: 0,
    timeSec: 0,
  },
  exportAbort: null,
  history: {
    stack: [],
    index: -1,
    restoring: false,
  },
};

// ---------------- UNDO / REDO HISTORY ----------------
function cloneClips(clips) {
  return clips.map((c) => ({ ...c }));
}

function captureSnapshot() {
  return {
    userTransform: { ...engine.userTransform },
    cameraPos: engine.camera.position.toArray(),
    controlsTarget: engine.controls.target.toArray(),
    format: {
      coverType: engine.format.coverType,
      spineWidthMm: engine.format.spineWidthMm,
      boardThicknessMm: engine.format.boardThicknessMm,
      maxOpenAngleDeg: engine.format.maxOpenAngleDeg,
      finish: engine.format.finish,
    },
    bgColor: engine.bgColor,
    shadowEnabled: engine.shadowEnabled,
    keyLight: engine.keyLight.intensity,
    animConfig: { ...state.animConfig },
    clips: cloneClips(state.clips),
    openAmount: engine.animOffset.openAmount,
    flipProgress: engine.animOffset.flipProgress,
  };
}

function snapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function updateHistoryButtons() {
  $('btn-undo').disabled = state.history.index <= 0;
  $('btn-redo').disabled = state.history.index >= state.history.stack.length - 1;
}

function pushHistory() {
  if (state.history.restoring) return;
  const snap = captureSnapshot();
  const cur = state.history.stack[state.history.index];
  if (cur && snapshotsEqual(cur, snap)) return;

  state.history.stack = state.history.stack.slice(0, state.history.index + 1);
  state.history.stack.push(snap);
  if (state.history.stack.length > 60) {
    state.history.stack.shift();
  } else {
    state.history.index++;
  }
  updateHistoryButtons();
}

function applySnapshot(snap) {
  state.history.restoring = true;
  try {
    stopAnimation();
    Object.assign(engine.userTransform, snap.userTransform);
    engine.camera.position.fromArray(snap.cameraPos);
    engine.controls.target.fromArray(snap.controlsTarget);
    engine.controls.update();

    const formatChanged =
      engine.format.coverType !== snap.format.coverType ||
      engine.format.spineWidthMm !== snap.format.spineWidthMm ||
      engine.format.boardThicknessMm !== snap.format.boardThicknessMm ||
      engine.format.finish !== snap.format.finish;

    if (formatChanged) {
      const spineChanged = engine.format.spineWidthMm !== snap.format.spineWidthMm;
      engine.updateFormat(snap.format);
      if (spineChanged) applyCoverTextures();
      setCoverTypeUI(snap.format.coverType);
      $('slider-spine').value = snap.format.spineWidthMm;
      $('val-spine').textContent = `${snap.format.spineWidthMm.toFixed(1)} mm`;
      $('slider-board-thick').value = snap.format.boardThicknessMm;
      $('val-board-thick').textContent = `${snap.format.boardThicknessMm.toFixed(1)} mm`;
      $('slider-finish').value = Math.round(snap.format.finish * 100);
      $('val-finish').textContent = `${Math.round(snap.format.finish * 100)}%`;
      if (state.coverData || state.interiorData) {
        updateDetectedInfoUI(detectBookFormat(state.coverData, state.interiorData));
      }
    }

    if (snap.format.maxOpenAngleDeg !== undefined) {
      engine.format.maxOpenAngleDeg = snap.format.maxOpenAngleDeg;
      $('slider-open-angle').value = snap.format.maxOpenAngleDeg;
      $('val-open-angle').textContent = `${snap.format.maxOpenAngleDeg}°`;
    }

    engine.setBackgroundColor(snap.bgColor);
    $('bg-color-picker').value = snap.bgColor;
    engine.setShadowEnabled(snap.shadowEnabled);
    $('chk-shadow').checked = snap.shadowEnabled;
    engine.setKeyLightIntensity(snap.keyLight);
    $('slider-light').value = snap.keyLight;
    $('val-light').textContent = snap.keyLight.toFixed(2);

    Object.assign(state.animConfig, snap.animConfig);
    if (snap.clips) {
      state.clips = cloneClips(snap.clips);
      timelineUI?.render();
      updateTimelineUI(Math.min(state.playback.timeSec, getTimelineDuration(state.clips)));
    }
    $('slider-turn-duration').value = snap.animConfig.turnDuration;
    $('val-turn-duration').textContent = `${snap.animConfig.turnDuration.toFixed(1)} s`;
    $('select-turn-angle').value = String(snap.animConfig.turnAngle);
    $('select-easing').value = snap.animConfig.easing;
    $('slider-flip-duration').value = snap.animConfig.flipDuration;
    $('val-flip-duration').textContent = `${snap.animConfig.flipDuration.toFixed(1)} s`;
    $('slider-flip-pages').value = snap.animConfig.flipSheetCount;
    $('val-flip-pages').textContent = `${snap.animConfig.flipSheetCount} fulles`;

    engine.animOffset.openAmount = snap.openAmount;
    engine.animOffset.flipProgress = snap.flipProgress;
    engine.animOffset.flipSheetCount = snap.animConfig.flipSheetCount;
    engine.animOffset.rotX = 0;
    engine.animOffset.rotY = 0;
    engine.applyState();

    // Sync transform sliders
    $('slider-rot-x').value = snap.userTransform.rotX;
    $('val-rot-x').textContent = `${snap.userTransform.rotX}°`;
    $('slider-rot-y').value = snap.userTransform.rotY;
    $('val-rot-y').textContent = `${snap.userTransform.rotY}°`;
    $('slider-rot-z').value = snap.userTransform.rotZ;
    $('val-rot-z').textContent = `${snap.userTransform.rotZ}°`;
    $('slider-pos-x').value = snap.userTransform.posX;
    $('val-pos-x').textContent = snap.userTransform.posX.toFixed(2);
    $('slider-pos-y').value = snap.userTransform.posY;
    $('val-pos-y').textContent = snap.userTransform.posY.toFixed(2);
    const dist = engine.getCameraDistance();
    $('slider-zoom').value = dist;
    $('val-zoom').textContent = dist.toFixed(2);
    $('slider-open-manual').value = snap.openAmount * 100;
    $('val-open-manual').textContent = snap.openAmount > 0 ? `Obert (${Math.round(snap.openAmount * 100)}%)` : 'Tancat (0%)';
    updateExportSummary();
  } finally {
    state.history.restoring = false;
    updateHistoryButtons();
  }
}

function undo() {
  if (state.history.index <= 0) return;
  state.history.index--;
  applySnapshot(state.history.stack[state.history.index]);
}

function redo() {
  if (state.history.index >= state.history.stack.length - 1) return;
  state.history.index++;
  applySnapshot(state.history.stack[state.history.index]);
}

engine.controls.addEventListener('end', () => pushHistory());

// ---------------- RESIZE & RENDER LOOP ----------------
function handleResize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  engine.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  engine.resize(w, h);
}
window.addEventListener('resize', handleResize);
handleResize();

// ---------------- TIMELINE & RENDER LOOP ----------------
const timelineUI = new TimelineUI($('timeline-dock'), {
  getClips: () => state.clips,
  setClips: (clips, commit) => {
    state.clips = clips;
    setTimelineTime(Math.min(state.playback.timeSec, getTimelineDuration(state.clips)));
    updateExportSummary();
    if (commit) pushHistory();
  },
  getTime: () => state.playback.timeSec,
  setTime: (t) => {
    stopAnimation();
    setTimelineTime(t);
  },
  isPlaying: () => state.playback.active,
  onCommit: () => pushHistory(),
});

function updatePlayButtonUI() {
  const btn = $('btn-play-pause');
  if (!btn) return;
  btn.textContent = state.playback.active ? '⏸ Pausa' : '▶ Reproduir';
}

function updateTimelineUI(timeSec) {
  const dur = getTimelineDuration(state.clips);
  const fps = parseInt($('select-export-fps').value, 10) || 50;
  const totalFrames = Math.max(1, Math.round(dur * fps));
  const curFrame = Math.round(Math.min(dur, timeSec) * fps);
  $('timeline-label').textContent = `F ${curFrame}/${totalFrames} · ${timeSec.toFixed(2)}s / ${dur.toFixed(2)}s`;
  timelineUI.updatePlayhead();
}

function setTimelineTime(timeSec) {
  const dur = getTimelineDuration(state.clips);
  const t = Math.max(0, Math.min(dur, timeSec));
  state.playback.timeSec = t;
  const animState = evaluateTimeline(state.clips, t);
  Object.assign(engine.animOffset, animState);
  engine.applyState();
  updateTimelineUI(t);
}

function stepFrames(deltaFrames) {
  stopAnimation();
  const dur = getTimelineDuration(state.clips);
  const fps = parseInt($('select-export-fps').value, 10) || 50;
  const totalFrames = Math.max(1, Math.round(dur * fps));
  const curFrame = Math.round(state.playback.timeSec * fps);
  const nextFrame = Math.max(0, Math.min(totalFrames, curFrame + deltaFrames));
  setTimelineTime(nextFrame / fps);
}

function tick(now) {
  requestAnimationFrame(tick);

  if (state.playback.active) {
    const dur = getTimelineDuration(state.clips);
    const elapsed = (now - state.playback.startTime) / 1000;
    const t = Math.min(dur, elapsed);
    setTimelineTime(t);

    if (t >= dur) {
      state.playback.active = false;
      updatePlayButtonUI();
    }
  }

  engine.render();
}
requestAnimationFrame(tick);

// ---------------- STATUS OVERLAY ----------------
function showStatus(title, detail, progress = 0, cancellable = false) {
  $('status-overlay').classList.remove('hidden');
  $('status-title').textContent = title;
  $('status-detail').textContent = detail;
  $('status-progress').style.width = `${Math.round(progress * 100)}%`;
  $('btn-cancel-export').classList.toggle('hidden', !cancellable);
}

function hideStatus() {
  $('status-overlay').classList.add('hidden');
}

// ---------------- PDF LOADING & FORMAT DETECTION ----------------
function applyCoverTextures() {
  if (!state.coverData) return;
  const sliced = sliceCoverCanvas(
    state.coverData.canvas,
    state.coverData.widthMm,
    engine.format.spineWidthMm
  );
  engine.setCoverTextures(sliced);
}

function updateDetectedInfoUI(detected) {
  $('info-page-size').textContent = `${detected.pageWidthMm} × ${detected.pageHeightMm} mm`;
  $('info-cover-size').textContent = `${detected.coverWidthMm} × ${detected.coverHeightMm} mm`;
  $('info-spine-size').textContent = `${engine.format.spineWidthMm.toFixed(1)} mm`;
  $('info-page-count').textContent = detected.numPages ? `${detected.numPages} pàgs` : 'Sense interior';

  const typeLabel = engine.format.coverType === 'hardcover' ? 'Tapa Dura' : 'Tapa Normal';
  $('book-format-badge').textContent =
    `${detected.pageWidthMm}×${detected.pageHeightMm}mm · Llom ${engine.format.spineWidthMm.toFixed(1)}mm · ${typeLabel}`;
}

function syncFormatFromPdfs(autoSelectCoverType = true) {
  const detected = detectBookFormat(state.coverData, state.interiorData);

  const coverType = autoSelectCoverType
    ? detected.recommendedCoverType
    : engine.format.coverType;

  engine.updateFormat({
    pageWidthMm: detected.pageWidthMm,
    pageHeightMm: detected.pageHeightMm,
    spineWidthMm: detected.spineWidthMm,
    overhangMm: detected.overhangMm || 3,
    coverType,
  });

  // Update UI sliders and segmented buttons
  $('slider-spine').value = detected.spineWidthMm;
  $('val-spine').textContent = `${detected.spineWidthMm.toFixed(1)} mm`;
  setCoverTypeUI(coverType);

  applyCoverTextures();
  updateDetectedInfoUI(detected);
}

async function handleCoverBuffer(arrayBuffer, filename) {
  state.coverBuffer = arrayBuffer;
  showStatus('Processant PDF de portada...', filename, 0.25);
  try {
    state.coverData = await loadCoverPdf(arrayBuffer, state.extraCoverCropMm);
    $('cover-filename').textContent = filename;
    syncFormatFromPdfs(true);
  } catch (err) {
    console.error(err);
    alert(`Error carregant la portada PDF: ${err.message}`);
  } finally {
    hideStatus();
  }
}

async function handleInteriorBuffer(arrayBuffer, filename) {
  showStatus('Processant pàgines interiors...', filename, 0.05);
  try {
    state.interiorData = await loadInteriorPdf(arrayBuffer, (p, i, total) => {
      showStatus('Renderitzant pàgines interiors...', `Pàgina ${i} de ${total} (${filename})`, p);
    });
    $('interior-filename').textContent = `${filename} (${state.interiorData.numPages} pàgs)`;
    engine.setInteriorPages(state.interiorData.pages);
    syncFormatFromPdfs(true);
  } catch (err) {
    console.error(err);
    alert(`Error carregant les pàgines interiors: ${err.message}`);
  } finally {
    hideStatus();
  }
}

async function loadSampleBook() {
  showStatus('Carregant llibre d\'exemple...', 'Cançonarres de Nadal (Portada + 48 pàgines)', 0.05);
  try {
    const [coverRes, interiorRes] = await Promise.all([
      fetch('./samples/portada.pdf'),
      fetch('./samples/interior.pdf'),
    ]);
    if (!coverRes.ok || !interiorRes.ok) {
      throw new Error('No s\'han trobat els PDFs d\'exemple.');
    }
    const coverBuf = await coverRes.arrayBuffer();
    const interiorBuf = await interiorRes.arrayBuffer();

    state.coverBuffer = coverBuf;
    state.extraCoverCropMm = 0;
    $('slider-cover-bleed').value = 0;
    $('val-cover-bleed').textContent = '0.0 mm';

    showStatus('Analitzant portada (TrimBox)...', 'portada.pdf', 0.15);
    state.coverData = await loadCoverPdf(coverBuf, 0);
    $('cover-filename').textContent = 'Cançonarres de Nadal (portada.pdf)';

    state.interiorData = await loadInteriorPdf(interiorBuf, (p, i, total) => {
      showStatus('Carregant pàgines interiors...', `Pàgina ${i} de ${total}`, 0.2 + p * 0.8);
    });
    $('interior-filename').textContent = `Cançonarres de Nadal (${state.interiorData.numPages} pàgs)`;
    engine.setInteriorPages(state.interiorData.pages);

    syncFormatFromPdfs(true);
  } catch (err) {
    console.error(err);
    $('book-format-badge').textContent = 'Puja els teus PDFs al panell dret';
  } finally {
    hideStatus();
  }
}

// ---------------- UI WIRING ----------------
// Tabs
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(btn.dataset.tab).classList.add('active');
  });
});

// File upload inputs + drag-and-drop
function wireDropZone(dropId, inputId, handler) {
  const zone = $(dropId);
  const input = $(inputId);
  input.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) await handler(await file.arrayBuffer(), file.name);
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer.files?.[0];
    if (file && file.type === 'application/pdf') {
      await handler(await file.arrayBuffer(), file.name);
    }
  });
}

wireDropZone('drop-cover', 'input-cover-pdf', handleCoverBuffer);
wireDropZone('drop-interior', 'input-interior-pdf', handleInteriorBuffer);
$('btn-load-sample').addEventListener('click', loadSampleBook);

// Project JSON Export & Import
function exportProjectJson() {
  const project = {
    app: 'Llibre 3D Studio',
    version: 1,
    savedAt: new Date().toISOString(),
    files: {
      coverFilename: $('cover-filename').textContent,
      interiorFilename: $('interior-filename').textContent,
      extraCoverCropMm: state.extraCoverCropMm,
    },
    snapshot: captureSnapshot(),
    exportSettings: {
      resolution: $('select-export-res').value,
      fps: parseInt($('select-export-fps').value, 10) || 50,
      format: $('select-export-format').value,
    },
  };

  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `projecte-llibre-3d-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function importProjectJson(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !data.snapshot) {
      throw new Error('Aquest fitxer JSON no sembla un projecte vàlid de Llibre 3D Studio.');
    }

    if (data.exportSettings) {
      if (data.exportSettings.resolution) $('select-export-res').value = data.exportSettings.resolution;
      if (data.exportSettings.fps) $('select-export-fps').value = String(data.exportSettings.fps);
      if (data.exportSettings.format) $('select-export-format').value = data.exportSettings.format;
    }

    if (typeof data.files?.extraCoverCropMm === 'number' && data.files.extraCoverCropMm !== state.extraCoverCropMm) {
      state.extraCoverCropMm = data.files.extraCoverCropMm;
      $('slider-cover-bleed').value = state.extraCoverCropMm;
      $('val-cover-bleed').textContent = `${state.extraCoverCropMm.toFixed(1)} mm`;
      if (state.coverBuffer) {
        state.coverData = await loadCoverPdf(state.coverBuffer, state.extraCoverCropMm);
        applyCoverTextures();
      }
    }

    applySnapshot(data.snapshot);
    setTimelineTime(0);
    updateExportSummary();
    pushHistory();
  } catch (err) {
    console.error(err);
    alert(`Error important el projecte JSON: ${err.message}`);
  }
}

$('btn-export-json').addEventListener('click', exportProjectJson);
$('input-import-json').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (file) await importProjectJson(file);
  e.target.value = '';
});

// Cover Type (Hardcover / Softcover)
function setCoverTypeUI(type) {
  document.querySelectorAll('#cover-type-selector .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.value === type);
  });
  $('cover-type-hint').textContent =
    type === 'hardcover'
      ? 'Tapa rígida amb gruix i ceja (sobresurt respecte al bloc de pàgines).'
      : 'Tapa tova / rústica fina, completament a ras del bloc de pàgines.';
  $('row-board-thick').classList.toggle('hidden', type !== 'hardcover');
}

document.querySelectorAll('#cover-type-selector .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.value;
    setCoverTypeUI(type);
    engine.updateFormat({ coverType: type });
    const detected = detectBookFormat(state.coverData, state.interiorData);
    updateDetectedInfoUI(detected);
    pushHistory();
  });
});

// Hardcover board thickness
$('slider-board-thick').addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  $('val-board-thick').textContent = `${val.toFixed(1)} mm`;
  engine.updateFormat({ boardThicknessMm: val });
});
$('slider-board-thick').addEventListener('change', () => pushHistory());

// Spine width manual adjustment
$('slider-spine').addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  $('val-spine').textContent = `${val.toFixed(1)} mm`;
  engine.updateFormat({ spineWidthMm: val });
  applyCoverTextures();
  const detected = detectBookFormat(state.coverData, state.interiorData);
  updateDetectedInfoUI(detected);
});
$('slider-spine').addEventListener('change', () => pushHistory());

// Extra cover crop
let cropTimeout = null;
$('slider-cover-bleed').addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  $('val-cover-bleed').textContent = `${val.toFixed(1)} mm`;
  state.extraCoverCropMm = val;
  if (!state.coverBuffer) return;
  clearTimeout(cropTimeout);
  cropTimeout = setTimeout(async () => {
    state.coverData = await loadCoverPdf(state.coverBuffer, val);
    applyCoverTextures();
  }, 220);
});

// Finish
$('slider-finish').addEventListener('input', (e) => {
  const v = parseInt(e.target.value, 10);
  $('val-finish').textContent = `${v}%`;
  engine.updateFormat({ finish: v / 100 });
});

// Position & Rotation Controls
function bindRange(id, valId, fmt, cb) {
  const el = $(id);
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    $(valId).textContent = fmt(v);
    cb(v);
  });
  el.addEventListener('change', () => pushHistory());
}

bindRange('slider-rot-y', 'val-rot-y', (v) => `${v}°`, (v) => {
  engine.userTransform.rotY = v;
  engine.applyState();
});
bindRange('slider-rot-x', 'val-rot-x', (v) => `${v}°`, (v) => {
  engine.userTransform.rotX = v;
  engine.applyState();
});
bindRange('slider-rot-z', 'val-rot-z', (v) => `${v}°`, (v) => {
  engine.userTransform.rotZ = v;
  engine.applyState();
});
bindRange('slider-pos-x', 'val-pos-x', (v) => v.toFixed(2), (v) => {
  engine.userTransform.posX = v;
  engine.applyState();
});
bindRange('slider-pos-y', 'val-pos-y', (v) => v.toFixed(2), (v) => {
  engine.userTransform.posY = v;
  engine.applyState();
});
bindRange('slider-zoom', 'val-zoom', (v) => v.toFixed(2), (v) => {
  engine.setCameraDistance(v);
});
bindRange('slider-light', 'val-light', (v) => v.toFixed(2), (v) => {
  engine.setKeyLightIntensity(v);
});

// Camera / View Presets
const PRESETS = {
  front: { rotX: 0, rotY: 0, rotZ: 0, open: 0, zoom: 10.0 },
  hero: { rotX: 10, rotY: -22, rotZ: 0, open: 0, zoom: 10.0 },
  spine: { rotX: 4, rotY: 88, rotZ: 0, open: 0, zoom: 9.5 },
  back: { rotX: 0, rotY: 180, rotZ: 0, open: 0, zoom: 10.0 },
  open: { rotX: 10, rotY: 0, rotZ: 0, open: 1, zoom: 10.6 },
  top: { rotX: 55, rotY: 0, rotZ: 0, open: 1, zoom: 10.8 },
};

function applyPreset(name) {
  const p = PRESETS[name] || PRESETS.hero;
  stopAnimation();
  engine.userTransform.rotX = p.rotX;
  engine.userTransform.rotY = p.rotY;
  engine.userTransform.rotZ = p.rotZ;
  engine.userTransform.posX = 0;
  engine.userTransform.posY = 0;
  engine.animOffset.rotX = 0;
  engine.animOffset.rotY = 0;
  engine.animOffset.openAmount = p.open;
  if (p.open > 0 && engine.animOffset.flipProgress === 0) {
    engine.animOffset.flipProgress = 0.25;
  }

  // Reset OrbitControls camera directly in front
  engine.controls.target.set(0, 0, 0);
  engine.camera.position.set(0, 0.12, p.zoom);
  engine.controls.update();

  // Sync sliders
  $('slider-rot-x').value = p.rotX;
  $('val-rot-x').textContent = `${p.rotX}°`;
  $('slider-rot-y').value = p.rotY;
  $('val-rot-y').textContent = `${p.rotY}°`;
  $('slider-rot-z').value = p.rotZ;
  $('val-rot-z').textContent = `${p.rotZ}°`;
  $('slider-pos-x').value = 0;
  $('val-pos-x').textContent = '0.00';
  $('slider-pos-y').value = 0;
  $('val-pos-y').textContent = '0.00';
  $('slider-zoom').value = p.zoom;
  $('val-zoom').textContent = p.zoom.toFixed(2);
  $('slider-open-manual').value = p.open * 100;
  $('val-open-manual').textContent = p.open > 0 ? `Obert (${Math.round(p.open * 100)}%)` : 'Tancat (0%)';

  engine.applyState();
  pushHistory();
}

document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
});
$('btn-reset-view').addEventListener('click', () => applyPreset('hero'));
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);

// Background & Shadow
$('bg-color-select').addEventListener('change', (e) => {
  if (e.target.value !== 'custom') {
    $('bg-color-picker').value = e.target.value;
    engine.setBackgroundColor(e.target.value);
  }
});
$('bg-color-picker').addEventListener('input', (e) => {
  $('bg-color-select').value = 'custom';
  engine.setBackgroundColor(e.target.value);
});
$('chk-shadow').addEventListener('change', (e) => {
  engine.setShadowEnabled(e.target.checked);
});

// Top toggles: Alpha B/W Preview & 16:9 Guides
$('btn-alpha-preview').addEventListener('click', () => {
  const next = !engine.alphaMatte;
  engine.setAlphaMatte(next);
  $('btn-alpha-preview').classList.toggle('active', next);
});

$('btn-toggle-guides').addEventListener('click', () => {
  const guide = $('frame-guide');
  const active = guide.classList.toggle('hidden');
  $('btn-toggle-guides').classList.toggle('active', !active);
});

// ---------------- ANIMATION & TIMELINE CONTROLS ----------------
function updateExportSummary() {
  const dur = getTimelineDuration(state.clips);
  const fps = parseInt($('select-export-fps').value, 10) || 50;
  const res = $('select-export-res').value.replace('x', '×');
  const frames = Math.round(dur * fps);
  $('export-summary').textContent = `Timeline: ${dur.toFixed(2)}s · ${frames} fotogrames · ${res}`;
}

function loadTimelinePreset(presetKey, autoPlay = false) {
  stopAnimation();
  state.clips = TIMELINE_PRESETS[presetKey]();
  timelineUI.selectClip(null);
  timelineUI.render();
  setTimelineTime(0);
  updateExportSummary();
  pushHistory();
  if (autoPlay) startPlaybackFrom(0);
}

bindRange('slider-turn-duration', 'val-turn-duration', (v) => `${v.toFixed(1)} s`, (v) => {
  state.animConfig.turnDuration = v;
  const turnClip = state.clips.find((c) => c.type === 'turn');
  if (turnClip) {
    turnClip.duration = v;
    timelineUI.render();
  }
  updateExportSummary();
});
$('select-turn-angle').addEventListener('change', (e) => {
  const angle = parseFloat(e.target.value);
  state.animConfig.turnAngle = angle;
  const turnClip = state.clips.find((c) => c.type === 'turn');
  if (turnClip) {
    turnClip.angle = angle;
    timelineUI.render();
    setTimelineTime(state.playback.timeSec);
    pushHistory();
  }
});
$('select-easing').addEventListener('change', (e) => {
  state.animConfig.easing = e.target.value;
  const turnClip = state.clips.find((c) => c.type === 'turn');
  if (turnClip) {
    turnClip.easing = e.target.value;
    timelineUI.render();
    pushHistory();
  }
});

bindRange('slider-flip-duration', 'val-flip-duration', (v) => `${v.toFixed(1)} s`, (v) => {
  state.animConfig.flipDuration = v;
  const flipClip = state.clips.find((c) => c.type === 'flip');
  if (flipClip) {
    flipClip.duration = v;
    timelineUI.render();
  }
  updateExportSummary();
});
bindRange('slider-flip-pages', 'val-flip-pages', (v) => `${v} fulles`, (v) => {
  state.animConfig.flipSheetCount = v;
  engine.animOffset.flipSheetCount = v;
  const flipClip = state.clips.find((c) => c.type === 'flip');
  if (flipClip) {
    flipClip.sheets = v;
    timelineUI.render();
  }
  engine.applyState();
});

// Max book opening angle (60°..180°)
bindRange('slider-open-angle', 'val-open-angle', (v) => `${v}°`, (v) => {
  engine.format.maxOpenAngleDeg = v;
  engine.applyState();
});

// Manual Book Open & Page Flip Sliders
bindRange('slider-open-manual', 'val-open-manual', (v) => (v === 0 ? 'Tancat (0%)' : `Obert (${Math.round(v)}%)`), (v) => {
  stopAnimation();
  engine.animOffset.openAmount = v / 100;
  engine.applyState();
});
bindRange('slider-page-manual', 'val-page-manual', (v) => {
  const total = state.interiorData?.numPages || 48;
  const pageNum = Math.max(1, Math.min(total, Math.round((v / 100) * (total - 1)) + 1));
  return `Pàgina ${pageNum} / ${total}`;
}, (v) => {
  stopAnimation();
  if (engine.animOffset.openAmount < 0.2) {
    engine.animOffset.openAmount = 1;
    $('slider-open-manual').value = 100;
    $('val-open-manual').textContent = 'Obert (100%)';
  }
  engine.animOffset.flipProgress = v / 100;
  engine.applyState();
});

function startPlaybackFrom(timeSec) {
  state.playback.timeSec = timeSec;
  state.playback.startTime = performance.now() - timeSec * 1000;
  state.playback.active = true;
  updatePlayButtonUI();
}

function togglePlayPause() {
  if (state.playback.active) {
    state.playback.active = false;
    updatePlayButtonUI();
  } else {
    const dur = getTimelineDuration(state.clips);
    const startT = state.playback.timeSec >= dur - 0.01 ? 0 : state.playback.timeSec;
    startPlaybackFrom(startT);
  }
}

function stopAnimation() {
  state.playback.active = false;
  updatePlayButtonUI();
}

// Timeline toolbar buttons
$('btn-play-pause').addEventListener('click', togglePlayPause);
$('btn-stop-anim').addEventListener('click', () => {
  stopAnimation();
  setTimelineTime(0);
});
$('btn-prev-frame').addEventListener('click', () => stepFrames(-1));
$('btn-next-frame').addEventListener('click', () => stepFrames(1));

$('btn-preset-flip').addEventListener('click', () => loadTimelinePreset('flip', true));
$('btn-preset-turn').addEventListener('click', () => loadTimelinePreset('turn360', true));
$('btn-preset-combo').addEventListener('click', () => loadTimelinePreset('combo', true));

$('btn-preview-180').addEventListener('click', () => loadTimelinePreset('turn360', true));
$('btn-preview-flip').addEventListener('click', () => loadTimelinePreset('flip', true));

// Add clip buttons
document.querySelectorAll('.tl-add-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.add;
    const start = state.playback.timeSec;
    const clip = makeClip(type, start, undefined, {
      angle: state.animConfig.turnAngle,
      easing: state.animConfig.easing,
      sheets: state.animConfig.flipSheetCount,
    });
    state.clips.push(clip);
    timelineUI.selectClip(clip.id);
    timelineUI.render();
    setTimelineTime(state.playback.timeSec);
    updateExportSummary();
    pushHistory();
  });
});

// Global keyboard shortcuts:
// - Space: Play / Pause
// - Left / Right arrows: frame-by-frame stepping (Shift + Arrow = 10 frames)
// - Cmd/Ctrl + Z: Undo, Cmd/Ctrl + Shift + Z or Ctrl + Y: Redo
// - Delete / Backspace: remove selected clip
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' && document.activeElement.type !== 'range') return;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return;

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }

  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    togglePlayPause();
    return;
  }

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    stepFrames(e.shiftKey ? 10 : 1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    stepFrames(e.shiftKey ? -10 : -1);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && timelineUI.selectedId) {
    e.preventDefault();
    state.clips = state.clips.filter((c) => c.id !== timelineUI.selectedId);
    timelineUI.selectClip(null);
    timelineUI.render();
    setTimelineTime(Math.min(state.playback.timeSec, getTimelineDuration(state.clips)));
    updateExportSummary();
    pushHistory();
  }
});

// ---------------- 4K VIDEO & ALPHA MATTE EXPORT ----------------
function syncFrameGuideAspect() {
  const [w, h] = $('select-export-res').value.split('x').map(Number);
  const box = document.querySelector('.frame-guide-box');
  const label = document.querySelector('.frame-label');
  if (box) {
    box.style.aspectRatio = `${w} / ${h}`;
    // Keep guide box fitting cleanly inside viewport for landscape, square, or vertical formats
    const vpW = viewport.clientWidth || 900;
    const vpH = viewport.clientHeight || 600;
    const maxW = vpW * 0.88;
    const maxH = vpH * 0.82;
    const targetAspect = w / h;
    let boxW = maxW;
    let boxH = boxW / targetAspect;
    if (boxH > maxH) {
      boxH = maxH;
      boxW = boxH * targetAspect;
    }
    box.style.width = `${Math.round(boxW)}px`;
    box.style.height = `${Math.round(boxH)}px`;
  }
  if (label) {
    const ratioStr = w === h ? '1:1' : w > h ? '16:9' : '9:16';
    label.textContent = `${w >= 3000 || h >= 3000 ? '4K UHD' : 'Full HD'} · ${w} × ${h} (${ratioStr})`;
  }
}

/**
 * Computes the exact vertical FOV corresponding to the on-screen guide box
 * so the exported 4K video frames the book identically pixel-for-pixel!
 */
function computeGuideMatchedFov(targetW, targetH) {
  const vpW = viewport.clientWidth || 900;
  const vpH = viewport.clientHeight || 600;
  const box = document.querySelector('.frame-guide-box');
  let guideH = box ? box.getBoundingClientRect().height : 0;

  // If guide is currently hidden, compute the exact same dimensions it would have
  if (!guideH || guideH < 10) {
    const maxW = vpW * 0.88;
    const maxH = vpH * 0.82;
    const targetAspect = targetW / targetH;
    guideH = Math.min(maxH, maxW / targetAspect);
  }

  const heightRatio = Math.max(0.2, Math.min(1.0, guideH / vpH));
  const baseHalfTan = Math.tan((engine.camera.fov * Math.PI) / 360);
  return (2 * Math.atan(baseHalfTan * heightRatio) * 180) / Math.PI;
}

window.addEventListener('resize', syncFrameGuideAspect);

$('select-export-res').addEventListener('change', () => {
  syncFrameGuideAspect();
  updateExportSummary();
});
$('select-export-fps').addEventListener('change', () => {
  updateExportSummary();
  updateTimelineUI(state.playback.timeSec);
});
syncFrameGuideAspect();
updateExportSummary();

async function runExport(exportTarget) {
  stopAnimation();
  const [width, height] = $('select-export-res').value.split('x').map(Number);
  const fps = parseInt($('select-export-fps').value, 10);
  const format = $('select-export-format').value;
  const fovOverride = computeGuideMatchedFov(width, height);

  const controller = new AbortController();
  state.exportAbort = controller;

  showStatus('Preparant exportació 4K...', `${width}×${height} @ ${fps}fps`, 0, true);

  try {
    await exportBookVideo({
      engine,
      clips: cloneClips(state.clips),
      width,
      height,
      fps,
      format,
      fovOverride,
      exportTarget,
      signal: controller.signal,
      onStatus: ({ title, detail, progress }) => {
        showStatus(title, detail, progress, true);
      },
    });
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error(err);
      alert(`Error en exportar: ${err.message}`);
    }
  } finally {
    state.exportAbort = null;
    handleResize(); // Restore interactive viewport size
    hideStatus();
  }
}

$('btn-export-both').addEventListener('click', () => runExport('both'));
$('btn-export-color').addEventListener('click', () => runExport('color'));
$('btn-export-alpha').addEventListener('click', () => runExport('alpha'));
$('btn-cancel-export').addEventListener('click', () => {
  if (state.exportAbort) state.exportAbort.abort();
});

// ---------------- BOOT ----------------
timelineUI.render();
loadSampleBook().then(() => {
  setTimelineTime(0);
  pushHistory();
});
