/** Farm geometry (DESIGN.md §4.1): blocks of 32 fields, one block per sandbox. */
export const FIELD_LEN_M = 12;
export const FIELD_WID_M = 0.9;

/** metres → scene units */
export const SX = 0.2;
export const SY = 0.62;

export const TILE_W = FIELD_LEN_M * SX;        // 2.4
export const TILE_H = FIELD_WID_M * SY;        // ~0.56
export const GUTTER_X = 0.30;
export const GUTTER_Y = 0.34;

export const BLOCK_COLS = 4;                   // fields across a block
export const BLOCK_ROWS = 8;                   // 4 x 8 = 32 envs per sandbox
export const BLOCK_W = BLOCK_COLS * (TILE_W + GUTTER_X);
export const BLOCK_H = BLOCK_ROWS * (TILE_H + GUTTER_Y);
export const BLOCK_GAP_X = TILE_W * 0.5;
export const BLOCK_GAP_Y = TILE_H * 1.5;

export type TilePos = { x: number; z: number };

/** Where tile (block b, env e) sits, with `blocksWide` blocks per row. */
export function tilePos(b: number, e: number, blocksWide = 4): TilePos {
  const bx = b % blocksWide;
  const bz = Math.floor(b / blocksWide);
  const ex = e % BLOCK_COLS;
  const ez = Math.floor(e / BLOCK_COLS);
  return {
    x: bx * (BLOCK_W + BLOCK_GAP_X) + ex * (TILE_W + GUTTER_X),
    z: bz * (BLOCK_H + BLOCK_GAP_Y) + ez * (TILE_H + GUTTER_Y),
  };
}

export function farmExtent(nBlocks: number, blocksWide = 4) {
  const rows = Math.ceil(nBlocks / blocksWide);
  const cols = Math.min(nBlocks, blocksWide);
  return {
    w: cols * (BLOCK_W + BLOCK_GAP_X) - BLOCK_GAP_X,
    h: rows * (BLOCK_H + BLOCK_GAP_Y) - BLOCK_GAP_Y,
  };
}

/** Field-local metres → scene offset within a tile. */
export function toTileLocal(xm: number, ym: number) {
  return { dx: xm * SX, dz: ym * SY };
}
