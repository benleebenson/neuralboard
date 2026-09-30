import { ArrayBufferTarget, Muxer } from "mp4-muxer";

// Animated GIFs are re-encoded as silent looping MP4s so they take the existing video path
// (board playback, preview canvas, export). Short GIFs repeat until the clip is a usable length.
const MIN_VIDEO_SECONDS = 4;
const MAX_VIDEO_SECONDS = 60;
const MAX_DIMENSION = 1280;
// Browsers play GIF frame delays under 20ms as 100ms; match that so timing looks the same.
const MIN_FRAME_US = 20_000;
const DEFAULT_FRAME_US = 100_000;

const H264_CODECS = ["avc1.640028", "avc1.4d0028", "avc1.42001f"];

export function isGifFile(file: Blob, name = ""): boolean {
  return file.type === "image/gif" || (!file.type && /\.gif$/i.test(name));
}

/**
 * Returns an MP4 of the GIF's animation, or null when the GIF is a single frame or the browser
 * can't decode/encode it (callers then keep it as a still image). Transparent pixels are
 * flattened onto `background`, since MP4 has no alpha.
 */
export async function convertAnimatedGifToMp4(file: Blob, background: string): Promise<Blob | null> {
  if (typeof ImageDecoder === "undefined" || typeof VideoEncoder === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  if (!(await ImageDecoder.isTypeSupported("image/gif"))) return null;

  const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: "image/gif" });
  let encoder: VideoEncoder | null = null;
  try {
    // `selectedTrack` stays null until `tracks.ready`; `completed` alone doesn't imply it.
    await Promise.all([decoder.tracks.ready, decoder.completed]);
    const track = decoder.tracks.selectedTrack;
    if (!track || track.frameCount < 2) return null;
    const frameCount = track.frameCount;

    const first = (await decoder.decode({ frameIndex: 0 })).image;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(first.displayWidth, first.displayHeight));
    // H.264 needs even dimensions.
    const width = Math.max(2, Math.round((first.displayWidth * scale) / 2) * 2);
    const height = Math.max(2, Math.round((first.displayHeight * scale) / 2) * 2);
    first.close();

    const frameDurations: number[] = [];
    let loopUs = 0;
    for (let i = 0; i < frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
      const duration = image.duration && image.duration >= MIN_FRAME_US ? image.duration : DEFAULT_FRAME_US;
      image.close();
      frameDurations.push(duration);
      loopUs += duration;
    }
    const loops = Math.max(1, Math.ceil((MIN_VIDEO_SECONDS * 1_000_000) / loopUs));
    const maxUs = MAX_VIDEO_SECONDS * 1_000_000;
    const frameRate = Math.max(1, Math.round(1_000_000 / (loopUs / frameCount)));

    let config: VideoEncoderConfig | null = null;
    for (const codec of H264_CODECS) {
      const candidate: VideoEncoderConfig = { codec, width, height, bitrate: 4_000_000, framerate: frameRate, avc: { format: "avc" } };
      if ((await VideoEncoder.isConfigSupported(candidate)).supported) { config = candidate; break; }
    }
    if (!config) return null;

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, video: { codec: "avc", width, height }, fastStart: "in-memory", firstTimestampBehavior: "offset" });
    let encodeError: Error | null = null;
    encoder = new VideoEncoder({
      output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
      error: (error) => { encodeError = error; },
    });
    encoder.configure(config);

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    let timestamp = 0;
    let frameNumber = 0;
    outer: for (let loop = 0; loop < loops; loop++) {
      for (let i = 0; i < frameCount; i++) {
        if (timestamp >= maxUs) break outer;
        if (encodeError) throw encodeError;
        const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        image.close();
        const frame = new VideoFrame(canvas, { timestamp, duration: frameDurations[i] });
        encoder.encode(frame, { keyFrame: frameNumber % 60 === 0 });
        frame.close();
        timestamp += frameDurations[i];
        frameNumber++;
        // Keep the encoder queue bounded for long GIFs.
        while (encoder.encodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    return new Blob([target.buffer], { type: "video/mp4" });
  } catch (error) {
    console.warn("[gif-to-video] Could not convert GIF; keeping it as a still image", error);
    return null;
  } finally {
    if (encoder && encoder.state !== "closed") encoder.close();
    decoder.close();
  }
}
