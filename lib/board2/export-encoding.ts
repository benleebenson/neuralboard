export const EXPORT_QUALITY_OPTIONS = ["720p", "1080p", "1440p"] as const;
export type ExportQuality = (typeof EXPORT_QUALITY_OPTIONS)[number];
export type ExportAspect = "16:9" | "9:16";
export type ExportContainer = "mp4" | "webm";

export type ExportEncodingCandidate = {
  container: ExportContainer;
  label: string;
  quality: ExportQuality;
  width: number;
  height: number;
  fps: number;
  videoConfig: VideoEncoderConfig;
  audioConfig: AudioEncoderConfig;
};

const LANDSCAPE_DIMENSIONS: Record<ExportQuality, readonly [number, number]> = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "1440p": [2560, 1440],
};

const QUALITY_BITRATES: Record<ExportQuality, readonly [number, number]> = {
  "720p": [5_000_000, 8_000_000],
  "1080p": [8_000_000, 12_000_000],
  "1440p": [14_000_000, 22_000_000],
};

export function forceEven(value: number): number {
  const safe = Math.max(2, Math.round(value));
  return safe % 2 === 0 ? safe : safe - 1;
}

export function exportOutputDimensions(quality: ExportQuality, aspect: ExportAspect): { width: number; height: number } {
  const [landscapeWidth, landscapeHeight] = LANDSCAPE_DIMENSIONS[quality];
  return aspect === "16:9"
    ? { width: forceEven(landscapeWidth), height: forceEven(landscapeHeight) }
    : { width: forceEven(landscapeHeight), height: forceEven(landscapeWidth) };
}

function h264Level(quality: ExportQuality, fps: number): string {
  if (quality === "1440p") return fps > 30 ? "33" : "32"; // level 5.1 / 5.0
  if (quality === "1080p") return fps > 30 ? "2a" : "28"; // level 4.2 / 4.0
  return fps > 30 ? "20" : "1f"; // level 3.2 / 3.1
}

function vp9Level(quality: ExportQuality, fps: number): string {
  if (quality === "1440p") return fps > 30 ? "51" : "50";
  if (quality === "1080p") return fps > 30 ? "41" : "40";
  return fps > 30 ? "31" : "30";
}

function bitrateFor(quality: ExportQuality, fps: number): number {
  const [fps30, fps60] = QUALITY_BITRATES[quality];
  return fps > 30 ? fps60 : fps30;
}

function h264Candidate(
  quality: ExportQuality,
  aspect: ExportAspect,
  fps: number,
  profile: "high" | "main" | "baseline",
  hardwareAcceleration: HardwareAcceleration,
): ExportEncodingCandidate {
  const { width, height } = exportOutputDimensions(quality, aspect);
  const profileHex = profile === "high" ? "64" : profile === "main" ? "4d" : "42";
  const codec = `avc1.${profileHex}00${h264Level(quality, fps)}`;
  return {
    container: "mp4",
    label: `H.264 ${profile} ${quality} ${fps} fps (${hardwareAcceleration})`,
    quality,
    width,
    height,
    fps,
    videoConfig: {
      codec,
      width,
      height,
      bitrate: bitrateFor(quality, fps),
      framerate: fps,
      hardwareAcceleration,
      latencyMode: "quality",
      avc: { format: "avc" },
    },
    audioConfig: { codec: "mp4a.40.2", sampleRate: 48_000, numberOfChannels: 2, bitrate: 192_000 },
  };
}

function vp9Candidate(
  quality: ExportQuality,
  aspect: ExportAspect,
  fps: number,
  hardwareAcceleration: HardwareAcceleration,
): ExportEncodingCandidate {
  const { width, height } = exportOutputDimensions(quality, aspect);
  return {
    container: "webm",
    label: `VP9/WebM ${quality} ${fps} fps (${hardwareAcceleration})`,
    quality,
    width,
    height,
    fps,
    videoConfig: {
      codec: `vp09.00.${vp9Level(quality, fps)}.08`,
      width,
      height,
      bitrate: bitrateFor(quality, fps),
      framerate: fps,
      hardwareAcceleration,
      latencyMode: "quality",
    },
    audioConfig: { codec: "opus", sampleRate: 48_000, numberOfChannels: 2, bitrate: 192_000 },
  };
}

export function buildExportEncodingCandidates(options: {
  quality: ExportQuality;
  aspect: ExportAspect;
  fps: number;
}): ExportEncodingCandidate[] {
  const qualityIndex = EXPORT_QUALITY_OPTIONS.indexOf(options.quality);
  const qualities = [...EXPORT_QUALITY_OPTIONS.slice(0, qualityIndex + 1)].reverse();
  const candidates: ExportEncodingCandidate[] = [];

  for (const quality of qualities) {
    const frameRates = options.fps > 30 ? [options.fps, 30] : [options.fps];
    for (const fps of frameRates) {
      candidates.push(h264Candidate(quality, options.aspect, fps, "high", "prefer-hardware"));
      candidates.push(h264Candidate(quality, options.aspect, fps, "high", "prefer-software"));
      candidates.push(h264Candidate(quality, options.aspect, fps, "main", "no-preference"));
      candidates.push(h264Candidate(quality, options.aspect, fps, "baseline", "no-preference"));
    }
  }

  // VP9 is deliberately last: MP4/H.264 remains the preferred interoperable output, but an
  // otherwise-capable browser should never dead-end solely because it lacks an H.264 encoder.
  for (const quality of qualities) {
    const frameRates = options.fps > 30 ? [options.fps, 30] : [options.fps];
    for (const fps of frameRates) {
      candidates.push(vp9Candidate(quality, options.aspect, fps, "prefer-hardware"));
      candidates.push(vp9Candidate(quality, options.aspect, fps, "prefer-software"));
      candidates.push(vp9Candidate(quality, options.aspect, fps, "no-preference"));
    }
  }
  return candidates;
}

export function exportFallbackMessage(preferred: ExportEncodingCandidate, selected: ExportEncodingCandidate): string | null {
  if (preferred.label === selected.label) return null;
  return `Encoder fallback: ${selected.label} (${selected.width}×${selected.height}) instead of ${preferred.label}.`;
}
