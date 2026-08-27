import { TRANSCRIPTION_SAMPLE_RATE } from "./transcription";

export function audioBufferSegmentToMonoWav(buffer: AudioBuffer, startSec: number, durationSec: number): Blob {
  const startFrame = Math.max(0, Math.floor(startSec * buffer.sampleRate));
  const endFrame = Math.min(buffer.length, Math.ceil((startSec + durationSec) * buffer.sampleRate));
  const outputFrames = Math.max(1, Math.ceil((endFrame - startFrame) * TRANSCRIPTION_SAMPLE_RATE / buffer.sampleRate));
  const pcm = new Int16Array(outputFrames);
  for (let outputIndex = 0; outputIndex < outputFrames; outputIndex++) {
    const sourceFrame = Math.min(endFrame - 1, startFrame + Math.floor(outputIndex * buffer.sampleRate / TRANSCRIPTION_SAMPLE_RATE));
    let sample = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) sample += buffer.getChannelData(channel)[sourceFrame] ?? 0;
    sample = Math.max(-1, Math.min(1, sample / Math.max(1, buffer.numberOfChannels)));
    pcm[outputIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(bytes);
  const write = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, 36 + pcm.byteLength, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, TRANSCRIPTION_SAMPLE_RATE, true); view.setUint32(28, TRANSCRIPTION_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, pcm.byteLength, true);
  new Int16Array(bytes, 44).set(pcm);
  return new Blob([bytes], { type: "audio/wav" });
}

export function waveformPeaks(buffer: AudioBuffer, samples = 180): number[] {
  const data = buffer.getChannelData(0);
  const block = Math.max(1, Math.floor(data.length / samples));
  return Array.from({ length: samples }, (_, index) => {
    let peak = 0;
    const start = index * block;
    for (let offset = 0; offset < block; offset++) peak = Math.max(peak, Math.abs(data[start + offset] ?? 0));
    return peak;
  });
}
