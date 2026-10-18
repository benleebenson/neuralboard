// Brightness envelope for a flash cut, shared by preview and both export paths.
//
// The burst is stepped in 1/30 s units rather than eased, so it reads as distinct blown-out
// frames (a white frame, then a fast exposure drop) instead of a crossfade. At 30 fps each
// step is exactly one frame; at 60 fps each step spans two identical frames.
export const FLASH_CUT_STEP_SECONDS = 1 / 30;

export type FlashCutExposure = {
  showImage: boolean; // false = the frame is pure white
  boost: number;      // 0–1: additive re-draw of the image on top of itself ("lighter")
  white: number;      // 0–1: white wash over the frame
};

const CLEAN: FlashCutExposure = { showImage: true, boost: 0, white: 0 };

// Entry: white frame on the hit, then the image blown out, then settled.
const IN_STEPS: readonly FlashCutExposure[] = [
  { showImage: false, boost: 0, white: 1 },
  { showImage: true, boost: 1, white: 0.45 },
  { showImage: true, boost: 0.5, white: 0.12 },
];
// Exit: one overexposed frame right before the cut back.
const OUT_STEP: FlashCutExposure = { showImage: true, boost: 1, white: 0.6 };

// `elapsed` is seconds since the flash block started; `duration` is the block length.
export function flashCutExposure(elapsed: number, duration: number): FlashCutExposure {
  const steps = Math.max(1, Math.round(duration / FLASH_CUT_STEP_SECONDS));
  // The epsilon keeps frame times like 31/30 from landing a hair before a step boundary.
  const index = Math.floor(elapsed / FLASH_CUT_STEP_SECONDS + 1e-6);
  if (index < IN_STEPS.length) return IN_STEPS[Math.max(0, index)];
  // Very short blocks keep their entry burst and skip the exit frame.
  if (steps > IN_STEPS.length + 1 && index >= steps - 1) return OUT_STEP;
  return CLEAN;
}
