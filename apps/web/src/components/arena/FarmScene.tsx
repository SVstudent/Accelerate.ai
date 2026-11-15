"use client";
/**
 * The Training Farm / 3D observability platform (DESIGN.md §4.1) — the hero view.
 *
 * One cluster of Box Rooms, one room per Daytona sandbox. From the overview you
 * read the whole cluster as a flat grid of score-tinted field plots (that look
 * works, so it is kept); click a field or a room and the camera flies to that
 * sandbox, where the room gets its full treatment: floor, translucent walls, a
 * score-tinted edge frame and a label plate carrying the real sandbox id and
 * progress.
 *
 * Everything that repeats is instanced — one InstancedMesh per kind across the
 * WHOLE cluster (plots, beds, crops, weeds, rover chassis, masts, tool arms),
 * written imperatively rather than as per-field React components, so 256-384
 * fields stay at 60fps. Rover matrices update every frame; plant matrices only
 * when a reset or event touches them.
 *
 * Controls: drag to orbit · scroll to zoom · W/A/S/D + Q/E to fly · Shift to
 * boost · click a room to fly in · Esc to pull back to the cluster.
 *
 * Nothing here animates without telemetry: a block with no decoded frames
 * renders as an empty room, it does not get invented motion.
 */
import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { C, scoreColor } from "@/lib/colors";
import type { EnvState } from "@/lib/live-frame";
import {
  MX, MZ, PLOT_W, PLOT_D, ROOM_W, ROOM_D, ROOM_H,
  clusterExtent, plotOrigin, roomOrigin,
} from "./roomLayout";

export type FarmBlock = {
  runId: string;
  label: string;            // "sandbox 3 · reward v3 · 63%"
  envs: EnvState[];
  booting?: boolean;
  /** this sandbox streamed the most recent frame — it is working right now */
  active?: boolean;
  pruned?: boolean;
  /** real Daytona sandbox id, when the caller has it */
  sandboxId?: string | null;
  /** 0..1 training progress, when the caller has it */
  progress?: number | null;
};

export type FarmMode = "farm" | "test";

/** Which sandbox (and optionally which field) the camera should be framing. */
export type FarmFocus = { runId: string; env?: number | null } | null;

const MAX_PATCHES = 20_000;
const MAX_PLANTS = 60_000;
const MAX_ROVERS = 512;
const MAX_PLOTS = 512;
const MAX_BEDS = 2048;
const FLY_KEYS = ["w", "a", "s", "d", "q", "e"];

function prefersReducedMotion() {
  return typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Mean of the finished-episode scores in a block, or null if none landed yet. */
function blockScore(b: FarmBlock): number | null {
  const s = b.envs.map((e) => e.score).filter((x): x is number => x !== null && x !== undefined);
  if (!s.length) return null;
  return s.reduce((a, c) => a + c, 0) / s.length;
}

/* ── one sandbox as a Box Room ─────────────────────────────────────────── */
function RoomShell({
  index, roomsWide, block, focused, onPick,
}: {
  index: number; roomsWide: number; block: FarmBlock;
  focused: boolean; onPick?: () => void;
}) {
  const o = roomOrigin(index, roomsWide);
  const score = blockScore(block);
  // The actively-streaming sandbox is called out, because during a demo the
  // first question is "which one is actually running right now?"
  const tint = block.active
    ? C.signal400
    : block.pruned ? C.soil700 : block.booting ? C.soil700 : scoreColor(score);
  const cx = o.x + ROOM_W / 2;
  const cz = o.z + ROOM_D / 2;

  const box = useMemo(
    () => new THREE.BoxGeometry(ROOM_W, ROOM_H, ROOM_D),
    [],
  );
  useEffect(() => () => box.dispose(), [box]);

  const walls = [
    [cx, ROOM_H / 2, o.z, 0, ROOM_W] as const,
    [cx, ROOM_H / 2, o.z + ROOM_D, 0, ROOM_W] as const,
    [o.x, ROOM_H / 2, cz, Math.PI / 2, ROOM_D] as const,
    [o.x + ROOM_W, ROOM_H / 2, cz, Math.PI / 2, ROOM_D] as const,
  ];

  const pct = block.progress === null || block.progress === undefined
    ? null : Math.round(block.progress * 100);

  return (
    <group>
      {/* floor slab — also the click target for "focus this whole sandbox" */}
      <mesh
        position={[cx, 0, cz]}
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={(e) => { e.stopPropagation(); onPick?.(); }}
      >
        <planeGeometry args={[ROOM_W, ROOM_D]} />
        <meshLambertMaterial color={focused ? C.soil800 : C.soil900} />
      </mesh>

      {/* translucent walls: the close-up treatment only, so the overview stays flat */}
      {focused && walls.map(([x, y, z, ry, w], i) => (
        <mesh key={i} position={[x, y, z]} rotation={[0, ry, 0]}>
          <planeGeometry args={[w, ROOM_H]} />
          <meshBasicMaterial
            color={tint} transparent opacity={0.075}
            side={THREE.DoubleSide} depthWrite={false}
          />
        </mesh>
      ))}

      {/* edge frame: the score halo. faint in the overview, full when focused */}
      <lineSegments position={[cx, ROOM_H / 2, cz]}>
        <edgesGeometry args={[box]} />
        <lineBasicMaterial
          color={tint} transparent
          opacity={block.active ? 1 : block.pruned ? 0.2 : focused ? 0.9 : 0.3}
          linewidth={block.active ? 2 : 1}
        />
      </lineSegments>

      {/* label plate floating over the room */}
      <Html
        position={[cx, ROOM_H + (focused ? 1.6 : 1.0), cz]}
        center
        distanceFactor={focused ? 16 : 30}
        zIndexRange={[12, 0]}
        pointerEvents="none"
      >
        <div
          style={{
            whiteSpace: "nowrap", fontFamily: "var(--font-mono), monospace",
            fontSize: focused ? 12 : 13, lineHeight: 1.45,
            padding: focused ? "6px 12px" : "3px 10px",
            borderRadius: focused ? 8 : 999,
            border: `1px solid ${tint}`, color: tint,
            background: "rgba(18,16,12,0.86)", letterSpacing: "0.02em",
            textAlign: "center",
          }}
        >
          <div>
            {block.label}
            {block.active && (
              <span style={{ color: C.signal400, fontWeight: 600, marginRight: 6 }}>
                ● TRAINING NOW
              </span>
            )}
            {score !== null && !block.booting
              ? `  ${score >= 0 ? "+" : ""}${score.toFixed(2)}` : ""}
          </div>
          {focused && (
            <div style={{ color: C.chaff400, fontSize: 11, marginTop: 3 }}>
              {block.sandboxId ? `daytona ${block.sandboxId}` : "sandbox id pending"}
              {pct !== null ? ` · ${pct}%` : ""}
              {` · ${block.envs.length} envs`}
              {block.booting ? " · provisioning, no frames yet" : ""}
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

/* ── everything instanced across every room ───────────────────────────── */
function Contents({
  blocks, roomsWide, frame, onPick,
}: {
  blocks: FarmBlock[]; roomsWide: number; frame: number;
  onPick?: (runId: string, env: number) => void;
}) {
  const geo = useMemo(() => ({
    plot: new THREE.PlaneGeometry(1, 1),
    bed: new THREE.BoxGeometry(1, 1, 1),
    furrow: new THREE.BoxGeometry(1, 1, 1),
    patch: new THREE.CircleGeometry(1, 8),   // where a weed was pulled
    puff: new THREE.RingGeometry(0.55, 1, 12),  // the tool firing, visibly
    shade: new THREE.CircleGeometry(1, 10),     // fake contact shadow
    crop: new THREE.IcosahedronGeometry(1, 1),     // main canopy
    leaf: new THREE.IcosahedronGeometry(1, 0),     // offset foliage lobe
    berry: new THREE.SphereGeometry(1, 6, 5),      // fruit, so it reads strawberry
    weed: new THREE.ConeGeometry(1, 2.6, 5),       // main blade
    blade: new THREE.ConeGeometry(1, 2.2, 4),      // second blade, splayed
    // the rover reads as a machine at close range: chassis + sensor mast + tool arm
    chassis: new THREE.BoxGeometry(1, 0.42, 1.45),
    wheel: new THREE.CylinderGeometry(0.5, 0.5, 0.32, 12),
    mast: new THREE.CylinderGeometry(0.12, 0.16, 1, 8),
    head: new THREE.BoxGeometry(0.72, 0.34, 0.3),
    boom: new THREE.BoxGeometry(1, 0.14, 0.16),
    arm: new THREE.BoxGeometry(0.16, 0.5, 0.16),
  }), []);
  useEffect(() => () => { for (const g of Object.values(geo)) g.dispose(); }, [geo]);

  const plotRef = useRef<THREE.InstancedMesh>(null);
  const bedRef = useRef<THREE.InstancedMesh>(null);
  const cropRef = useRef<THREE.InstancedMesh>(null);
  const weedRef = useRef<THREE.InstancedMesh>(null);
  const leafRef = useRef<THREE.InstancedMesh>(null);
  const berryRef = useRef<THREE.InstancedMesh>(null);
  const bladeRef = useRef<THREE.InstancedMesh>(null);
  const patchRef = useRef<THREE.InstancedMesh>(null);
  const puffRef = useRef<THREE.InstancedMesh>(null);
  const shadeRef = useRef<THREE.InstancedMesh>(null);
  const chassisRef = useRef<THREE.InstancedMesh>(null);
  const wheelRef = useRef<THREE.InstancedMesh>(null);   // 4 per rover
  const mastRef = useRef<THREE.InstancedMesh>(null);
  const headRef = useRef<THREE.InstancedMesh>(null);
  const boomRef = useRef<THREE.InstancedMesh>(null);
  const armRef = useRef<THREE.InstancedMesh>(null);

  /** instanceId -> which field, so the plot click maps back to real ids */
  const plotIndex = useRef<{ runId: string; env: number }[]>([]);

  const m = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const qf = useMemo(() => new THREE.Quaternion(), []);
  const v = useMemo(() => new THREE.Vector3(), []);
  const s = useMemo(() => new THREE.Vector3(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const eul = useMemo(() => new THREE.Euler(), []);
  const flat = useMemo(() => new THREE.Euler(-Math.PI / 2, 0, 0), []);
  const act = useMemo(() => new THREE.Color(C.chaff200), []);

  // plots, beds and plants: only when the set of fields or their plants changes
  useEffect(() => {
    const plot = plotRef.current, bed = bedRef.current, patch = patchRef.current;
    const leaf = leafRef.current, berry = berryRef.current, blade = bladeRef.current;
    const crop = cropRef.current, weed = weedRef.current;
    if (!plot || !bed || !crop || !weed || !patch || !leaf || !berry || !blade) return;
    let pi = 0, bi = 0, ci = 0, wi = 0, pa = 0, li = 0, be = 0, bl = 0;
    const nowMs = performance.now();
    const index: { runId: string; env: number }[] = [];

    blocks.forEach((b, bIdx) => {
      b.envs.forEach((env) => {
        if (pi >= MAX_PLOTS) return;
        const o = plotOrigin(bIdx, env.env, roomsWide);

        // soil plate, tinted by this field's latest finished-episode score
        s.set(PLOT_W, PLOT_D, 1);
        q.setFromEuler(flat);
        v.set(o.x + PLOT_W / 2, 0.02, o.z + PLOT_D / 2);
        m.compose(v, q, s);
        plot.setMatrixAt(pi, m);
        // the score tint stays (it is the heat-map) but muted, so a plot reads
        // as soil with a status wash rather than a block of flat colour
        // Soil first, status second. The score tint is blended only 22% over a
        // base earth tone, otherwise every plot reads as a red rectangle and
        // you cannot see the crop rows, the weeds or the machine working.
        // Soil, with only a whisper of status. At 0.13 the red score tint made
        // every bed salmon and the farm had no readable ground.
        col.set("#2c2417").lerp(new THREE.Color(scoreColor(env.score)), b.pruned ? 0.03 : 0.07);
        plot.setColorAt(pi, col);
        index[pi] = { runId: b.runId, env: env.env };
        pi++;

        if (b.booting) return;   // empty plot until the first real frame lands

        // ── the field itself ──
        // Raised beds running the length of the plot, with a tilled crown and
        // a darker furrow either side, so a plot reads as worked ground rather
        // than a coloured rectangle. Rows come from the telemetry, not invented.
        const rows = [...new Set(
          env.plants.filter((p) => p.cls === 0).map((p) => Math.round(p.y * 100) / 100),
        )].sort((a, c) => a - c);

        for (let r = 0; r < Math.min(rows.length, 4); r++) {
          if (bi >= MAX_BEDS - 2) break;
          const ry = rows[r];
          // bed crown: raised, warm tilled soil
          s.set(PLOT_W * 0.97, 0.075, 0.13 * MZ * 2.3);
          q.identity();
          v.set(o.x + PLOT_W / 2, 0.042, o.z + ry * MZ);
          m.compose(v, q, s);
          bed.setMatrixAt(bi, m);
          col.set("#473c27");                     // tilled earth, lighter than the furrow
          bed.setColorAt(bi, col);
          bi++;

          // furrow: the wheel track the rover is supposed to stay in
          const next = rows[r + 1];
          if (next !== undefined && bi < MAX_BEDS) {
            const mid = (ry + next) / 2;
            s.set(PLOT_W * 0.97, 0.022, (next - ry) * MZ * 0.55);
            v.set(o.x + PLOT_W / 2, 0.028, o.z + mid * MZ);
            m.compose(v, q, s);
            bed.setMatrixAt(bi, m);
            col.set("#1d1810");                   // shadowed channel
            bed.setColorAt(bi, col);
            bi++;
          }
        }

        // headland strip along the near edge: where the machine turns around
        if (bi < MAX_BEDS) {
          s.set(PLOT_W * 0.99, 0.02, PLOT_D * 0.1);
          q.identity();
          v.set(o.x + PLOT_W / 2, 0.026, o.z + PLOT_D * 0.045);
          m.compose(v, q, s);
          bed.setMatrixAt(bi, m);
          col.set("#2a2418");
          bed.setColorAt(bi, col);
          bi++;
        }

        for (const p of env.plants) {
          const px = o.x + p.x * MX;
          const pz = o.z + p.y * MZ;

          // A pulled weed leaves disturbed soil where it stood — this is the
          // visible proof the robot did something, and it was missing entirely
          // because removal events never reached the browser.
          if (p.removed) {
            // A cut has to be WATCHABLE. Previously the plant silently vanished
            // and left a soil950 disc — black on black, invisible, which is why
            // 5,000+ real removal events looked like nothing was happening.
            // Now: a bright flare at the moment of the cut that decays into a
            // permanent pale disturbed-soil scar you can still count later.
            const age = p.removedAt ? (nowMs - p.removedAt) / 900 : 1;  // 0..1
            const fresh = age < 1 ? 1 - age : 0;

            if (pa < MAX_PATCHES) {
              // 5.5x made every scar bigger than a strawberry plant, and with
              // most weeds removed they merged into one cream sheet that hid
              // the field. A pulled weed leaves a patch about its own size.
              const base = Math.max(0.04, p.radius * MX * 1.2);
              const pr = base * (1 + fresh * 0.85);       // brief flare, settles
              s.set(pr, pr, 1);
              q.setFromEuler(flat);
              v.set(px, 0.05, pz);
              m.compose(v, q, s);
              patch.setMatrixAt(pa, m);
              // a wrongly-cut CROP scars red; a pulled weed leaves turned earth
              // turned earth, not paint: close to the bed tone so a scar reads
              // as a mark on soil rather than an object sitting on top of it
              col.set(p.cls === 0 ? "#6b2f24" : "#6d5a39");
              if (fresh > 0) col.lerp(new THREE.Color("#d8bd82"), fresh * 0.8);
              patch.setColorAt(pa, col);
              pa++;
            }

            // the severed top, thrown clear and fading — the actual "cut"
            if (fresh > 0 && bl < MAX_PLANTS) {
              const wr = Math.max(0.06, p.radius * MX * 3.4) * (1 - fresh * 0.3);
              s.set(wr, wr * (1.4 - fresh * 0.5), wr);
              eul.set(1.15 + fresh * 0.5, p.x * 31.7, 0.4);   // toppled over
              q.setFromEuler(eul);
              v.set(px + fresh * 0.14, wr * 0.5, pz + fresh * 0.1);
              m.compose(v, q, s);
              blade.setMatrixAt(bl, m);
              col.set(C.bloom400).lerp(new THREE.Color("#5c4a2e"), 1 - fresh);
              blade.setColorAt(bl, col);
              bl++;
            }
            continue;   // the standing plant is gone
          }

          if (p.cls === 0) {
            if (ci >= MAX_PLANTS) continue;
            // 1.9x is a visibility allowance, not a lie: a 0.10 m strawberry
            // canopy would be 2 px from the cluster shot. It was 3.2x, which
            // at the new plot scale made crops read bigger than the robot.
            const r = Math.max(0.07, p.radius * MX * 2.3);
            // deterministic per-plant jitter: real beds are not clones, but the
            // variation must be stable across frames or the field would shimmer
            const h = ((p.x * 7919 + p.y * 104729) % 1 + 1) % 1;
            const vary = 0.82 + h * 0.36;
            // damaged crops droop and redden, and stay visible as evidence
            s.set(r * vary, p.damaged ? r * 0.45 : r * 1.15 * vary, r * vary);
            eul.set(0, h * Math.PI * 2, 0);
            q.setFromEuler(eul);
            v.set(px, (p.damaged ? r * 0.4 : r * 0.95), pz);
            m.compose(v, q, s);
            crop.setMatrixAt(ci, m);
            if (p.damaged) {
              col.set("#7a4a33");   // wilted and browned, not a red marble
            } else {
              // hue and value jitter so a row reads as many plants, not one colour
              col.set(C.leaf400);
              col.offsetHSL((h - 0.5) * 0.045, (h - 0.5) * 0.12, (h - 0.5) * 0.14);
            }
            crop.setColorAt(ci, col);
            ci++;

          } else {
            if (wi >= MAX_PLANTS) continue;
            const r = Math.max(0.075, p.radius * MX * 4.0);
            const hw = ((p.x * 31337 + p.y * 6271) % 1 + 1) % 1;
            s.set(r * (0.85 + hw * 0.3), r * (1.5 + hw * 0.5), r * (0.85 + hw * 0.3));
            eul.set(0, hw * Math.PI * 2, 0);
            q.setFromEuler(eul);
            v.set(px, r * 1.25, pz);
            m.compose(v, q, s);
            weed.setMatrixAt(wi, m);
            col.set(C.bloom400);
            col.offsetHSL((hw - 0.5) * 0.05, 0, (hw - 0.5) * 0.16);
            weed.setColorAt(wi, col);
            wi++;

          }
        }
      });
    });

    plotIndex.current = index;
    plot.count = pi; bed.count = bi; crop.count = ci; weed.count = wi;
    patch.count = pa; leaf.count = li; berry.count = be; blade.count = bl;
    for (const mesh of [plot, bed, crop, weed, patch, leaf, berry, blade]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }, [blocks, roomsWide, m, q, v, s, col, flat]);

  // rovers: every frame, straight off the live pose stream.
  // Built as a real inter-row weeder rather than a blob: chassis on four
  // wheels, a camera mast with a sensor head (this robot sees with a web-
  // trained classifier, so the camera is the point), a tool boom spanning the
  // implement width, and a tine that drops when the tool fires.
  useFrame(() => {
    const chassis = chassisRef.current, wheel = wheelRef.current;
    const mast = mastRef.current, head = headRef.current;
    const boom = boomRef.current, arm = armRef.current, puff = puffRef.current;
    const shade = shadeRef.current;
    if (!chassis || !wheel || !mast || !head || !boom || !arm || !puff || !shade) return;
    let ri = 0;   // rover index
    let wi = 0;   // wheel index (4x rovers)
    let pf = 0;   // puffs: one per rover currently firing
    blocks.forEach((b, bIdx) => {
      if (b.booting) return;
      b.envs.forEach((env) => {
        if (ri >= MAX_ROVERS || env.pose.length === 0) return;
        const p = env.pose[frame % env.pose.length];
        const o = plotOrigin(bIdx, env.env, roomsWide);
        const x = o.x + p.x * MX;
        const z = o.z + p.y * MZ;
        // heading (cos θ, -sin θ) in (x, z); the chassis' long axis is local +z
        const yaw = p.theta + Math.PI / 2;
        const fx = Math.cos(p.theta), fz = -Math.sin(p.theta);   // forward
        const rx = Math.cos(p.theta - Math.PI / 2);              // right
        const rz = -Math.sin(p.theta - Math.PI / 2);
        const trained = env.policy !== "base";
        const base = trained ? C.signal400 : C.sky400;

        eul.set(0, yaw, 0);
        q.setFromEuler(eul);

        // contact shadow, so the machine sits ON the bed rather than above it
        s.set(0.52, 0.4, 1);
        qf.setFromEuler(flat);
        v.set(x, 0.035, z);
        m.compose(v, qf, s);
        shade.setMatrixAt(ri, m);
        col.set("#0b0905");
        shade.setColorAt(ri, col);

        // chassis, carried above the wheels
        s.set(0.55, 0.34, 0.95);
        v.set(x, 0.20, z);
        m.compose(v, q, s);
        chassis.setMatrixAt(ri, m);
        col.set(base);
        chassis.setColorAt(ri, col);

        // four wheels, axles across the direction of travel
        const wheelEul = new THREE.Euler(0, yaw, Math.PI / 2);
        const wq = new THREE.Quaternion().setFromEuler(wheelEul);
        for (const [along, across] of [[0.17, 0.16], [0.17, -0.16], [-0.17, 0.16], [-0.17, -0.16]] as const) {
          if (wi >= MAX_ROVERS * 4) break;
          s.set(0.23, 0.13, 0.23);
          v.set(x + fx * along + rx * across, 0.115, z + fz * along + rz * across);
          m.compose(v, wq, s);
          wheel.setMatrixAt(wi, m);
          col.set(C.soil700).multiplyScalar(1.5);
          wheel.setColorAt(wi, col);
          wi++;
        }

        // camera mast + sensor head: this robot sees, and that should show
        s.set(0.2, 0.46, 0.2);
        v.set(x - fx * 0.13, 0.34, z - fz * 0.13);
        m.compose(v, q, s);
        mast.setMatrixAt(ri, m);
        col.set(base).multiplyScalar(0.72);
        mast.setColorAt(ri, col);

        s.set(0.32, 0.3, 0.3);
        v.set(x - fx * 0.13, 0.47, z - fz * 0.13);
        m.compose(v, q, s);
        head.setMatrixAt(ri, m);
        col.set(C.chaff200).multiplyScalar(p.act ? 1.0 : 0.72);
        head.setColorAt(ri, col);

        // tool boom across the implement width, slung ahead of the chassis
        s.set(0.85, 0.5, 0.5);
        v.set(x + fx * 0.22, 0.17, z + fz * 0.22);
        m.compose(v, q, s);
        boom.setMatrixAt(ri, m);
        col.set(base).multiplyScalar(0.85);
        boom.setColorAt(ri, col);

        // a ground burst where the tool bites, so a cut is unmistakable even
        // from the cluster shot — without it, firing was a 1-pixel colour change
        if (p.act && pf < MAX_ROVERS) {
          const pulse = 0.09 + 0.05 * Math.abs(Math.sin(frame * 0.5));
          s.set(pulse, pulse, 1);
          q.setFromEuler(flat);
          v.set(x + fx * 0.3, 0.055, z + fz * 0.3);
          m.compose(v, q, s);
          puff.setMatrixAt(pf, m);
          col.copy(act);
          puff.setColorAt(pf, col);
          pf++;
        }

        // the tine: drops and brightens on the step the tool fires
        s.set(0.1, p.act ? 0.42 : 0.26, 0.1);
        v.set(x + fx * 0.28, p.act ? 0.06 : 0.12, z + fz * 0.28);
        m.compose(v, q, s);
        arm.setMatrixAt(ri, m);
        if (p.act) col.copy(act); else col.set(base).multiplyScalar(0.9);
        arm.setColorAt(ri, col);

        ri++;
      });
    });
    chassis.count = ri; mast.count = ri; head.count = ri; boom.count = ri; arm.count = ri;
    wheel.count = wi; puff.count = pf; shade.count = ri;
    for (const mesh of [chassis, wheel, mast, head, boom, arm, puff, shade]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  });

  return (
    <>
      <instancedMesh
        ref={plotRef}
        args={[geo.plot, undefined, MAX_PLOTS]}
        frustumCulled={false}
        onClick={(e) => {
          if (!onPick) return;
          const id = e.instanceId ?? -1;
          const hit = plotIndex.current[id];
          if (!hit) return;
          e.stopPropagation();
          onPick(hit.runId, hit.env);
        }}
      >
        <meshBasicMaterial toneMapped={false} transparent opacity={0.9} />
      </instancedMesh>
      <instancedMesh ref={bedRef} args={[geo.bed, undefined, MAX_BEDS]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.95} metalness={0} />
      </instancedMesh>
      <instancedMesh ref={cropRef} args={[geo.crop, undefined, MAX_PLANTS]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.72} metalness={0.02} flatShading />
      </instancedMesh>
      <instancedMesh ref={weedRef} args={[geo.weed, undefined, MAX_PLANTS]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.68} metalness={0.02} flatShading />
      </instancedMesh>
      <instancedMesh ref={leafRef} args={[geo.leaf, undefined, MAX_PLANTS]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.74} metalness={0.02} flatShading />
      </instancedMesh>
      <instancedMesh ref={berryRef} args={[geo.berry, undefined, MAX_PLANTS]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.45} metalness={0.05} />
      </instancedMesh>
      <instancedMesh ref={bladeRef} args={[geo.blade, undefined, MAX_PLANTS]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.68} metalness={0.02} flatShading />
      </instancedMesh>
      <instancedMesh ref={patchRef} args={[geo.patch, undefined, MAX_PATCHES]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} transparent opacity={0.9} />
      </instancedMesh>
      <instancedMesh ref={shadeRef} args={[geo.shade, undefined, MAX_ROVERS]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} transparent opacity={0.42} />
      </instancedMesh>
      <instancedMesh ref={puffRef} args={[geo.puff, undefined, MAX_ROVERS]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} transparent opacity={0.85} side={THREE.DoubleSide} />
      </instancedMesh>
      <instancedMesh ref={chassisRef} args={[geo.chassis, undefined, MAX_ROVERS]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.42} metalness={0.45} />
      </instancedMesh>
      <instancedMesh ref={wheelRef} args={[geo.wheel, undefined, MAX_ROVERS * 4]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.85} metalness={0.05} />
      </instancedMesh>
      <instancedMesh ref={headRef} args={[geo.head, undefined, MAX_ROVERS]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.42} metalness={0.45} />
      </instancedMesh>
      <instancedMesh ref={boomRef} args={[geo.boom, undefined, MAX_ROVERS]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.42} metalness={0.45} />
      </instancedMesh>
      <instancedMesh ref={mastRef} args={[geo.mast, undefined, MAX_ROVERS]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.42} metalness={0.45} />
      </instancedMesh>
      <instancedMesh ref={armRef} args={[geo.arm, undefined, MAX_ROVERS]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.42} metalness={0.45} />
      </instancedMesh>
    </>
  );
}

/* ── camera: cluster fit, click-to-focus fly, free fly ────────────────── */
type Shot = { pos: THREE.Vector3; target: THREE.Vector3 };

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function CameraRig({
  nBlocks, roomsWide, focusIndex, focusEnv, pickTick, onExit,
}: {
  nBlocks: number; roomsWide: number;
  focusIndex: number; focusEnv: number | null;
  /** bumped on every pick so re-clicking the same room re-flies */
  pickTick: number;
  onExit?: () => void;
}) {
  const camera = useThree((st) => st.camera);
  const size = useThree((st) => st.size);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);

  const keys = useRef<Record<string, boolean>>({});
  const interacted = useRef(false);
  const tween = useRef<{ from: Shot; to: Shot; t0: number; dur: number } | null>(null);
  const t0 = useRef(0);   // set on mount; drives only the idle orbit phase

  const aspect = Math.max(0.35, size.width / Math.max(1, size.height));
  const fov = (camera as THREE.PerspectiveCamera).fov ?? 55;

  /** Distance at which a sphere of `radius` fits both screen axes. */
  const fitDistance = (radius: number) => {
    const vFov = (fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    return Math.max(radius / Math.tan(vFov / 2), radius / Math.tan(hFov / 2)) * 1.12;
  };

  /** Pull back far enough to see the whole cluster, in either mode. */
  const clusterShot = (): Shot => {
    const ext = clusterExtent(nBlocks || 1, roomsWide);
    const cx = ext.w / 2, cz = ext.d / 2;
    const dist = fitDistance(Math.hypot(ext.w, ext.d + ROOM_H) / 2);
    return {
      pos: new THREE.Vector3(cx, dist * 0.62, cz + dist * 0.8),
      target: new THREE.Vector3(cx, 0, cz),
    };
  };

  /** Third-person shot that frames one sandbox's room. */
  const roomShot = (index: number, env: number | null): Shot => {
    const o = roomOrigin(index, roomsWide);
    const cx = o.x + ROOM_W / 2, cz = o.z + ROOM_D / 2;
    const dist = fitDistance(Math.hypot(ROOM_W, ROOM_D) / 2);
    const target = new THREE.Vector3(cx, 1.2, cz);
    if (env !== null) {
      // bias toward the clicked field without losing the room from the frame
      const p = plotOrigin(index, env, roomsWide);
      target.x += (p.x + PLOT_W / 2 - cx) * 0.35;
      target.z += (p.z + PLOT_D / 2 - cz) * 0.35;
    }
    return {
      pos: new THREE.Vector3(target.x, dist * 0.55, target.z + dist * 0.8),
      target,
    };
  };

  const fly = (to: Shot, instant: boolean) => {
    const c = controls.current;
    if (!c) return;
    if (instant) {
      camera.position.copy(to.pos);
      c.target.copy(to.target);
      c.update();
      tween.current = null;
      return;
    }
    tween.current = {
      from: { pos: camera.position.clone(), target: c.target.clone() },
      to,
      t0: performance.now(),
      dur: 600,
    };
  };

  /** Frame whatever is current: the focused room, else the whole cluster. */
  const refit = (instant: boolean) =>
    fly(focusIndex >= 0 ? roomShot(focusIndex, focusEnv) : clusterShot(), instant);

  // first framing
  const initialised = useRef(false);
  useEffect(() => {
    t0.current = performance.now();
    refit(true);
    initialised.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // mode switch reflows the cluster (4 wide -> 2 wide), so always reframe
  useEffect(() => {
    if (initialised.current) refit(prefersReducedMotion());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsWide]);

  // resize or a new sandbox joining: reframe, but never yank a viewer who is
  // flying the space themselves
  useEffect(() => {
    if (!initialised.current) return;
    if (focusIndex >= 0 || !interacted.current) refit(prefersReducedMotion());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect, nBlocks]);

  // click-to-focus, and Esc / "back" returning to the cluster overview
  useEffect(() => {
    if (!initialised.current) return;
    if (focusIndex >= 0) {
      interacted.current = true;
      fly(roomShot(focusIndex, focusEnv), prefersReducedMotion());
    } else {
      fly(clusterShot(), prefersReducedMotion());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIndex, focusEnv, pickTick]);

  // keyboard: WASD/QE fly, Shift boost, Esc back out.
  // the handler reads these through refs so the listener is bound once
  const exitRef = useRef(onExit);
  const focusRef = useRef(focusIndex);
  const clusterRef = useRef(clusterShot);
  useEffect(() => {
    exitRef.current = onExit;
    focusRef.current = focusIndex;
    clusterRef.current = clusterShot;
  });

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      keys.current[k] = true;
      if (FLY_KEYS.includes(k)) {
        interacted.current = true;
        tween.current = null;
      }
      if (e.key === "Escape") {
        tween.current = null;
        interacted.current = true;
        // the owner clears its selection, which flies us back via the effect above
        if (focusRef.current >= 0 && exitRef.current) exitRef.current();
        else fly(clusterRef.current(), prefersReducedMotion());
      }
    };
    const up = (e: KeyboardEvent) => { keys.current[e.key.toLowerCase()] = false; };
    const blur = () => { keys.current = {}; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fwd = useMemo(() => new THREE.Vector3(), []);
  const right = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const step = useMemo(() => new THREE.Vector3(), []);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;

    // 1. the focus tween overrides everything else while it runs
    const tw = tween.current;
    if (tw) {
      const k = ease(Math.min(1, (performance.now() - tw.t0) / tw.dur));
      camera.position.copy(tw.from.pos).lerp(tw.to.pos, k);
      c.target.copy(tw.from.target).lerp(tw.to.target, k);
      if (k >= 1) tween.current = null;
      c.update();
      return;
    }

    // 2. free fly — camera and orbit target move together
    const k = keys.current;
    const speed = 26 * delta * (k["shift"] ? 3.2 : 1);
    step.set(0, 0, 0);
    camera.getWorldDirection(fwd);
    right.crossVectors(fwd, up).normalize();
    if (k["w"]) step.addScaledVector(fwd, speed);
    if (k["s"]) step.addScaledVector(fwd, -speed);
    if (k["a"]) step.addScaledVector(right, -speed);
    if (k["d"]) step.addScaledVector(right, speed);
    if (k["e"]) step.addScaledVector(up, speed);
    if (k["q"]) step.addScaledVector(up, -speed);
    if (step.lengthSq() > 0) {
      // never fly through the floor
      const floorGap = 0.6 - (camera.position.y + step.y);
      if (floorGap > 0) step.setY(step.y + floorGap);
      camera.position.add(step);
      c.target.add(step);
      c.update();
      return;
    }

    // 3. idle orbit, only before the viewer takes over and only with motion allowed
    if (!interacted.current && focusIndex < 0 && !prefersReducedMotion()) {
      const ext = clusterExtent(nBlocks || 1, roomsWide);
      const cx = ext.w / 2, cz = ext.d / 2;
      const dist = fitDistance(Math.hypot(ext.w, ext.d + ROOM_H) / 2);
      const a = Math.sin((performance.now() - t0.current) / 1000 * 0.06) * 0.3;
      tmp.set(cx + Math.sin(a) * dist * 0.8, dist * 0.62, cz + Math.cos(a) * dist * 0.8);
      camera.position.lerp(tmp, Math.min(1, delta * 2));
      c.target.set(cx, 0, cz);
    }
    c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping dampingFactor={0.08}
      enablePan
      minDistance={1.2}
      maxDistance={600}
      maxPolarAngle={Math.PI * 0.495}
      onStart={() => { interacted.current = true; tween.current = null; }}
    />
  );
}

export function FarmScene({
  blocks, mode = "farm", frame, onPick, onPickBlock, focus, onExit,
}: {
  blocks: FarmBlock[]; mode?: FarmMode; frame: number;
  onPick?: (runId: string, env: number) => void;
  onPickBlock?: (runId: string) => void;
  /** pass to drive the camera from outside; omit and the scene tracks its own */
  focus?: FarmFocus;
  onExit?: () => void;
}) {
  // uncontrolled fallback, so a caller that only wants the side panel (or
  // nothing at all) still gets click-to-focus
  const [selfFocus, setSelfFocus] = useState<FarmFocus>(null);
  // every click re-flies, even back to a room that is already selected
  const [pickTick, setPickTick] = useState(0);
  const controlled = focus !== undefined;
  const active = controlled ? focus : selfFocus;

  const roomsWide = mode === "test" ? 2 : 4;
  const ext = clusterExtent(blocks.length || 1, roomsWide);
  const focusIndex = active ? blocks.findIndex((b) => b.runId === active.runId) : -1;
  const focusEnv = active?.env ?? null;
  const span = Math.max(ext.w, ext.d);

  const pickField = (runId: string, env: number) => {
    if (!controlled) setSelfFocus({ runId, env });
    setPickTick((n) => n + 1);
    onPick?.(runId, env);
  };
  const pickRoom = (b: FarmBlock) => {
    if (!controlled) setSelfFocus({ runId: b.runId, env: null });
    setPickTick((n) => n + 1);
    if (onPickBlock) onPickBlock(b.runId);
    else if (onPick) onPick(b.runId, b.envs[0]?.env ?? 0);
  };
  const exit = () => {
    if (!controlled) setSelfFocus(null);
    onExit?.();
  };

  return (
    <Canvas
      camera={{ fov: 55, near: 0.1, far: 4000, position: [ext.w / 2, span, ext.d * 1.6] }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      style={{ background: C.soil950 }}
    >
      {/* depth cue only: the fog starts beyond the overview distance so the far
          rooms stay readable */}
      <fog attach="fog" args={["#140f08", span * 2.4, span * 7.5]} />
      <ambientLight intensity={0.52} color={"#d8cfae"} />
      {/* low warm key light: long shadows across the beds, like late-day sun */}
      <directionalLight position={[span * 0.5, span * 0.55, span * 0.4]} intensity={1.05} color={"#ffe3b0"} />
      {/* cool sky fill from the opposite side so the far rooms do not go black */}
      <directionalLight position={[-span * 0.4, span * 0.6, -span * 0.3]} intensity={0.3} color={"#8fb6d6"} />
      <hemisphereLight args={["#9fb6cf", "#2b2316", 0.35]} />

      {/* ── the surrounding landscape ──
          The cluster used to float in a void, which made the whole thing read
          as a diagram instead of a place. This is the farm the beds sit in:
          a wide tilled ground plane, a darker soil apron under the rooms, and
          a horizon band so there is something to fly toward. */}
      <mesh position={[ext.w / 2, -0.12, ext.d / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[span * 14, span * 14]} />
        <meshLambertMaterial color={"#171308"} />
      </mesh>
      {/* tilled apron: a slightly lifted, warmer field the rooms stand on */}
      <mesh position={[ext.w / 2, -0.07, ext.d / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[ext.w + span * 0.9, ext.d + span * 0.9]} />
        <meshLambertMaterial color={C.soil900} />
      </mesh>
      {/* distant field strips, purely scenery, far outside the working area */}
      {[-1, 1].map((sgn) => (
        <mesh
          key={sgn}
          position={[ext.w / 2, -0.09, ext.d / 2 + sgn * (ext.d * 0.5 + span * 1.9)]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[span * 9, span * 2.4]} />
          <meshLambertMaterial color={"#1f2414"} />
        </mesh>
      ))}
      {/* horizon band so flying outward has a destination, not a black wall */}
      <mesh position={[ext.w / 2, span * 0.55, ext.d / 2 - span * 5.2]}>
        <planeGeometry args={[span * 16, span * 2.2]} />
        <meshBasicMaterial color={"#241f14"} />
      </mesh>
      <gridHelper
        args={[Math.max(ext.w, ext.d) * 3, 60, C.soil700, C.soil800]}
        position={[ext.w / 2, -0.02, ext.d / 2]}
      />

      {blocks.map((b, i) => (
        <RoomShell
          key={b.runId || i}
          index={i}
          roomsWide={roomsWide}
          block={b}
          focused={i === focusIndex}
          onPick={() => pickRoom(b)}
        />
      ))}

      <Contents blocks={blocks} roomsWide={roomsWide} frame={frame} onPick={pickField} />

      <CameraRig
        nBlocks={blocks.length}
        roomsWide={roomsWide}
        focusIndex={focusIndex}
        focusEnv={focusEnv}
        pickTick={pickTick}
        onExit={exit}
      />
    </Canvas>
  );
}
