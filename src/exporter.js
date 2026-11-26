import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import { evaluateTimeline, getTimelineDuration } from './timeline.js';

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Picks the best supported WebCodecs configuration for the requested resolution & format.
 */
async function pickEncoderConfig(format, width, height, fps) {
  if (typeof VideoEncoder === 'undefined') {
    return null;
  }

  const is4K = width >= 3000 || height >= 3000;
  const bitrate = is4K ? 45_000_000 : 18_000_000;

  if (format === 'mp4') {
    // High Profile Level 5.2 / 5.1 / Main 5.1 for 4K UHD
    const h264Candidates = ['avc1.640034', 'avc1.640033', 'avc1.4d0033', 'avc1.420033', 'avc1.640028'];
    for (const codec of h264Candidates) {
      const cfg = {
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
        avc: { format: 'avc' },
        hardwareAcceleration: 'prefer-hardware',
      };
      try {
        const res = await VideoEncoder.isConfigSupported(cfg);
        if (res.supported) return { format: 'mp4', muxCodec: 'avc', config: res.config };
      } catch (_) {}
    }
  }

  // Fallback or explicit WebM (VP9)
  const vp9Candidates = ['vp09.00.51.08', 'vp09.00.50.08', 'vp09.00.41.08', 'vp8'];
  for (const codec of vp9Candidates) {
    const cfg = {
      codec,
      width,
      height,
      bitrate: is4K ? 40_000_000 : 15_000_000,
      framerate: fps,
    };
    try {
      const res = await VideoEncoder.isConfigSupported(cfg);
      if (res.supported) {
        return {
          format: 'webm',
          muxCodec: codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8',
          config: res.config,
        };
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Renders a single deterministic pass (either full Color or Alpha Matte B/W)
 * frame by frame at full target resolution (e.g., 3840x2160).
 */
async function renderVideoPass({
  engine,
  clips,
  width,
  height,
  fps,
  format,
  fovOverride,
  isAlphaMatte,
  onProgress,
  signal,
}) {
  const duration = getTimelineDuration(clips);
  const totalFrames = Math.max(2, Math.round(duration * fps));

  const picked = await pickEncoderConfig(format, width, height, fps);
  if (!picked) {
    throw new Error(
      'El navegador no suporta WebCodecs VideoEncoder per a aquesta resolució. Prova Chrome o Edge actualitzats.'
    );
  }

  const prevAlpha = engine.alphaMatte;
  const prevOffset = { ...engine.animOffset };
  const prevFov = engine.camera.fov;

  let muxer;
  let target;
  if (picked.format === 'mp4') {
    target = new Mp4Target();
    muxer = new Mp4Muxer({
      target,
      video: {
        codec: picked.muxCodec,
        width,
        height,
      },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
  } else {
    target = new WebmTarget();
    muxer = new WebmMuxer({
      target,
      video: {
        codec: picked.muxCodec,
        width,
        height,
        frameRate: fps,
      },
      firstTimestampBehavior: 'offset',
    });
  }

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      encodeError = err;
    },
  });
  encoder.configure(picked.config);

  engine.setAlphaMatte(isAlphaMatte);

  const frameDurationUs = Math.round(1_000_000 / fps);

  try {
    for (let f = 0; f < totalFrames; f++) {
      if (signal?.aborted) {
        throw new Error('Exportació cancel·lada per l\'usuari.');
      }
      if (encodeError) throw encodeError;

      const progress = totalFrames > 1 ? f / (totalFrames - 1) : 1;
      const state = evaluateTimeline(clips, progress * duration);
      Object.assign(engine.animOffset, state);
      engine.applyState();

      // Render exact 4K frame onto WebGL canvas matching on-screen guide framing
      engine.renderFrameAtSize(width, height, fovOverride);

      // Capture frame into VideoFrame
      const timestampUs = f * frameDurationUs;
      const frame = new VideoFrame(engine.canvas, {
        timestamp: timestampUs,
        duration: frameDurationUs,
      });

      const keyFrame = f % (fps * 2) === 0;
      encoder.encode(frame, { keyFrame });
      frame.close();

      // Backpressure so GPU/encoder queue stays healthy at 4K
      while (encoder.encodeQueueSize > 6) {
        await new Promise((r) => setTimeout(r, 8));
      }

      onProgress((f + 1) / totalFrames, f + 1, totalFrames);
      // Yield briefly to keep UI responsive
      if (f % 3 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    await encoder.flush();
    encoder.close();
    muxer.finalize();

    const mime = picked.format === 'mp4' ? 'video/mp4' : 'video/webm';
    return {
      blob: new Blob([target.buffer], { type: mime }),
      ext: picked.format,
    };
  } finally {
    engine.camera.fov = prevFov;
    engine.setAlphaMatte(prevAlpha);
    Object.assign(engine.animOffset, prevOffset);
    engine.applyState();
  }
}

/**
 * High-level export orchestrator: exports Color, Alpha Matte B/W, or both in sequence.
 */
export async function exportBookVideo({
  engine,
  clips,
  width,
  height,
  fps,
  format,
  fovOverride,
  exportTarget, // 'both' | 'color' | 'alpha'
  onStatus,
  signal,
}) {
  const baseName = `llibre-3d-${width}x${height}-${fps}fps`;
  const passes =
    exportTarget === 'both'
      ? [
          { isAlpha: false, label: 'Vídeo Color 4K', suffix: 'color' },
          { isAlpha: true, label: 'Mapa Alpha B/N 4K', suffix: 'alpha-matte' },
        ]
      : exportTarget === 'alpha'
      ? [{ isAlpha: true, label: 'Mapa Alpha B/N 4K', suffix: 'alpha-matte' }]
      : [{ isAlpha: false, label: 'Vídeo Color 4K', suffix: 'color' }];

  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i];
    const result = await renderVideoPass({
      engine,
      clips,
      width,
      height,
      fps,
      format,
      fovOverride,
      isAlphaMatte: pass.isAlpha,
      signal,
      onProgress: (p, frame, total) => {
        const overall = (i + p) / passes.length;
        onStatus({
          title: `Exportant ${pass.label} (${i + 1}/${passes.length})`,
          detail: `Fotograma ${frame} de ${total} · ${width}×${height} @ ${fps}fps`,
          progress: overall,
        });
      },
    });

    triggerDownload(result.blob, `${baseName}-${pass.suffix}.${result.ext}`);
    // Small pause between downloads so browser doesn't block second file
    if (i < passes.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
