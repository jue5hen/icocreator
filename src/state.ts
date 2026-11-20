import { RATIOS, rotateCrop, type Rect, type RotateOp } from "./core";
import type { Settings, SquareMode } from "./types";

export type RatioState = {
  key: string;
  value: number | null;
  custom: [number, number];
};

export type EditCheckpoint = {
  ratio: RatioState;
  crop: Rect | null;
};

export type AppliedSettingsState = {
  icoSizes: number[];
  squareMode: SquareMode;
  ratio: RatioState;
  guides: boolean;
};

export type RatioParseResult =
  | { ok: true; value: [number, number] }
  | { ok: false; message: string };

/** 只接受真正可以应用的正整数比例，不把输入草稿带进设置快照。 */
export function parseCustomRatio(rawW: string, rawH: string): RatioParseResult {
  const wText = rawW.trim();
  const hText = rawH.trim();
  if (!/^\d+$/.test(wText) || !/^\d+$/.test(hText)) {
    return { ok: false, message: "自定义比例请填正整数，例如宽 16、高 9" };
  }
  const w = Number(wText);
  const h = Number(hText);
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0 || w > 100000 || h > 100000) {
    return { ok: false, message: "自定义比例需为 1–100000 的整数" };
  }
  return { ok: true, value: [w, h] };
}

/** 旋转 90° 时比例取倒数；镜像不改比例。 */
export function invertRatioState(state: RatioState, op: RotateOp): RatioState {
  if (op === "flip_h" || op === "flip_v" || state.value === null) {
    return { ...state, custom: [...state.custom] as [number, number] };
  }
  const inverse = 1 / state.value;
  if (state.key === "custom") {
    return { key: "custom", value: inverse, custom: [state.custom[1], state.custom[0]] };
  }
  const preset = RATIOS.find(
    (item) => item.value !== null && Math.abs(item.value - inverse) < 1e-9,
  );
  if (preset) {
    return { key: preset.key, value: preset.value, custom: [...state.custom] as [number, number] };
  }
  return {
    key: "custom",
    value: inverse,
    custom: [state.custom[1], state.custom[0]],
  };
}

export function rotateCheckpoint(
  checkpoint: EditCheckpoint,
  op: RotateOp,
  width: number,
  height: number,
): EditCheckpoint {
  return {
    ratio: invertRatioState(checkpoint.ratio, op),
    crop: checkpoint.crop ? rotateCrop(checkpoint.crop, op, width, height) : null,
  };
}

/** 仅把已应用状态写入设置；输入框草稿永远不参与持久化。 */
export function mergeAppliedSettings(
  base: Settings,
  applied: AppliedSettingsState,
  over: Partial<Settings> = {},
): Settings {
  return {
    ...base,
    icoSizes: [...applied.icoSizes],
    squareMode: applied.squareMode,
    ratio: applied.ratio.key,
    customRatio: [...applied.ratio.custom] as [number, number],
    guides: applied.guides,
    ...over,
  };
}

/** 让前端撤销语义栈与后端真实撤销深度保持同步。 */
export function pushEditCheckpoint(
  stack: EditCheckpoint[],
  checkpoint: EditCheckpoint,
  undoDepth: number,
  limit = 10,
): EditCheckpoint[] {
  const next = [...stack, checkpoint];
  while (next.length > Math.max(0, Math.min(limit, undoDepth))) next.shift();
  return next;
}

export function popEditCheckpoint(
  stack: EditCheckpoint[],
  undoDepthAfter: number,
  limit = 10,
): { stack: EditCheckpoint[]; checkpoint: EditCheckpoint | null } {
  const next = [...stack];
  const checkpoint = next.pop() ?? null;
  while (next.length > Math.max(0, Math.min(limit, undoDepthAfter))) next.shift();
  return { stack: next, checkpoint };
}