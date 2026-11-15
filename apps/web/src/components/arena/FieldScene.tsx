"use client";
/**
 * A single field, played back from a decoded Replay (DESIGN.md §4.2).
 *
 * One R3F Canvas: soil plane + raised beds, instanced crops (round, leaf-400)
 * and weeds (spiky, bloom-400), the rover (signal-400 when it is the promoted
 * policy, sky-400 when it is the baseline), act puffs, dark soil patches where
 * weeds were pulled, and damaged crops that turn blight-500 and droop.
 *
 * The playhead can be left to the component (`playing`) or driven from outside
 * (`t`), which is how the compare view keeps both fields on the same frame.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { C } from "@/lib/colors";
import { decodeReplay, type DecodedReplay } from "@/lib/replay-decode";
import type { EventType, Replay } from "@/lib/contracts";

export type PolicyKind = "baseline" | "promoted";

export type FieldSceneProps = {
  replay: Replay;
  policyKind: PolicyKind;
  playing: boolean;
  onScrub?: (t: number) => void;
  /** Controlled playhead (frame index). Omit to let the scene run its own clock. */
  t?: number;
  /** Playback rate relative to sim time (dt seconds per frame). */
  speed?: number;
  label?: string;
  showScrub?: boolean;
  className?: string;
};

const MAX_PLANTS = 4000;
const MAX_PUFFS = 48;
/** frames an act puff stays visible */
const PUFF_LIFE = 12;

function reducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

function puffColor(kind: EventType): string {
  if (kind === "removed_target") return C.signal400;
  if (kind === "removed_protect" || kind === "trampled_protect") return C.blight500;
  return C.chaff600;
}

function FieldObjects({
  dec, policyKind, tRef,
}: {
  dec: DecodedReplay;
  policyKind: PolicyKind;
  tRef: React.RefObject<number>;
}) {
  const { camera, size } = useThree();

  const geo = useMemo(
    () => ({
      crop: new THREE.IcosahedronGeometry(1, 1),
      weed: new THREE.ConeGeometry(1, 2.4, 5),
      patch: new THREE.CircleGeometry(1, 14),
      puff: new THREE.RingGeometry(0.62, 1, 18),
      rover: new THREE.BoxGeometry(1, 1, 1),
      plane: new THREE.PlaneGeometry(1, 1),
      bed: new THREE.BoxGeometry(1, 1, 1),
    }),
    [],
  );
  useEffect(() => () => { for (const g of Object.values(geo)) g.dispose(); }, [geo]);

  const cropRef = useRef<THREE.InstancedMesh>(null);
  const weedRef = useRef<THREE.InstancedMesh>(null);
  const patchRef = useRef<THREE.InstancedMesh>(null);
  const puffRef = useRef<THREE.InstancedMesh>(null);
  const roverRef = useRef<THREE.Mesh>(null);

  const m = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const e = useMemo(() => new THREE.Euler(), []);
  const v = useMemo(() => new THREE.Vector3(), []);
  const s = useMemo(() => new THREE.Vector3(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const flat = useMemo(() => new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-Math.PI / 2, 0, 0),
  ), []);

  const events = useMemo(
    () => [...dec.events].sort((a, b) => a[0] - b[0]),
    [dec],
  );

  /** how many events have fired at or before the current frame — the rebuild key */
  const appliedRef = useRef(-1);
  useEffect(() => { appliedRef.current = -1; }, [dec]);

  const L = dec.field.length_m;
  const W = dec.field.width_m;
  const cx = L / 2;
  const cz = W / 2;

  // ── plants: rebuilt only when an event fires or the replay changes ──
  useFrame(() => {
    const crop = cropRef.current, weed = weedRef.current, patch = patchRef.current;
    if (!crop || !weed || !patch) return;
    const t = Math.max(0, Math.min(dec.frames - 1, tRef.current ?? 0));

    let applied = 0;
    for (const ev of events) { if (ev[0] <= t) applied++; else break; }
    if (applied === appliedRef.current) return;
    appliedRef.current = applied;

    const plants = dec.plantsAt(t);
    let ci = 0, wi = 0, pi = 0;

    for (const p of plants) {
      const r = Math.max(0.018, p.radius);
      const removed = !p.alive;

      if (removed && pi < MAX_PLANTS) {
        // the pulled plant leaves disturbed, darker soil behind
        s.set(r * 1.5, r * 1.5, 1);
        v.set(p.x, 0.012, p.y);
        m.compose(v, flat, s);
        patch.setMatrixAt(pi, m);
        col.set(C.soil950).multiplyScalar(p.cls === 1 ? 0.85 : 1);
        patch.setColorAt(pi, col);
        pi++;
      }

      if (p.cls === 0) {
        // crop: round. Damaged ones go blight-500 and droop sideways.
        if (ci >= MAX_PLANTS) continue;
        if (removed && !p.damaged) continue;
        const droop = p.damaged;
        e.set(0, 0, droop ? 0.95 : 0);
        q.setFromEuler(e);
        s.set(r, droop ? r * 0.55 : r * 1.15, r);
        v.set(p.x, droop ? r * 0.4 : r * 0.95, p.y);
        m.compose(v, q, s);
        crop.setMatrixAt(ci, m);
        col.set(p.damaged ? C.blight500 : C.leaf400);
        if (p.damaged) col.multiplyScalar(0.92);
        crop.setColorAt(ci, col);
        ci++;
      } else {
        // weed: spiky. Gone once removed — only the soil patch remains.
        if (removed || wi >= MAX_PLANTS) continue;
        s.set(r * 0.9, r * 2.0, r * 0.9);
        q.identity();
        v.set(p.x, r * 1.4, p.y);
        m.compose(v, q, s);
        weed.setMatrixAt(wi, m);
        col.set(C.bloom400);
        weed.setColorAt(wi, col);
        wi++;
      }
    }

    crop.count = ci; weed.count = wi; patch.count = pi;
    crop.instanceMatrix.needsUpdate = true;
    weed.instanceMatrix.needsUpdate = true;
    patch.instanceMatrix.needsUpdate = true;
    if (crop.instanceColor) crop.instanceColor.needsUpdate = true;
    if (weed.instanceColor) weed.instanceColor.needsUpdate = true;
    if (patch.instanceColor) patch.instanceColor.needsUpdate = true;
  });

  // ── rover + act puffs: every frame ──
  useFrame(() => {
    const t = Math.max(0, Math.min(dec.frames - 1, tRef.current ?? 0));
    const rover = roverRef.current;
    if (rover) {
      const pose = dec.roverAt(t);
      rover.position.set(pose.x, 0.055, pose.y);
      rover.rotation.set(0, -pose.theta, 0);
      const base = policyKind === "baseline" ? C.sky400 : C.signal400;
      const mat = rover.material as THREE.MeshLambertMaterial;
      col.set(base);
      if (pose.act) col.lerp(new THREE.Color(C.chaff200), 0.55);
      mat.color.copy(col);
      const grow = pose.act ? 1.18 : 1;
      rover.scale.set(0.20 * grow, 0.085, 0.13 * grow);
    }

    const puff = puffRef.current;
    if (!puff) return;
    let i = 0;
    for (const [et, pid, kind] of events) {
      const age = t - et;
      if (age < 0 || age >= PUFF_LIFE || i >= MAX_PUFFS) continue;
      const p = dec.plants[pid];
      if (!p) continue;
      const k = age / PUFF_LIFE;
      const rad = Math.max(0.03, p.radius) * (1.1 + 2.6 * k);
      s.set(rad, rad, 1);
      v.set(p.x, 0.02 + 0.02 * k, p.y);
      m.compose(v, flat, s);
      puff.setMatrixAt(i, m);
      col.set(puffColor(kind)).multiplyScalar(1 - k * 0.85);
      puff.setColorAt(i, col);
      i++;
    }
    puff.count = i;
    puff.instanceMatrix.needsUpdate = true;
    if (puff.instanceColor) puff.instanceColor.needsUpdate = true;
  });

  // ── camera: fixed 3/4 that frames the whole strip; orbit only if allowed ──
  const t0 = useRef(0);
  const reducedRef = useRef<boolean | null>(null);
  useFrame(() => {
    const cam = camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera) return;
    if (reducedRef.current === null) reducedRef.current = reducedMotion();
    if (t0.current === 0) t0.current = performance.now();
    const reduced = reducedRef.current;
    const aspect = size.height > 0 ? size.width / size.height : 1.6;
    const vfov = (cam.fov * Math.PI) / 180;
    const needW = L * 1.14;
    const needH = Math.max(W * 3.2, L * 0.34);
    const d = Math.max(
      needW / 2 / (Math.tan(vfov / 2) * Math.max(0.4, aspect)),
      needH / 2 / Math.tan(vfov / 2),
    ) * 1.04;
    const el = 0.72;                                  // ~41° above the beds
    const az = reduced ? 0 : Math.sin((performance.now() - t0.current) / 5600) * (Math.PI / 60);
    cam.position.set(
      cx + Math.sin(az) * d * 0.28,
      Math.sin(el) * d,
      cz + Math.cos(el) * d,
    );
    cam.lookAt(cx, 0, cz);
  });

  const bedZ = dec.field.rows_y.length ? dec.field.rows_y : [cz];
  const bedW = bedZ.length > 1
    ? Math.min(0.42, Math.abs(bedZ[1] - bedZ[0]) * 0.72)
    : Math.min(0.42, W * 0.6);

  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[L * 0.3, L * 0.5, W * 4]} intensity={0.9} />

      {/* soil */}
      <mesh geometry={geo.plane} position={[cx, 0, cz]} rotation={[-Math.PI / 2, 0, 0]}
        scale={[L * 1.08, W * 2.4, 1]}>
        <meshLambertMaterial color={C.soil900} toneMapped={false} />
      </mesh>

      {/* raised beds, one per crop row */}
      {bedZ.map((z, i) => (
        <mesh key={i} geometry={geo.bed} position={[cx, 0.016, z]} scale={[L, 0.032, bedW]}>
          <meshLambertMaterial color={C.soil800} toneMapped={false} />
        </mesh>
      ))}

      <instancedMesh ref={patchRef} args={[geo.patch, undefined, MAX_PLANTS]}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={cropRef} args={[geo.crop, undefined, MAX_PLANTS]}>
        <meshLambertMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={weedRef} args={[geo.weed, undefined, MAX_PLANTS]}>
        <meshLambertMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={puffRef} args={[geo.puff, undefined, MAX_PUFFS]}>
        <meshBasicMaterial toneMapped={false} transparent opacity={0.8} side={THREE.DoubleSide} />
      </instancedMesh>

      <mesh ref={roverRef} geometry={geo.rover} position={[0, 0.055, cz]}
        scale={[0.2, 0.085, 0.13]}>
        <meshLambertMaterial
          color={policyKind === "baseline" ? C.sky400 : C.signal400}
          toneMapped={false}
        />
      </mesh>
    </>
  );
}

export function FieldScene({
  replay, policyKind, playing, onScrub, t, speed = 3, label,
  showScrub = true, className,
}: FieldSceneProps) {
  const dec = useMemo(() => {
    try { return decodeReplay(replay); } catch { return null; }
  }, [replay]);

  const frames = dec?.frames ?? 0;
  const controlled = typeof t === "number";
  const [own, setOwn] = useState(0);
  const tRef = useRef(0);

  // the playhead the scene actually reads (mutated every frame, never re-renders)
  const head = controlled ? Math.max(0, Math.min(frames - 1, t ?? 0)) : own;
  useEffect(() => { tRef.current = head; }, [head]);

  // own clock: advance in sim time, publish to the scrub bar ~10x/s
  useEffect(() => {
    if (controlled || !playing || !dec || frames < 2) return;
    let raf = 0;
    let last = performance.now();
    let lastPublish = 0;
    const step = (now: number) => {
      const dtS = Math.min(0.25, (now - last) / 1000);
      last = now;
      // read tRef every frame so a scrub mid-playback is respected
      const next = Math.min(frames - 1, tRef.current + (dtS / Math.max(0.001, dec.dt)) * speed);
      tRef.current = next;
      if (now - lastPublish > 90) {
        lastPublish = now;
        setOwn(next);
        onScrub?.(next);
      }
      if (next < frames - 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [controlled, playing, dec, frames, speed, onScrub]);

  if (!dec) {
    return (
      <div className={`panel grid place-items-center text-xs ${className ?? ""}`}
        style={{ color: C.chaff600 }}>
        replay could not be decoded
      </div>
    );
  }

  const seconds = (head * dec.dt).toFixed(1);
  const total = ((frames - 1) * dec.dt).toFixed(1);
  const accent = policyKind === "baseline" ? C.sky400 : C.signal400;

  return (
    <div className={`flex flex-col min-h-0 ${className ?? ""}`}>
      <div className="relative flex-1 min-h-0">
        <Canvas
          camera={{ fov: 32, near: 0.05, far: 400 }}
          dpr={[1, 1.75]}
          gl={{ antialias: true, powerPreference: "high-performance" }}
          style={{ background: C.soil950 }}
        >
          <FieldObjects dec={dec} policyKind={policyKind} tRef={tRef} />
        </Canvas>
        <div className="pointer-events-none absolute left-3 top-2 flex items-center gap-2 text-[11px]">
          <span className="chip num" style={{ color: accent, borderColor: `${accent}66` }}>
            {policyKind === "baseline" ? "BASELINE" : "PROMOTED"}
          </span>
          {label && <span style={{ color: C.chaff400 }}>{label}</span>}
          <span className="num" style={{ color: C.chaff600 }}>seed {dec.seed}</span>
        </div>
      </div>

      {showScrub && (
        <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-t border-soil-700">
          <input
            type="range"
            min={0}
            max={Math.max(1, frames - 1)}
            step={1}
            value={Math.round(head)}
            aria-label="scrub replay"
            onChange={(ev) => {
              const next = Number(ev.target.value);
              tRef.current = next;
              if (!controlled) setOwn(next);
              onScrub?.(next);
            }}
            className="flex-1 h-1 appearance-none rounded-full"
            style={{
              background: `linear-gradient(to right, ${accent} ${(head / Math.max(1, frames - 1)) * 100}%, ${C.soil700} ${(head / Math.max(1, frames - 1)) * 100}%)`,
              accentColor: accent,
            }}
          />
          <span className="num text-[11px] shrink-0" style={{ color: C.chaff400 }}>
            {seconds}s / {total}s
          </span>
        </div>
      )}
    </div>
  );
}
