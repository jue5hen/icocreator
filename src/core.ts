export type Rect = { x: number; y: number; w: number; h: number };
export type Corner = "nw" | "ne" | "se" | "sw";

export const GUIDE_FRACTIONS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
export const ICO_MAX = 256;
export const MIN_CROP_SIZE = 2;
/** 画布上的误触阈值（CSS 屏幕像素）；源图像素尺寸另由 MIN_CROP_SIZE 约束。 */
export const DRAG_THRESHOLD_PX = 2;

export const RATIOS: { label: string; key: string; value: number | null }[] = [
  { label: "自由", key: "free", value: null },
  { label: "1:1", key: "1:1", value: 1 },
  { label: "4:3", key: "4:3", value: 4 / 3 },
  { label: "3:4", key: "3:4", value: 3 / 4 },
  { label: "16:9", key: "16:9", value: 16 / 9 },
  { label: "9:16", key: "9:16", value: 9 / 16 },
];

export function clampRect(rect: Rect, maxW: number, maxH: number, minSize = 1): Rect {
  maxW = Math.max(1, Math.round(maxW));
  maxH = Math.max(1, Math.round(maxH));
  const minW = Math.min(Math.max(1, minSize), maxW);
  const minH = Math.min(Math.max(1, minSize), maxH);
  const w = Math.min(Math.max(minW, rect.w), maxW);
  const h = Math.min(Math.max(minH, rect.h), maxH);
  const x = Math.min(Math.max(0, rect.x), maxW - w);
  const y = Math.min(Math.max(0, rect.y), maxH - h);
  return { x, y, w, h };
}

export function moveRect(rect: Rect, dx: number, dy: number, maxW: number, maxH: number): Rect {
  return clampRect({ x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h }, maxW, maxH);
}

export type RotateOp = "cw" | "ccw" | "flip_h" | "flip_v";

/** 把原图上的一块选区随图片旋转/镜像同步变换；maxW/maxH 是变换前原图尺寸。 */
export function rotateCrop(rect: Rect, op: RotateOp, maxW: number, maxH: number): Rect {
  const W = Math.max(1, Math.round(maxW));
  const H = Math.max(1, Math.round(maxH));
  switch (op) {
    case "cw":
      return { x: H - rect.y - rect.h, y: rect.x, w: rect.h, h: rect.w };
    case "ccw":
      return { x: rect.y, y: W - rect.x - rect.w, w: rect.h, h: rect.w };
    case "flip_h":
      return { x: W - rect.x - rect.w, y: rect.y, w: rect.w, h: rect.h };
    case "flip_v":
      return { x: rect.x, y: H - rect.y - rect.h, w: rect.w, h: rect.h };
  }
}

/**
 * 在给定可用空间内求一个比例尽量准确的整数尺寸。
 * 锁定比例时不能分别夹取宽高，否则贴边后会跳变并破坏比例。
 */
function fitAspectSize(
  requestedW: number,
  requestedH: number,
  ratio: number,
  maxW: number,
  maxH: number,
): { w: number; h: number } {
  const W = Math.max(1, Math.floor(maxW));
  const H = Math.max(1, Math.floor(maxH));
  const r = Math.max(1e-9, ratio);
  const reqW = Math.max(1, requestedW);
  const reqH = Math.max(1, requestedH);
  // 取更远的那个拖拽分量，保证纯横向/纯纵向拖拽都不会塌缩。
  const targetW = Math.max(reqW, reqH * r);
  const targetH = targetW / r;
  const scale = Math.min(1, W / targetW, H / targetH);
  let h = Math.max(1, Math.round(targetH * scale));
  const hLimit = Math.max(1, Math.min(H, Math.floor((W + 0.5) / r)));
  h = Math.min(h, hLimit);
  let w = Math.max(1, Math.round(h * r));
  if (w > W) {
    w = W;
    h = Math.max(1, Math.round(w / r));
  }
  if (h > H) {
    h = H;
    w = Math.max(1, Math.round(h * r));
  }
  // 极端比例在 1～2 像素空间内无法同时表达，保守留在画布内。
  if (w > W) w = W;
  if (h > H) h = H;
  return { w, h };
}

function inferDirection(delta: number, anchor: number, max: number): 1 | -1 {
  if (delta < 0) return -1;
  if (delta > 0) return 1;
  // 纯横/纯竖拖拽时，零位移轴没有符号；选择可用空间更大的一侧。
  return anchor > max / 2 ? -1 : 1;
}

/**
 * 从拖拽输入推导锁定比例尺寸。
 * 单轴位移必须只使用该轴的目标边，否则另一轴的旧宽/旧高会把方向键收缩
 * 误判成原尺寸；双轴位移才按主导分量统一缩放。
 */
function fitAspectFromDrag(
  rawW: number,
  rawH: number,
  ratio: number,
  maxW: number,
  maxH: number,
  hasX: boolean,
  hasY: boolean,
): { w: number; h: number } {
  if (hasX && !hasY) {
    const targetW = Math.max(1, rawW);
    return fitAspectSize(targetW, targetW / ratio, ratio, maxW, maxH);
  }
  if (!hasX && hasY) {
    const targetH = Math.max(1, rawH);
    return fitAspectSize(targetH * ratio, targetH, ratio, maxW, maxH);
  }
  if (hasX && hasY) {
    // 用更远的归一化分量主导，避免两个独立旧边同时参与 max 造成漂移。
    if (rawW >= rawH * ratio) {
      return fitAspectSize(rawW, rawW / ratio, ratio, maxW, maxH);
    }
    return fitAspectSize(rawH * ratio, rawH, ratio, maxW, maxH);
  }
  return fitAspectSize(1, 1 / ratio, ratio, maxW, maxH);
}

/**
 * 从固定锚点朝拖拽点生成矩形。锁定比例时以有效拖拽方向推导尺寸，
 * dx 或 dy 为 0 时仍会生成合法矩形。
 */
export function anchorRectAspect(
  ax: number,
  ay: number,
  px: number,
  py: number,
  ratio: number | null,
  maxW: number,
  maxH: number,
): Rect {
  maxW = Math.max(1, Math.round(maxW));
  maxH = Math.max(1, Math.round(maxH));
  ax = Math.min(Math.max(0, ax), maxW);
  ay = Math.min(Math.max(0, ay), maxH);
  px = Math.min(Math.max(0, px), maxW);
  py = Math.min(Math.max(0, py), maxH);
  const dx = px - ax;
  const dy = py - ay;
  const sx = inferDirection(dx, ax, maxW);
  const sy = inferDirection(dy, ay, maxH);
  const rawW = Math.abs(dx);
  const rawH = Math.abs(dy);
  const availW = sx > 0 ? maxW - ax : ax;
  const availH = sy > 0 ? maxH - ay : ay;

  let w: number;
  let h: number;
  if (ratio && ratio > 0) {
    ({ w, h } = fitAspectFromDrag(
      rawW,
      rawH,
      ratio,
      availW,
      availH,
      dx !== 0,
      dy !== 0,
    ));
  } else {
    w = Math.min(Math.max(1, Math.round(rawW)), Math.max(1, availW));
    h = Math.min(Math.max(1, Math.round(rawH)), Math.max(1, availH));
  }
  const x = sx > 0 ? ax : ax - w;
  const y = sy > 0 ? ay : ay - h;
  return clampRect({ x, y, w, h }, maxW, maxH);
}

export function rectToRatio(rect: Rect, ratio: number, maxW: number, maxH: number): Rect {
  const W = Math.max(1, Math.round(maxW));
  const H = Math.max(1, Math.round(maxH));
  const boxW = Math.min(W, Math.max(1, Math.round(rect.w)));
  const boxH = Math.min(H, Math.max(1, Math.round(rect.h)));
  const short = Math.min(boxW, boxH);
  const desiredW = ratio >= 1 ? short * ratio : short;
  const desiredH = ratio >= 1 ? short : short / ratio;
  const { w, h } = fitAspectSize(desiredW, desiredH, ratio, boxW, boxH);
  const x = rect.x + Math.floor((rect.w - w) / 2);
  const y = rect.y + Math.floor((rect.h - h) / 2);
  return clampRect({ x, y, w, h }, W, H);
}

/**
 * 角点方向键微调：dx/dy 解释为“被移动角点”的坐标位移。
 * 对角锚点固定；锁定比例时宽高必须由同一个缩放约束得出。
 */
export function nudgeRect(
  rect: Rect,
  corner: Corner,
  dx: number,
  dy: number,
  ratio: number | null,
  maxW: number,
  maxH: number,
): Rect {
  const W = Math.max(1, Math.round(maxW));
  const H = Math.max(1, Math.round(maxH));
  const left = corner === "nw" || corner === "sw";
  const top = corner === "nw" || corner === "ne";
  const sx: 1 | -1 = left ? -1 : 1;
  const sy: 1 | -1 = top ? -1 : 1;
  const ax = left ? rect.x + rect.w : rect.x;
  const ay = top ? rect.y + rect.h : rect.y;
  const targetX = (left ? rect.x : rect.x + rect.w) + dx;
  const targetY = (top ? rect.y : rect.y + rect.h) + dy;
  const rawW = Math.abs(targetX - ax);
  const rawH = Math.abs(targetY - ay);
  const availW = sx > 0 ? W - ax : ax;
  const availH = sy > 0 ? H - ay : ay;

  let w: number;
  let h: number;
  if (ratio && ratio > 0) {
    ({ w, h } = fitAspectFromDrag(
      rawW,
      rawH,
      ratio,
      availW,
      availH,
      dx !== 0,
      dy !== 0,
    ));
  } else {
    w = Math.min(Math.max(1, Math.round(rawW)), Math.max(1, availW));
    h = Math.min(Math.max(1, Math.round(rawH)), Math.max(1, availH));
  }
  const x = left ? ax - w : ax;
  const y = top ? ay - h : ay;
  return clampRect({ x, y, w, h }, W, H);
}

export function guideLines(length: number): number[] {
  length = Math.max(1, Math.round(length));
  const set = new Set<number>();
  for (const f of GUIDE_FRACTIONS) {
    set.add(Math.max(0, Math.min(length, Math.round(length * f))));
  }
  return [...set].sort((a, b) => a - b);
}

export function snapRectToGuides(
  rect: Rect,
  guidesX: number[],
  guidesY: number[],
  tol: number,
  maxW: number,
  maxH: number,
): [Rect, number[], number[]] {
  const snapAxis = (
    lo: number,
    size: number,
    guides: number[],
    length: number,
  ): [number, number[]] => {
    let best: [number, number] | null = null;
    for (const g of guides) {
      for (const [edge, delta] of [
        [lo, 0],
        [lo + size, size],
        [lo + Math.floor(size / 2), Math.floor(size / 2)],
      ]) {
        const d = Math.abs(edge - g);
        if (d <= tol && (best === null || d < best[0])) {
          best = [d, g - delta];
        }
      }
    }
    if (!best) return [lo, []];
    const lo2 = Math.max(0, Math.min(Math.round(best[1]), Math.max(0, length - size)));
    const hits = guides.filter(
      (g) =>
        Math.abs(lo2 - g) <= tol ||
        Math.abs(lo2 + size - g) <= tol ||
        Math.abs(lo2 + Math.floor(size / 2) - g) <= tol,
    );
    return [lo2, hits];
  };
  const W = Math.max(1, Math.round(maxW));
  const H = Math.max(1, Math.round(maxH));
  const [x, hx] = snapAxis(rect.x, rect.w, guidesX.map(Math.round), W);
  const [y, hy] = snapAxis(rect.y, rect.h, guidesY.map(Math.round), H);
  return [{ x, y, w: rect.w, h: rect.h }, hx, hy];
}

export function humanSize(n: number): string {
  n = Math.max(0, Math.trunc(n));
  if (n < 1024) return `${n} B`;
  let v = n;
  for (const unit of ["KB", "MB", "GB"]) {
    v /= 1024;
    if (v < 1024) return `${v.toFixed(1)} ${unit}`;
  }
  return `${(v / 1024).toFixed(1)} TB`;
}