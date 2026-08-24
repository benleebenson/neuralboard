"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BOARD_SURFACE_COLOR } from "@/lib/board-theme";
import { CharacterEntity, LocalInputAdapter, previewEntityActionPose } from "@/lib/character/entity";
import { drawBoardCharacterToCanvas, drawCharacterSkeletonOverlayToCanvas, type BoardCharPoseResult } from "@/lib/character/board-renderer";
import {
  characterDespawnedAt,
  explodeShakeAt,
} from "@/lib/character/explode";
import {
  sampleTrenchCoatReveal,
  trenchCoatRevealPose,
  TRENCH_COAT_REVEAL_BEATS,
} from "@/lib/character/trench-coat-reveal";
import { characterSequences, sampleSequence } from "@/lib/character/sequences";
import { STREAM_ACTION_TYPES, type CharacterSkin } from "@/lib/stream";
import { DEFAULT_POSE, sampleAnimation, starterAnimations, type Pose } from "@/lib/characterAnimations";
import styles from "./anim.module.css";

const GROUND_Y = 125;
const FRAME_SECONDS = 1 / 60;
const SINGLE_MOVE_SECONDS: Record<string, number> = {
  idle: 2, walk: 1.2, run: 0.8, walkTo: 1.2, runTo: 0.8,
  jump: 1.1, jumpTo: 1.1, flip: 1.25, grapple: 1.8, skateTo: 2.4,
  wallClimb: 1.8, zipline: 1.8, pointAt: 1.8, explainGesture: 2.4,
  dance: 2.5, pullUps: 3.2, pullups: 3.2, mirrorCheck: 3,
  sitAndWatch: 2.2, emote: 2, forceChoke: 2.2, eliminated: 1.4,
};

type VisualStyle = "stick" | "jacked" | "styled";
type CharacterControls = {
  x: number;
  style: VisualStyle;
  physique: "slim" | "jacked";
  facing: 1 | -1;
  skeleton: boolean;
};

type MoveOption = {
  id: string;
  label: string;
  group: "Sequences" | "Character moves" | "Authored clips";
  duration: number;
  kind: "sequence" | "action" | "authored";
  key: string;
};

const authoredAnimations = starterAnimations("harness");
const moveOptions: MoveOption[] = [
  ...characterSequences.map((sequence) => ({
    id: `sequence:${sequence.id}`, label: sequence.name, group: "Sequences" as const,
    duration: sequence.durationSeconds, kind: "sequence" as const, key: sequence.id,
  })),
  ...STREAM_ACTION_TYPES.map((name) => ({
    id: `action:${name}`, label: name, group: "Character moves" as const,
    duration: SINGLE_MOVE_SECONDS[name] ?? 2, kind: "action" as const, key: name,
  })),
  ...authoredAnimations.map((animation) => ({
    id: `authored:${animation.name}`, label: animation.name, group: "Authored clips" as const,
    duration: SINGLE_MOVE_SECONDS[animation.name] ?? 2, kind: "authored" as const, key: animation.name,
  })),
];

function poseResult(pose: Pose, x: number, facing: 1 | -1): BoardCharPoseResult {
  return {
    boardX: x, boardY: GROUND_Y, facing,
    headBob: pose.headBob, bodyLean: pose.bodyLean, headTilt: pose.headTilt,
    spinAngle: pose.poseRotation * facing,
    leftLegA: pose.leftLegA, rightLegA: pose.rightLegA,
    leftShinA: pose.leftShinA, rightShinA: pose.rightShinA,
    leftArmA: pose.leftArmA, rightArmA: pose.rightArmA,
    leftForeA: pose.leftForeA, rightForeA: pose.rightForeA,
    airY: pose.airborneY,
    actionType: "animationHarness",
  };
}

function poseReadout(pose: BoardCharPoseResult): Array<[string, number]> {
  return [
    ["leftLegA", pose.leftLegA], ["rightLegA", pose.rightLegA],
    ["leftShinA", pose.leftShinA ?? pose.leftLegA], ["rightShinA", pose.rightShinA ?? pose.rightLegA],
    ["leftArmA", pose.leftArmA], ["rightArmA", pose.rightArmA],
    ["leftForeA", pose.leftForeA], ["rightForeA", pose.rightForeA],
    ["bodyLean", pose.bodyLean], ["headTilt", pose.headTilt ?? 0],
    ["poseRotation", pose.spinAngle ?? 0], ["airborneY", pose.airY ?? 0],
  ];
}

function CharacterControlRow({
  name, value, onChange,
}: {
  name: string;
  value: CharacterControls;
  onChange: (next: CharacterControls) => void;
}) {
  return (
    <div className={styles.characterRow}>
      <div className={styles.charName}>{name}</div>
      <label className={styles.label}>Position X
        <input type="number" step={5} value={value.x} onChange={(event) => onChange({ ...value, x: Number(event.target.value) || 0 })} />
      </label>
      <label className={styles.label}>Skin
        <select value={value.style} onChange={(event) => onChange({ ...value, style: event.target.value as VisualStyle })}>
          <option value="stick">stick</option><option value="jacked">jacked</option><option value="styled">styled</option>
        </select>
      </label>
      <label className={styles.label}>Physique
        <select value={value.physique} onChange={(event) => onChange({ ...value, physique: event.target.value as CharacterControls["physique"] })}>
          <option value="slim">slim</option><option value="jacked">jacked</option>
        </select>
      </label>
      <label className={styles.label}>Facing
        <select value={value.facing} onChange={(event) => onChange({ ...value, facing: Number(event.target.value) as 1 | -1 })}>
          <option value={1}>right</option><option value={-1}>left</option>
        </select>
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={value.skeleton} onChange={(event) => onChange({ ...value, skeleton: event.target.checked })} /> Skeleton
      </label>
    </div>
  );
}

export default function AnimationHarnessPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentTimeRef = useRef(0);
  const [selectedId, setSelectedId] = useState("sequence:trench-coat-reveal");
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [characterA, setCharacterA] = useState<CharacterControls>({ x: 0, style: "stick", physique: "slim", facing: 1, skeleton: false });
  const [characterB, setCharacterB] = useState<CharacterControls>({ x: 115, style: "styled", physique: "slim", facing: -1, skeleton: false });
  const selected = moveOptions.find((option) => option.id === selectedId) ?? moveOptions[0];
  const progress = selected.duration > 0 ? Math.min(1, currentTime / selected.duration) : 0;

  const poses = useMemo(() => {
    const idleB = poseResult(DEFAULT_POSE, characterB.x, characterB.facing);
    if (selected.kind === "sequence") {
      const sequence = characterSequences.find((item) => item.id === selected.key);
      if (!sequence) {
        return { a: poseResult(DEFAULT_POSE, characterA.x, characterA.facing), b: idleB };
      }
      if (sequence.kind === "single-canvas") {
        const base = poseResult(DEFAULT_POSE, characterA.x, characterA.facing);
        const sequencePose = sequence.renderer === "trenchCoatReveal" ? trenchCoatRevealPose(progress) : {};
        return {
          a: {
            ...base,
            ...sequencePose,
            actionType: "sequence",
            sequenceRenderer: sequence.renderer,
            sequenceProgress: progress,
            ...(sequence.renderer === "explode" ? {
              characterHidden: characterDespawnedAt(currentTime, [{
                id: "harness-explode",
                type: "sequence",
                startTime: 0,
                duration: sequence.durationSeconds,
                sequenceId: sequence.id,
              }]),
            } : {}),
          },
          b: idleB,
        };
      }
      const direction: 1 | -1 = characterB.x >= characterA.x ? 1 : -1;
      const sampled = sampleSequence(sequence, progress, {
        centerX: (characterA.x + characterB.x) / 2,
        groundY: GROUND_Y,
        direction,
        distance: Math.max(1, Math.abs(characterB.x - characterA.x)),
      });
      const a = sampled.characters.attacker;
      const b = sampled.characters.victim;
      return { a: poseResult(a.pose, a.position.x, a.facing), b: poseResult(b.pose, b.position.x, b.facing) };
    }
    if (selected.kind === "authored") {
      const animation = authoredAnimations.find((item) => item.name === selected.key);
      return { a: poseResult(sampleAnimation(animation, progress) ?? DEFAULT_POSE, characterA.x, characterA.facing), b: idleB };
    }
    return {
      a: previewEntityActionPose({ x: characterA.x, y: GROUND_Y, facing: characterA.facing, actionType: selected.key, progress, physique: characterA.physique, emoji: "💥" }),
      b: idleB,
    };
  }, [characterA, characterB, currentTime, progress, selected]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let prior = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(0.1, (now - prior) / 1000) * speed;
      prior = now;
      const next = currentTimeRef.current + delta;
      if (next < selected.duration) {
        currentTimeRef.current = next;
      } else if (loop) {
        currentTimeRef.current = next % selected.duration;
      } else {
        currentTimeRef.current = selected.duration;
        setPlaying(false);
      }
      setCurrentTime(currentTimeRef.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [loop, playing, selected.duration, speed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, select, textarea")) return;
      event.preventDefault();
      setPlaying(false);
      currentTimeRef.current = Math.max(0, Math.min(selected.duration, currentTimeRef.current + (event.key === "ArrowRight" ? FRAME_SECONDS : -FRAME_SECONDS)));
      setCurrentTime(currentTimeRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected.duration]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = BOARD_SURFACE_COLOR;
      ctx.fillRect(0, 0, rect.width, rect.height);
      const cam = { cameraX: 0, cameraY: 0, boardZoom: 1 };
      const selectedSequence = selected.kind === "sequence" ? characterSequences.find((item) => item.id === selected.key) : null;
      const harnessExplodeAction = selectedSequence?.kind === "single-canvas" && selectedSequence.renderer === "explode"
        ? {
            id: "harness-explode",
            type: "sequence",
            startTime: 0,
            duration: selectedSequence.durationSeconds,
            sequenceId: selectedSequence.id,
            sequenceRole: "performer",
            sequenceSetupDuration: 0,
            sequenceCenterX: characterA.x,
            sequenceCenterY: GROUND_Y,
            targetX: characterA.x,
            targetY: GROUND_Y,
          }
        : null;
      const shake = harnessExplodeAction
        ? explodeShakeAt(currentTime, [[harnessExplodeAction]])
        : { x: 0, y: 0 };
      ctx.translate(shake.x, shake.y);
      ctx.strokeStyle = "rgba(42,42,42,0.34)";
      ctx.lineWidth = 1.5;
      const groundScreenY = GROUND_Y + rect.height / 2;
      ctx.beginPath(); ctx.moveTo(32, groundScreenY); ctx.lineTo(rect.width - 32, groundScreenY); ctx.stroke();
      if (selectedSequence?.kind === "single-canvas" && selectedSequence.renderer === "explode" && harnessExplodeAction) {
        const physique = characterA.style === "jacked" ? "jacked" : characterA.physique;
        const skin: CharacterSkin = characterA.style === "styled" ? "styled" : "stick";
        drawBoardCharacterToCanvas(
          ctx,
          currentTime,
          [harnessExplodeAction],
          true,
          cam,
          1,
          rect.width,
          rect.height,
          characterA.x,
          GROUND_Y,
          [],
          -Infinity,
          {},
          null,
          skin,
          "stickFigure",
          "neutral",
          poses.a,
          { evalCharAtTime: () => poses.a, physiqueAt: () => physique },
        );
        if (characterA.skeleton && !poses.a.characterHidden) {
          drawCharacterSkeletonOverlayToCanvas(ctx, poses.a, cam, 1, rect.width, rect.height);
        }
        return;
      }
      const makeEntity = (name: "A" | "B", controls: CharacterControls, pose: BoardCharPoseResult) => {
        const physique = controls.style === "jacked" ? "jacked" : controls.physique;
        const skin: CharacterSkin = controls.style === "styled" ? "styled" : "stick";
        const entity = new CharacterEntity({ id: name, isHost: name === "A", name, skin, physique }, new LocalInputAdapter([selected.key]));
        entity.pose = pose;
        entity.draw({ ctx, cam, sf: 1, width: rect.width, height: rect.height, renderTimeMs: currentTime * 1000 });
        if (controls.skeleton) drawCharacterSkeletonOverlayToCanvas(ctx, pose, cam, 1, rect.width, rect.height);
      };
      makeEntity("B", characterB, poses.b);
      makeEntity("A", characterA, poses.a);
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [characterA, characterB, currentTime, poses, progress, selected.key, selected.kind]);

  const grouped = ["Sequences", "Character moves", "Authored clips"] as const;
  const selectMove = (id: string) => { setSelectedId(id); currentTimeRef.current = 0; setCurrentTime(0); setPlaying(true); };
  const togglePlaying = () => {
    if (playing) { setPlaying(false); return; }
    if (currentTimeRef.current >= selected.duration) {
      currentTimeRef.current = 0;
      setCurrentTime(0);
    }
    setPlaying(true);
  };
  const trenchSample = sampleTrenchCoatReveal(progress);
  const jumpToBeat = (beatProgress: number) => {
    const value = beatProgress * selected.duration;
    currentTimeRef.current = value;
    setCurrentTime(value);
    setPlaying(false);
  };
  const selectedSequence = selected.kind === "sequence" ? characterSequences.find((item) => item.id === selected.key) : null;
  const isTrenchReveal = selectedSequence?.kind === "single-canvas" && selectedSequence.renderer === "trenchCoatReveal";
  const isSingleSequence = selectedSequence?.kind === "single-canvas";
  const poseKeys: Array<"a" | "b"> = isSingleSequence ? ["a"] : ["a", "b"];
  return (
    <main className={styles.page}>
      <section className={styles.stage} aria-label="Animation preview stage">
        <div className={styles.stageMeta} aria-live="polite">
          <span className={styles.stageEyebrow}>{isTrenchReveal ? "7-frame study" : "sequence study"}</span>
          <strong>{isTrenchReveal ? trenchSample.beatLabel : selected.label}</strong>
        </div>
        <canvas ref={canvasRef} className={styles.canvas} />
      </section>
      <section className={styles.controls} aria-label="Animation controls">
        <div className={styles.transport}>
          <label className={styles.label}>Move
            <select value={selected.id} onChange={(event) => selectMove(event.target.value)}>
              {grouped.map((group) => <optgroup key={group} label={group}>{moveOptions.filter((option) => option.group === group).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</optgroup>)}
            </select>
          </label>
          <button type="button" className={styles.button} onClick={togglePlaying}>{playing ? "Pause" : "Play"}</button>
          <button type="button" className={`${styles.button} ${loop ? styles.buttonActive : ""}`} aria-pressed={loop} onClick={() => setLoop((value) => !value)}>Loop</button>
          <label className={styles.label}>Speed
            <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value={0.25}>0.25x</option><option value={0.5}>0.5x</option><option value={1}>1x</option></select>
          </label>
          <label className={styles.label}>Scrub
            <input aria-label="Animation time" type="range" min={0} max={selected.duration} step={0.001} value={currentTime} onChange={(event) => { const value = Number(event.target.value); currentTimeRef.current = value; setPlaying(false); setCurrentTime(value); }} />
          </label>
          <div className={styles.time}>{currentTime.toFixed(3)} / {selected.duration.toFixed(2)}s</div>
        </div>
        {isTrenchReveal && (
          <div className={styles.beatStrip} aria-label="Trench coat keyframes">
            {TRENCH_COAT_REVEAL_BEATS.map((beat, index) => (
              <button
                type="button"
                key={beat.label}
                className={`${styles.beatButton} ${trenchSample.beatIndex === index ? styles.beatButtonActive : ""}`}
                aria-pressed={trenchSample.beatIndex === index}
                onClick={() => jumpToBeat(beat.t)}
              >
                <span>{index + 1}</span>{beat.shortLabel}
              </button>
            ))}
          </div>
        )}
        <CharacterControlRow name="A" value={characterA} onChange={setCharacterA} />
        {!isSingleSequence && <CharacterControlRow name="B" value={characterB} onChange={setCharacterB} />}
        <div className={styles.readouts}>
          {poseKeys.map((key) => <div className={styles.posePanel} key={key}><div className={styles.poseTitle}>Character {key.toUpperCase()} pose</div><div className={styles.poseGrid}>{poseReadout(poses[key]).map(([name, value]) => <span key={name}>{name} {Number(value).toFixed(3)}</span>)}</div></div>)}
        </div>
        <div className={styles.hint}>← / → steps one 60 fps frame</div>
      </section>
    </main>
  );
}
