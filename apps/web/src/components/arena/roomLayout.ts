/**
 * Box-Room geometry (DESIGN.md §4.1, reworked).
 *
 * One room per Daytona sandbox, laid out 4 x 2 on a floor. Inside each room its
 * 32 training envs sit as field plots, 4 across x 8 deep. Everything is in
 * scene units; the sim's metres are scaled per plot.
 */
// Scaled up ~1.9x from the first pass: at the old size a field was a smear of
// green and the rover was a speck. These numbers let a single bed read as an
// actual farm plot when you fly down to it, while 8 rooms still frame together.
export const PLOT_W = 15.0;            // one env's field, long axis (the bed run)
export const PLOT_D = 5.6;            // across the rows
export const PLOT_GAP_X = 2.0;        // headland between beds
export const PLOT_GAP_Z = 1.9;

export const PLOTS_X = 4;             // 4 x 8 = 32 envs per sandbox
export const PLOTS_Z = 8;

export const ROOM_PAD = 4.5;          // floor margin inside the walls
export const ROOM_W = PLOTS_X * (PLOT_W + PLOT_GAP_X) - PLOT_GAP_X + ROOM_PAD * 2;
export const ROOM_D = PLOTS_Z * (PLOT_D + PLOT_GAP_Z) - PLOT_GAP_Z + ROOM_PAD * 2;
export const ROOM_H = 14.0;            // wall height

export const ROOM_GAP_X = 9.0;       // space to float between rooms
export const ROOM_GAP_Z = 10.0;
export const ROOMS_WIDE = 4;

/** metres -> scene units, per plot */
export const MX = PLOT_W / 12;        // field length 12 m
export const MZ = PLOT_D / 0.9;       // bed width ~0.9 m

export function roomOrigin(block: number, roomsWide = ROOMS_WIDE) {
  const bx = block % roomsWide;
  const bz = Math.floor(block / roomsWide);
  return {
    x: bx * (ROOM_W + ROOM_GAP_X),
    z: bz * (ROOM_D + ROOM_GAP_Z),
  };
}

/** Plot origin (its near-left corner) inside a room. */
export function plotOrigin(block: number, env: number, roomsWide = ROOMS_WIDE) {
  const { x, z } = roomOrigin(block, roomsWide);
  const ex = env % PLOTS_X;
  const ez = Math.floor(env / PLOTS_X);
  return {
    x: x + ROOM_PAD + ex * (PLOT_W + PLOT_GAP_X),
    z: z + ROOM_PAD + ez * (PLOT_D + PLOT_GAP_Z),
  };
}

export function clusterExtent(rooms: number, roomsWide = ROOMS_WIDE) {
  const cols = Math.min(Math.max(1, rooms), roomsWide);
  const rows = Math.ceil(Math.max(1, rooms) / roomsWide);
  return {
    w: cols * (ROOM_W + ROOM_GAP_X) - ROOM_GAP_X,
    d: rows * (ROOM_D + ROOM_GAP_Z) - ROOM_GAP_Z,
  };
}

export function roomCenter(block: number, roomsWide = ROOMS_WIDE) {
  const o = roomOrigin(block, roomsWide);
  return { x: o.x + ROOM_W / 2, y: ROOM_H / 2, z: o.z + ROOM_D / 2 };
}
