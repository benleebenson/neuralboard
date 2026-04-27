"use client";

import { useState, useRef } from "react";

export default function BuilderPage() {
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  async function startRecording() {
    setError("");
    setTranscript("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        const audioBlob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        await sendToTranscribe(audioBlob);
      };

      recorder.start();
      setRecording(true);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Microphone access denied";
      setError(message);
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
      setRecording(false);
      setProcessing(true);
    }
  }

  async function sendToTranscribe(blob: Blob) {
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Transcription failed");
      setTranscript(data.transcript);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
    } finally {
      setProcessing(false);
    }
  }

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-8">
      <h1 className="text-3xl font-bold mb-2 text-[#c8f135]">Neural Board — Builder</h1>
      <p className="text-sm text-gray-400 mb-12">
        Step 1: record your narration and see it transcribed.
      </p>

      <button
        onClick={recording ? stopRecording : startRecording}
        disabled={processing}
        className={`px-8 py-4 rounded-full text-lg font-bold transition disabled:opacity-50 ${
          recording
            ? "bg-red-500 text-white"
            : "bg-[#c8f135] text-black hover:bg-[#b3da2f]"
        }`}
      >
        {processing ? "Transcribing..." : recording ? "⬛ Stop" : "🎙 Record"}
      </button>

      {error && (
        <p className="mt-8 text-red-400 text-sm max-w-lg text-center">
          ❌ {error}
        </p>
      )}

      {transcript && (
        <div className="mt-12 max-w-2xl w-full">
          <h2 className="text-xs uppercase tracking-widest text-gray-500 mb-3">
            Transcript
          </h2>
          <p className="text-base leading-relaxed bg-zinc-900 p-6 rounded-lg border border-zinc-800">
            {transcript}
          </p>
        </div>
      )}
    </main>
  );
}

