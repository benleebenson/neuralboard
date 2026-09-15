export const DEFAULT_EXPORT_FPS = 30;
export const SUPPORTED_EXPORT_FPS = [30, 60] as const;
export const BOARD_SNAPSHOT_LONG_EDGE = 4096;
export const BOARD_SNAPSHOT_MAX_PIXELS = 32_000_000;

export type OfflineAudioSource = {
  startTime: number;
  duration: number;
  sourceOffsetSec: number;
  volume: number;
  buffer: AudioBuffer;
};

export function exportFrameCount(durationSeconds: number, fps: number): number {
  return Math.max(1, Math.ceil(Math.max(0, durationSeconds) * fps));
}

export function exportFrameTime(frameIndex: number, fps: number): number {
  return Math.max(0, frameIndex) / fps;
}

export function exportFrameTimestampUs(frameIndex: number, fps: number): number {
  return Math.round(exportFrameTime(frameIndex, fps) * 1_000_000);
}

export function snapshotDimensions(
  boardWidth: number,
  boardHeight: number,
  longEdge = BOARD_SNAPSHOT_LONG_EDGE,
  maxPixels = BOARD_SNAPSHOT_MAX_PIXELS,
): { width: number; height: number } {
  const safeWidth = Math.max(1, boardWidth);
  const safeHeight = Math.max(1, boardHeight);
  const scale = longEdge / Math.max(safeWidth, safeHeight);
  let width = Math.max(1, Math.round(safeWidth * scale));
  let height = Math.max(1, Math.round(safeHeight * scale));
  if (width * height > maxPixels) {
    const pixelScale = Math.sqrt(maxPixels / (width * height));
    width = Math.max(1, Math.floor(width * pixelScale));
    height = Math.max(1, Math.floor(height * pixelScale));
  }
  return { width, height };
}

export function deterministicVideoSourceTime(options: {
  timelineTime: number;
  clipStart: number;
  clipDuration: number;
  sourceDuration: number;
  sourceOffsetSec?: number;
  active: boolean;
  ambient: boolean;
}): number {
  const sourceDuration = Math.max(0, options.sourceDuration);
  const lastDrawableTime = Math.max(0, sourceDuration - 0.001);
  let requested: number;
  if (options.active) {
    requested = (options.sourceOffsetSec ?? 0) + Math.max(0, options.timelineTime - options.clipStart);
  } else if (options.ambient && sourceDuration > 0) {
    // Ambient motion is anchored to timeline zero, so seeking frame N in isolation returns the
    // same image as rendering every preceding frame. It never inherits a live element clock.
    requested = options.timelineTime % sourceDuration;
  } else {
    // Dormant video media is represented by a decoded first frame, not a low-res thumbnail.
    requested = Math.min(0.1, lastDrawableTime);
  }
  return Math.min(Math.max(0, requested), lastDrawableTime);
}

export function formatExportEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "Estimating…";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  if (minutes > 0) return `${minutes}m ${secs}s remaining`;
  return `${secs}s remaining`;
}

async function renderOfflineAudioMix(
  sources: readonly OfflineAudioSource[],
  totalDuration: number,
  sampleRate: number,
  numberOfChannels: number,
): Promise<AudioBuffer> {
  const totalFrames = Math.max(1, Math.ceil(Math.max(0, totalDuration) * sampleRate));
  const context = new OfflineAudioContext(numberOfChannels, totalFrames, sampleRate);
  for (const item of sources) {
    if (item.volume <= 0 || item.duration <= 0 || item.startTime >= totalDuration) continue;
    const offset = Math.min(Math.max(0, item.sourceOffsetSec), Math.max(0, item.buffer.duration - 0.001));
    const duration = Math.min(item.duration, totalDuration - item.startTime, item.buffer.duration - offset);
    if (duration <= 0) continue;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = item.buffer;
    gain.gain.value = item.volume;
    source.connect(gain).connect(context.destination);
    source.start(Math.max(0, item.startTime), offset, duration);
  }
  const rendered = await context.startRendering();

  // Web Audio mixes in floating point and may exceed full scale when narration and clip audio
  // overlap. Scale the complete mix once instead of hard-clipping individual peaks, which creates
  // the audible crackle that is especially obvious on speech.
  let peak = 0;
  for (let channel = 0; channel < rendered.numberOfChannels; channel++) {
    const data = rendered.getChannelData(channel);
    for (let index = 0; index < data.length; index++) peak = Math.max(peak, Math.abs(data[index]));
  }
  if (peak > 0.999) {
    const scale = 0.999 / peak;
    for (let channel = 0; channel < rendered.numberOfChannels; channel++) {
      const data = rendered.getChannelData(channel);
      for (let index = 0; index < data.length; index++) data[index] *= scale;
    }
  }
  return rendered;
}

export async function encodeOfflineAudioTrack(options: {
  encoder: AudioEncoder;
  sources: readonly OfflineAudioSource[];
  totalDuration: number;
  sampleRate?: number;
  numberOfChannels?: number;
  chunkFrames?: number;
  isCancelled?: () => boolean;
  onProgress?: (progress: number) => void;
}): Promise<void> {
  const sampleRate = options.sampleRate ?? 48_000;
  const numberOfChannels = options.numberOfChannels ?? 2;
  const chunkFrames = options.chunkFrames ?? 1024;
  const totalFrames = Math.max(1, Math.ceil(Math.max(0, options.totalDuration) * sampleRate));
  const rendered = await renderOfflineAudioMix(options.sources, options.totalDuration, sampleRate, numberOfChannels);

  for (let outputStart = 0; outputStart < totalFrames; outputStart += chunkFrames) {
    if (options.isCancelled?.()) throw new DOMException("Export cancelled", "AbortError");
    const frameCount = Math.min(chunkFrames, totalFrames - outputStart);
    const planar = new Float32Array(frameCount * numberOfChannels);
    for (let channel = 0; channel < numberOfChannels; channel++) {
      planar.set(rendered.getChannelData(channel).subarray(outputStart, outputStart + frameCount), channel * frameCount);
    }

    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: frameCount,
      numberOfChannels,
      timestamp: Math.round(outputStart / sampleRate * 1_000_000),
      data: planar,
    });
    options.encoder.encode(audioData);
    audioData.close();
    if (options.encoder.encodeQueueSize > 8) await options.encoder.flush();
    const chunkIndex = Math.floor(outputStart / chunkFrames);
    if (chunkIndex % 64 === 0 || outputStart + frameCount === totalFrames) {
      options.onProgress?.((outputStart + frameCount) / totalFrames);
    }
    if (chunkIndex % 128 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

export async function seekAndDecodeVideoFrame(video: HTMLVideoElement, requestedTime: number): Promise<ImageBitmap> {
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Video metadata timed out")), 20_000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("error", onError);
      };
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("Video metadata could not be decoded")); };
      video.addEventListener("loadedmetadata", onReady, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.load();
    });
  }

  const duration = Number.isFinite(video.duration) ? video.duration : requestedTime + 0.001;
  const target = Math.min(Math.max(0, requestedTime), Math.max(0, duration - 0.001));
  video.pause();
  if (Math.abs(video.currentTime - target) > 0.0005 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => { cleanup(); reject(new Error(`Video seek timed out at ${target.toFixed(3)}s`)); }, 20_000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
      };
      const onSeeked = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error(`Video frame could not be decoded at ${target.toFixed(3)}s`)); };
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.currentTime = target;
    });
  }

  // createImageBitmap snapshots the decoded frame into an immutable source. The caller owns it
  // and closes it after the canvas draw, bounding decoded-frame memory to the current output frame.
  return createImageBitmap(video);
}
