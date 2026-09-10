import { ArrayBufferTarget, Muxer } from "webm-muxer";

export const CLIP_AUDIO_BITRATE = 48_000;

export async function audioBufferSegmentToOpusWebm(buffer: AudioBuffer, start: number, duration: number): Promise<Blob> {
  if (!("AudioEncoder" in window) || !("AudioData" in window)) throw new Error("This browser cannot compress project clips (WebCodecs is unavailable)");
  const sampleRate = 48_000;
  const frames = Math.max(1, Math.ceil(Math.max(0.01, duration) * sampleRate));
  const offline = new OfflineAudioContext(1, frames, sampleRate);
  const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start(0, Math.max(0, start), duration);
  const rendered = await offline.startRendering();
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, audio: { codec: "A_OPUS", numberOfChannels: 1, sampleRate }, firstTimestampBehavior: "strict" });
  let codecError: Error | null = null;
  const encoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (error) => { codecError = error; } });
  const config: AudioEncoderConfig = { codec: "opus", sampleRate, numberOfChannels: 1, bitrate: CLIP_AUDIO_BITRATE };
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error("This browser cannot encode Opus project clips");
  encoder.configure(config);
  const samples = rendered.getChannelData(0); const chunkFrames = 960;
  for (let offset = 0; offset < samples.length; offset += chunkFrames) {
    const count = Math.min(chunkFrames, samples.length - offset);
    const data = new Float32Array(count); data.set(samples.subarray(offset, offset + count));
    const audio = new AudioData({ format: "f32-planar", sampleRate, numberOfFrames: count, numberOfChannels: 1, timestamp: Math.round(offset / sampleRate * 1e6), data });
    encoder.encode(audio); audio.close();
    if (encoder.encodeQueueSize > 8) await encoder.flush();
  }
  await encoder.flush(); encoder.close();
  if (codecError) throw codecError;
  muxer.finalize();
  return new Blob([target.buffer], { type: "audio/webm" });
}
