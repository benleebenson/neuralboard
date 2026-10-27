// Brightness envelope for a flash cut, shared by preview and both export paths.
//
// A pure function of time since the block start, so preview and export draw identical frames.
// Entry: a white bloom eases up on the hit while the image fades in beneath it, then the white
// and the blown-out highlights ease off. Exit: the image eases away under a soft white glow, so
// the board returns without a hard cut. Short blocks shrink both ramps to fit.
export const FLASH_CUT_RAMP_SECONDS = 0.3;

export type FlashCutExposure = {
  opacity: number; // 0–1: how much of the flash image covers the frame below
  boost: number;   // 0–1: additive re-draw of the image on top of itself ("lighter")
  white: number;   // 0–1: white wash over the frame
};

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// `elapsed` is seconds since the flash block started; `duration` is the block length.
export function flashCutExposure(elapsed: number, duration: number): FlashCutExposure {
  const ramp = Math.min(FLASH_CUT_RAMP_SECONDS, Math.max(0, duration) * 0.4);
  if (ramp <= 0 || elapsed < 0 || elapsed >= duration) return { opacity: 0, boost: 0, white: 0 };
  const into = elapsed / ramp;                          // 0→1 across the entry ramp
  const out = (elapsed - (duration - ramp)) / ramp;     // 0→1 across the exit ramp
  let opacity = smoothstep(0, 0.35, into);
  let boost = 1 - smoothstep(0.2, 1, into);
  let white = into < 0.25 ? smoothstep(0, 0.25, into) : 1 - smoothstep(0.25, 1, into);
  if (out > 0) {
    opacity *= 1 - smoothstep(0, 1, out);
    boost = Math.max(boost, 0.6 * smoothstep(0, 0.5, out));
    white = Math.max(white, 0.45 * Math.sin(Math.PI * Math.min(1, out)));
  }
  return { opacity, boost, white };
}
