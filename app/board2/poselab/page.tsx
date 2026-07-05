"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UpgradePrompt } from "@/app/components/ProGated";
import { useIsPro } from "@/app/components/useIsPro";
import {
  AuthoredAnimation,
  DEFAULT_POSE,
  Pose,
  PoseKeyframe,
  RESERVED_ANIMATION_NAMES,
  clamp,
  normalizeAnimation,
  sampleAnimation,
  starterAnimations,
} from "@/lib/characterAnimations";

const PANEL = "#fffdf5";
const INK = "#2a2a2a";
const PARCHMENT = "#f5ecd8";
const ACCENT = "#cdeac0";
const SVG_W = 620;
const SVG_H = 640;
const GROUND_Y = 590;
const HIP_Y = 390;
const TORSO = 150;
const NECK = 26;
const HEAD_R = 42;
const LIMB = 92;

type DragHandle =
  | "head"
  | "leftElbow" | "leftHand" | "rightElbow" | "rightHand"
  | "leftKnee" | "leftFoot" | "rightKnee" | "rightFoot";

function makeDraft(name = "walk"): AuthoredAnimation {
  const now = new Date().toISOString();
  return {
    id: `draft_${Date.now()}`,
    name,
    loop: name === "walk" || name === "idle" || name === "explain",
    createdAt: now,
    keyframes: [
      { t: 0, pose: DEFAULT_POSE },
      { t: 1, pose: DEFAULT_POSE },
    ],
  };
}

function angleFrom(parent: Point, pointer: Point): number {
  return clamp(-Math.atan2(pointer.x - parent.x, pointer.y - parent.y), -1.8, 1.8);
}

function mirrorPose(p: Pose): Pose {
  return {
    ...p,
    rightLegA: -p.leftLegA,
    rightArmA: -p.leftArmA,
    rightForeA: -p.leftForeA,
  };
}

type Point = { x: number; y: number };
type Rig = Record<"hip" | "neck" | "head" | "leftShoulder" | "rightShoulder" | "leftElbow" | "rightElbow" | "leftHand" | "rightHand" | "leftKnee" | "rightKnee" | "leftFoot" | "rightFoot", Point>;

function segment(parent: Point, angle: number, len: number): Point {
  return { x: parent.x - Math.sin(angle) * len, y: parent.y + Math.cos(angle) * len };
}

function rigFromPose(p: Pose): Rig {
  const hip = { x: SVG_W / 2, y: HIP_Y + p.airborneY };
  const shoulder = { x: hip.x + Math.sin(p.bodyLean) * TORSO, y: hip.y - Math.cos(p.bodyLean) * TORSO };
  const neck = { x: shoulder.x + Math.sin(p.bodyLean) * NECK, y: shoulder.y - Math.cos(p.bodyLean) * NECK };
  const head = { x: neck.x + Math.sin(p.bodyLean) * HEAD_R, y: neck.y - Math.cos(p.bodyLean) * HEAD_R };
  const leftShoulder = { x: shoulder.x - 18, y: shoulder.y };
  const rightShoulder = { x: shoulder.x + 18, y: shoulder.y };
  const leftElbow = segment(leftShoulder, p.leftArmA, LIMB);
  const rightElbow = segment(rightShoulder, p.rightArmA, LIMB);
  const leftHand = segment(leftElbow, p.leftForeA, LIMB);
  const rightHand = segment(rightElbow, p.rightForeA, LIMB);
  const leftKnee = segment(hip, p.leftLegA, LIMB);
  const rightKnee = segment(hip, p.rightLegA, LIMB);
  const leftFoot = segment(leftKnee, p.leftLegA + p.leftForeA * 0.5, LIMB);
  const rightFoot = segment(rightKnee, p.rightLegA + p.rightForeA * 0.5, LIMB);
  return { hip, neck, head, leftShoulder, rightShoulder, leftElbow, rightElbow, leftHand, rightHand, leftKnee, rightKnee, leftFoot, rightFoot };
}

function sortKfs(kfs: PoseKeyframe[]) {
  return [...kfs].sort((a, b) => a.t - b.t);
}

export default function PoseLabPage() {
  const router = useRouter();
  const { isPro, loading } = useIsPro();
  const [animations, setAnimations] = useState<AuthoredAnimation[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedT, setSelectedT] = useState(0);
  const [pose, setPose] = useState<Pose>(DEFAULT_POSE);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(1.2);
  const [status, setStatus] = useState("Loading library...");
  const fileRef = useRef<HTMLInputElement>(null);
  const playStartRef = useRef(0);
  const dragRef = useRef<DragHandle | null>(null);

  const selected = animations.find((a) => a.id === selectedId) ?? animations[0] ?? makeDraft();
  const rig = useMemo(() => rigFromPose(pose), [pose]);

  useEffect(() => {
    if (!isPro) return;
    let cancelled = false;
    fetch("/api/board2/character-animations")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`Load failed (${r.status})`)))
      .then((data) => {
        if (cancelled) return;
        const raw = Array.isArray(data) ? data : data.animations;
        const next = (raw ?? []).map(normalizeAnimation).filter(Boolean) as AuthoredAnimation[];
        const usable = next.length ? next : starterAnimations();
        setAnimations(usable);
        setSelectedId(usable[0].id);
        setPose(usable[0].keyframes[0].pose);
        setStatus(data.seedWarning ? `Starter animations loaded in-memory: ${data.seedWarning}` : "Library ready.");
      })
      .catch((err: Error) => {
        const starters = starterAnimations();
        setAnimations(starters);
        setSelectedId(starters[0].id);
        setPose(starters[0].keyframes[0].pose);
        setStatus(`Using in-memory starters: ${err.message}`);
      });
    return () => { cancelled = true; };
  }, [isPro]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = (now: number) => {
      if (!playStartRef.current) playStartRef.current = now;
      const raw = ((now - playStartRef.current) / 1000) / duration;
      const t = selected.loop ? raw % 1 : Math.min(1, raw);
      const sampled = sampleAnimation(selected, t);
      if (sampled) setPose(sampled);
      setSelectedT(t);
      if (!selected.loop && raw >= 1) {
        setPlaying(false);
        playStartRef.current = 0;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, selected, duration]);

  function updateSelected(next: AuthoredAnimation) {
    setAnimations((prev) => prev.map((a) => a.id === next.id ? next : a));
  }

  function captureKeyframe(t = selectedT) {
    const existing = selected.keyframes.find((kf) => Math.abs(kf.t - t) < 0.015);
    const keyframes = existing
      ? selected.keyframes.map((kf) => kf === existing ? { t: kf.t, pose } : kf)
      : [...selected.keyframes, { t: clamp(t, 0, 1), pose }];
    updateSelected({ ...selected, keyframes: sortKfs(keyframes) });
  }

  function selectKeyframe(kf: PoseKeyframe) {
    setPlaying(false);
    setSelectedT(kf.t);
    setPose(kf.pose);
  }

  function deleteKeyframe() {
    if (selected.keyframes.length <= 2) return;
    const keyframes = selected.keyframes.filter((kf) => Math.abs(kf.t - selectedT) > 0.015);
    updateSelected({ ...selected, keyframes: sortKfs(keyframes) });
    setSelectedT(keyframes[0].t);
    setPose(keyframes[0].pose);
  }

  function pointerPoint(e: React.PointerEvent<SVGSVGElement>): Point {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * SVG_W / rect.width, y: (e.clientY - rect.top) * SVG_H / rect.height };
  }

  function dragTo(handle: DragHandle, pt: Point) {
    setPose((p) => {
      const r = rigFromPose(p);
      if (handle === "head") return { ...p, bodyLean: clamp(Math.atan2(pt.x - r.hip.x, r.hip.y - pt.y), -0.8, 0.8) };
      if (handle === "leftElbow") return { ...p, leftArmA: angleFrom(r.leftShoulder, pt) };
      if (handle === "rightElbow") return { ...p, rightArmA: angleFrom(r.rightShoulder, pt) };
      if (handle === "leftHand") return { ...p, leftForeA: angleFrom(r.leftElbow, pt) };
      if (handle === "rightHand") return { ...p, rightForeA: angleFrom(r.rightElbow, pt) };
      if (handle === "leftKnee") return { ...p, leftLegA: angleFrom(r.hip, pt) };
      if (handle === "rightKnee") return { ...p, rightLegA: angleFrom(r.hip, pt) };
      if (handle === "leftFoot") return { ...p, leftForeA: clamp((angleFrom(r.leftKnee, pt) - p.leftLegA) * 2, -1.8, 1.8) };
      if (handle === "rightFoot") return { ...p, rightForeA: clamp((angleFrom(r.rightKnee, pt) - p.rightLegA) * 2, -1.8, 1.8) };
      return p;
    });
  }

  async function saveSelected() {
    setStatus("Saving...");
    const res = await fetch("/api/board2/character-animations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ animation: selected }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error ?? "Save failed.");
      return;
    }
    const normalized = normalizeAnimation(data);
    if (normalized) {
      setAnimations((prev) => prev.map((a) => a.id === selected.id ? normalized : a));
      setSelectedId(normalized.id);
    }
    setStatus("Saved.");
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(animations, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "neuralboard-character-animations.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJson(file: File) {
    file.text().then((text) => {
      const parsed = JSON.parse(text);
      const raw = Array.isArray(parsed) ? parsed : parsed.animations;
      const next = (raw ?? []).map(normalizeAnimation).filter(Boolean) as AuthoredAnimation[];
      if (!next.length) throw new Error("No valid animations found.");
      setAnimations(next);
      setSelectedId(next[0].id);
      setPose(next[0].keyframes[0].pose);
      setStatus("Imported JSON. Save each animation to persist it.");
    }).catch((err: Error) => setStatus(err.message));
  }

  const disabled = loading || !isPro;

  return (
    <main style={{ minHeight: "100vh", background: PARCHMENT, color: INK, fontFamily: "'Courier New', monospace", position: "relative" }}>
      <div style={{ filter: disabled ? "blur(3px)" : "none", pointerEvents: disabled ? "none" : "auto", opacity: disabled ? 0.55 : 1 }}>
        <header style={{ height: 54, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px", borderBottom: `2px solid ${INK}`, background: PANEL }}>
          <button onClick={() => router.push("/board2")} style={buttonStyle}>← Board</button>
          <strong>🎭 Pose Lab</strong>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={exportJson} style={buttonStyle}>Export JSON</button>
            <button onClick={() => fileRef.current?.click()} style={buttonStyle}>Import JSON</button>
            <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
          </div>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(500px,1fr)", gap: 14, padding: 14 }}>
          <aside style={panelStyle}>
            <h2 style={hStyle}>Library</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {animations.map((a) => (
                <button key={a.id} onClick={() => { setSelectedId(a.id); setPose(a.keyframes[0].pose); setSelectedT(a.keyframes[0].t); }}
                  style={{ ...buttonStyle, textAlign: "left", background: a.id === selected.id ? ACCENT : PANEL }}>
                  {a.name} {a.loop ? "↻" : ""}
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 12 }}>
              <button style={buttonStyle} onClick={() => { const a = makeDraft(); setAnimations((p) => [...p, a]); setSelectedId(a.id); setPose(a.keyframes[0].pose); }}>New</button>
              <button style={buttonStyle} onClick={() => { const copy = { ...selected, id: `draft_${Date.now()}`, name: `${selected.name}-copy`, createdAt: new Date().toISOString() }; setAnimations((p) => [...p, copy]); setSelectedId(copy.id); }}>Duplicate</button>
              <button style={buttonStyle} onClick={() => setAnimations((p) => p.filter((a) => a.id !== selected.id))}>Delete</button>
              <button style={{ ...buttonStyle, background: ACCENT }} onClick={saveSelected}>Save</button>
            </div>

            <h2 style={hStyle}>Name</h2>
            <select value={RESERVED_ANIMATION_NAMES.includes(selected.name as never) ? selected.name : ""} onChange={(e) => e.target.value && updateSelected({ ...selected, name: e.target.value })}
              style={inputStyle}>
              <option value="">custom</option>
              {RESERVED_ANIMATION_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <input value={selected.name} onChange={(e) => updateSelected({ ...selected, name: e.target.value })} style={inputStyle} />
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}><input type="checkbox" checked={selected.loop} onChange={(e) => updateSelected({ ...selected, loop: e.target.checked })} /> Loop</label>
            <p style={{ fontSize: 11, color: "#665", lineHeight: 1.5 }}>{status}</p>
          </aside>

          <section>
            <div style={{ ...panelStyle, padding: 8 }}>
              <svg width="100%" viewBox={`0 0 ${SVG_W} ${SVG_H}`} style={{ display: "block", maxHeight: "66vh", background: PARCHMENT, touchAction: "none" }}
                onPointerMove={(e) => dragRef.current && dragTo(dragRef.current, pointerPoint(e))}
                onPointerUp={() => { dragRef.current = null; captureKeyframe(selectedT); }}
                onPointerLeave={() => { dragRef.current = null; }}>
                <line x1="40" x2={SVG_W - 40} y1={GROUND_Y} y2={GROUND_Y} stroke={INK} strokeWidth="3" strokeLinecap="round" />
                <g transform={`rotate(${pose.poseRotation * 180 / Math.PI} ${SVG_W / 2} ${HIP_Y})`}>
                  <line x1={rig.hip.x} y1={rig.hip.y} x2={rig.neck.x} y2={rig.neck.y} stroke={INK} strokeWidth="8" strokeLinecap="round" />
                  <line x1={rig.leftShoulder.x} y1={rig.leftShoulder.y} x2={rig.leftElbow.x} y2={rig.leftElbow.y} stroke={INK} strokeWidth="7" strokeLinecap="round" />
                  <line x1={rig.leftElbow.x} y1={rig.leftElbow.y} x2={rig.leftHand.x} y2={rig.leftHand.y} stroke={INK} strokeWidth="7" strokeLinecap="round" />
                  <line x1={rig.rightShoulder.x} y1={rig.rightShoulder.y} x2={rig.rightElbow.x} y2={rig.rightElbow.y} stroke={INK} strokeWidth="7" strokeLinecap="round" />
                  <line x1={rig.rightElbow.x} y1={rig.rightElbow.y} x2={rig.rightHand.x} y2={rig.rightHand.y} stroke={INK} strokeWidth="7" strokeLinecap="round" />
                  <line x1={rig.hip.x} y1={rig.hip.y} x2={rig.leftKnee.x} y2={rig.leftKnee.y} stroke={INK} strokeWidth="8" strokeLinecap="round" />
                  <line x1={rig.leftKnee.x} y1={rig.leftKnee.y} x2={rig.leftFoot.x} y2={rig.leftFoot.y} stroke={INK} strokeWidth="8" strokeLinecap="round" />
                  <line x1={rig.hip.x} y1={rig.hip.y} x2={rig.rightKnee.x} y2={rig.rightKnee.y} stroke={INK} strokeWidth="8" strokeLinecap="round" />
                  <line x1={rig.rightKnee.x} y1={rig.rightKnee.y} x2={rig.rightFoot.x} y2={rig.rightFoot.y} stroke={INK} strokeWidth="8" strokeLinecap="round" />
                  <circle cx={rig.head.x} cy={rig.head.y} r={HEAD_R} fill={PANEL} stroke={INK} strokeWidth="7" />
                  {([
                    ["head", rig.head], ["leftElbow", rig.leftElbow], ["leftHand", rig.leftHand], ["rightElbow", rig.rightElbow], ["rightHand", rig.rightHand],
                    ["leftKnee", rig.leftKnee], ["leftFoot", rig.leftFoot], ["rightKnee", rig.rightKnee], ["rightFoot", rig.rightFoot],
                  ] as [DragHandle, Point][]).map(([name, pt]) => (
                    <circle key={name} cx={pt.x} cy={pt.y} r="11" fill={ACCENT} stroke={INK} strokeWidth="3" style={{ cursor: "grab" }}
                      onPointerDown={(e) => { dragRef.current = name; e.currentTarget.setPointerCapture(e.pointerId); }} />
                  ))}
                </g>
              </svg>
            </div>

            <div style={{ ...panelStyle, marginTop: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button style={buttonStyle} onClick={() => { playStartRef.current = 0; setPlaying((v) => !v); }}>{playing ? "Pause" : "Play"}</button>
                <button style={buttonStyle} onClick={() => { setPose(mirrorPose(pose)); captureKeyframe(selectedT); }}>Mirror</button>
                <button style={buttonStyle} onClick={() => captureKeyframe(selectedT)}>Add/Update Keyframe</button>
                <button style={buttonStyle} onClick={deleteKeyframe}>Delete Keyframe</button>
                <label style={labelStyle}>Speed <input type="range" min="0.5" max="4" step="0.1" value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></label>
              </div>
              <div style={{ height: 42, position: "relative", marginTop: 12, border: `2px solid ${INK}`, background: "#f8f0df" }}
                onClick={(e) => { const rect = e.currentTarget.getBoundingClientRect(); const t = clamp((e.clientX - rect.left) / rect.width, 0, 1); setSelectedT(t); captureKeyframe(t); }}>
                {selected.keyframes.map((kf) => (
                  <button key={`${kf.t}`} onClick={(e) => { e.stopPropagation(); selectKeyframe(kf); }}
                    style={{ position: "absolute", left: `${kf.t * 100}%`, top: 4, transform: "translateX(-50%)", width: 18, height: 30, border: `2px solid ${INK}`, background: Math.abs(kf.t - selectedT) < 0.015 ? ACCENT : PANEL, cursor: "pointer" }} />
                ))}
                <div style={{ position: "absolute", left: `${selectedT * 100}%`, top: 0, bottom: 0, width: 2, background: "#cc2200" }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 10 }}>
                {(["bodyLean", "poseRotation", "airborneY"] as const).map((key) => (
                  <label key={key} style={labelStyle}>{key}
                    <input type="range" min={key === "airborneY" ? -180 : -1.5} max={key === "airborneY" ? 80 : 1.5} step="0.01" value={pose[key]}
                      onChange={(e) => setPose((p) => ({ ...p, [key]: Number(e.target.value) }))} onPointerUp={() => captureKeyframe(selectedT)} />
                  </label>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
      {disabled && (
        <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}>
          {loading ? <div style={panelStyle}>Checking Pro access...</div> : <UpgradePrompt featureName="Pose Lab" />}
        </div>
      )}
    </main>
  );
}

const buttonStyle: React.CSSProperties = {
  border: `2px solid ${INK}`,
  background: PANEL,
  color: INK,
  boxShadow: `3px 3px 0 ${INK}`,
  padding: "7px 10px",
  fontFamily: "'Courier New', monospace",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const panelStyle: React.CSSProperties = {
  background: PANEL,
  border: `2px solid ${INK}`,
  boxShadow: `5px 5px 0 ${INK}`,
  padding: 14,
};

const hStyle: React.CSSProperties = {
  fontFamily: "'Courier New', monospace",
  fontSize: 13,
  margin: "0 0 10px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: `2px solid ${INK}`,
  background: PARCHMENT,
  padding: 8,
  margin: "6px 0",
  fontFamily: "'Courier New', monospace",
};

const labelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 11,
  fontWeight: 700,
};
