export const EASINGS = {
  sine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  cubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  quart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  quint: (t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2),
};

export function getEasing(name) {
  return EASINGS[name] || EASINGS.cubic;
}

/**
 * Computes total duration (seconds) for a given animation mode.
 */
export function getAnimationDuration(mode, config) {
  if (mode === 'turn180') return config.turnDuration;
  if (mode === 'flip') return config.flipDuration;
  if (mode === 'combo') return config.flipDuration + config.turnDuration;
  return config.turnDuration;
}

/**
 * Deterministic animation evaluator for both real-time playback and frame-by-frame 4K export.
 * @param {'turn180'|'flip'|'combo'} mode
 * @param {number} progress Normalized time [0..1]
 * @param {object} config { turnDuration, turnAngle, easing, flipDuration, flipSheetCount }
 */
export function evaluateAnimation(mode, progress, config) {
  const p = Math.max(0, Math.min(1, progress));
  const ease = getEasing(config.easing);
  const smooth = EASINGS.cubic;

  const out = {
    rotY: 0,
    rotX: 0,
    posX: 0,
    openAmount: 0,
    flipProgress: 0,
    flipSheetCount: config.flipSheetCount || 16,
  };

  if (mode === 'turn180') {
    const e = ease(p);
    out.rotY = config.turnAngle * e;
    return out;
  }

  if (mode === 'flip') {
    // Opening and closing overlap smoothly with the page flip-through:
    // As soon as the front cover begins opening, pages immediately start turning;
    // as the last pages settle, the cover smoothly closes over them.
    const openEnd = 0.22;
    const closeStart = 0.78;
    if (p < openEnd) {
      out.openAmount = smooth(p / openEnd);
    } else if (p <= closeStart) {
      out.openAmount = 1;
    } else {
      out.openAmount = 1 - smooth((p - closeStart) / (1 - closeStart));
    }

    // Pages flip continuously from p=0.08 to p=0.88 overlapping open & close smoothly
    // while settling just before the cover shuts completely
    const flipStart = 0.08;
    const flipEnd = 0.88;
    if (p <= flipStart) {
      out.flipProgress = 0;
    } else if (p >= flipEnd) {
      out.flipProgress = 1;
    } else {
      const k = (p - flipStart) / (flipEnd - flipStart);
      out.flipProgress = EASINGS.sine(k);
    }
    return out;
  }

  if (mode === 'combo') {
    const total = config.flipDuration + config.turnDuration;
    const split = config.flipDuration / total;
    if (p < split) {
      return evaluateAnimation('flip', p / split, config);
    } else {
      return evaluateAnimation('turn180', (p - split) / (1 - split), config);
    }
  }

  return out;
}
