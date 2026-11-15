"use client";
/**
 * HARVESTED — kept only as a compatibility shim.
 *
 * The Box Room shell, the free-fly rig and the instanced room contents that
 * used to live here now live in `FarmScene.tsx`, which renders the cluster
 * overview and the Box Room close-up from one Canvas (one InstancedMesh per
 * kind across the whole scene). Import `FarmScene` directly; this wrapper just
 * forwards to it so nothing that still references `SandboxRooms` breaks.
 */
import { FarmScene, type FarmBlock, type FarmFocus, type FarmMode } from "./FarmScene";

export type RoomBlock = FarmBlock;
export type RoomMode = FarmMode;

export function SandboxRooms({
  blocks, mode = "farm", frame, onPickRoom, focus = null, onExit,
}: {
  blocks: RoomBlock[]; mode?: RoomMode; frame: number;
  onPickRoom?: (runId: string) => void;
  focus?: FarmFocus;
  onExit?: () => void;
}) {
  return (
    <FarmScene
      blocks={blocks}
      mode={mode}
      frame={frame}
      focus={focus}
      onPickBlock={onPickRoom}
      onPick={(runId) => onPickRoom?.(runId)}
      onExit={onExit}
    />
  );
}
