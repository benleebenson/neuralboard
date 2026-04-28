"use client";

import { useState, useRef, useEffect } from "react";

type Beat = {
  startTime: number;
  endTime: number;
  searchQuery: string;
  reasoning: string;
  images?: string[];
};

export default function BuilderPage() {
  const [authed, setAuthed] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");
  const [password, setPassword] = useState("");

  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [duration, setDuration] = useState(0);
  const [beats, setBeats] = useState<Beat[]>([]);
  const [error, setError] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Restore password from sessionStorage so refresh doesn't kick you out
  useEffect(() => {
    const saved = sessionStorage.getItem("nb_pw");
    if (saved) {
      setPassword(saved);
      setAuthed(true);
    }
  }, []);

  function handleUnlock() {
    if (!pwInput.trim()) {
      setPwError("Enter the password");
      return;
    }
    setPassword(pwInput.trim());
    sessionStorage.setItem("nb_pw", pwInput.trim());
    setAuthed(true);
    setPwError("");
  }

  async function startRecording() {
    setError("");
    setTranscript("");
    setBeats([]);
    setDuration(0);
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
        headers: {
          "Content-Type": blob.type || "audio/webm",
          "x-neuralboard-password": password,
        },
        body: blob,
      });
      if (res.status === 401) {
        // Wrong password — kick back to login
        sessionStorage.removeItem("nb_pw");
        setAuthed(false);
        setPwError("Password expired or invalid");
        setProcessing(false);
        return;
      }
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Transcription failed");
      setTranscript(data.transcript);
      setDuration(data.duration);
      setBeats(data.beats || []);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
    } finally {
      setProcessing(false);
    }
  }

  // ── Password gate ────────────────────────────────────────────
  if (!authed) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-8">
        <div className="max-w-sm w-full">
          <h1 className="text-2xl font-bold mb-2 text-[#c8f135] text-center">
            Neural Board
          </h1>
          <p className="text-sm text-gray-500 mb-8 text-center">
            Private beta — enter the password.
          </p>
          <input
            type="password"
            value={pwInput}
            onChange={(e) => setPwInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleUnlock();
            }}
            placeholder="Password"
            autoFocus
            className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg text-white placeholder-gray-600 focus:border-[#c8f135] focus:outline-none mb-3"
          />
          <button
            onClick={handleUnlock}
            className="w-full px-4 py-3 bg-[#c8f135] text-black font-bold rounded-lg hover:bg-[#b3da2f] transition"
          >
            Unlock
          </button>
          {pwError && (
            <p className="text-red-400 text-xs text-center mt-3">{pwError}</p>
          )}
        </div>
      </main>
    );
  }

  // ── Main page ────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center p-8">
      <div className="max-w-3xl w-full">
        <h1 className="text-3xl font-bold mb-2 text-[#c8f135] text-center mt-12">
          Neural Board — Builder
        </h1>
        <p className="text-sm text-gray-400 mb-12 text-center">
          Record a narration. Watch it become a visual plan.
        </p>

        <div className="flex justify-center mb-12">
          <button
            onClick={recording ? stopRecording : startRecording}
            disabled={processing}
            className={`px-8 py-4 rounded-full text-lg font-bold transition disabled:opacity-50 ${
              recording
                ? "bg-red-500 text-white"
                : "bg-[#c8f135] text-black hover:bg-[#b3da2f]"
            }`}
          >
            {processing ? "Planning beats and finding images..." : recording ? "⬛ Stop" : "🎙 Record"}
          </button>
        </div>

        {error && (
          <p className="mb-8 text-red-400 text-sm text-center">❌ {error}</p>
        )}

        {transcript && (
          <div className="mb-10">
            <h2 className="text-xs uppercase tracking-widest text-gray-500 mb-3">
              Transcript ({duration.toFixed(1)}s)
            </h2>
            <p className="text-base leading-relaxed bg-zinc-900 p-6 rounded-lg border border-zinc-800">
              {transcript}
            </p>
          </div>
        )}

        {beats.length > 0 && (
          <div>
            <h2 className="text-xs uppercase tracking-widest text-gray-500 mb-3">
              {beats.length} visual beats planned
            </h2>
            <div className="space-y-4">
              {beats.map((b, i) => (
                <div
                  key={i}
                  className="bg-zinc-900 border border-zinc-800 rounded-lg p-5"
                >
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-[#c8f135] text-xs font-bold uppercase tracking-wider">
                      Beat {i + 1}
                    </span>
                    <span className="text-gray-500 text-xs font-mono">
                      {b.startTime.toFixed(1)}s – {b.endTime.toFixed(1)}s
                    </span>
                  </div>
                  <p className="text-white text-base mb-1">🔍 {b.searchQuery}</p>
                  {b.reasoning && (
                    <p className="text-gray-500 text-xs italic mb-3">{b.reasoning}</p>
                  )}
                  {b.images && b.images.length > 0 ? (
                    <div className="grid grid-cols-3 gap-2 mt-3">
                      {b.images.map((url, j) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={j}
                          src={url}
                          alt={`${b.searchQuery} ${j + 1}`}
                          className="w-full aspect-video object-cover rounded border border-zinc-700"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-gray-600 text-xs mt-3 italic">
                      No images found for this beat.
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}