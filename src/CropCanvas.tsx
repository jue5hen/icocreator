import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import type { Corner, Rect } from "./core";
import {
  DRAG_THRESHOLD_PX,
  MIN_CROP_SIZE,
  anchorRectAspect,
  guideLines,
  moveRect,
  snapRectToGuides,
} from "./core";

type Src = { width: number; height: number } | null;

type Props = {
  source: Src;
  previewUrl: string;
  crop: Rect | null;
  ratio: number | null;
  guides: boolean;
  selectedCorner: Corner | null;
  dropActive: boolean;
  disabled: boolean;
  onCropChange: (rect: Rect | null) => void;
  onSelectCorner: (corner: Corner | null) => void;
  onStatus: (text: string) => void;
  onEmptyClick: () => void;
};

export type CropCanvasHandle = { resetZoom: () => boolean };

type Drag =
  | { mode: "pan"; startX: number; startY: number; panX: number; panY: number }
  | {
      mode: "new";
      startX: number;
      startY: number;
      anchorX: number;
      anchorY: number;
      moved: boolean;
      previousCrop: Rect | null;
      crop: Rect | null;
    }
  | {
      mode: "move";
      startX: number;
      startY: number;
      startCrop: Rect;
      moved: boolean;
      crop: Rect | null;
    }
  | {
      mode: "corner";
      zone: Corner;
      anchorX: number;
      anchorY: number;
      startX: number;
      startY: number;
      moved: boolean;
      crop: Rect | null;
    };

const DIM = "rgba(10, 11, 16, 0.44)";

/** 画布颜色一律从 design-tokens.css 读取，跟随系统深浅色，不在 TS 里写死十六进制。 */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const CropCanvas = forwardRef<CropCanvasHandle, Props>(function CropCanvas(props, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const viewRef = useRef({ w: 0, h: 0 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<Drag | null>(null);
  const snapHitsRef = useRef<[number[], number[]]>([[], []]);
  const checkerRef = useRef<HTMLCanvasElement | null>(null);
  const patternRef = useRef<CanvasPattern | null>(null);
  const checkerKeyRef = useRef("");
  const guideCacheRef = useRef<{ w: number; h: number; x: number[]; y: number[] } | null>(null);
  const frameRef = useRef<number | null>(null);

  const mapping = useCallback(() => {
    const src = propsRef.current.source;
    const { w, h } = viewRef.current;
    if (!src || w < 4 || h < 4) return null;
    const fit = Math.min(w / src.width, h / src.height, 1);
    const scale = fit * zoomRef.current;
    const dw = src.width * scale;
    const dh = src.height * scale;
    const maxPanX = Math.max(0, (dw - w) / 2);
    const maxPanY = Math.max(0, (dh - h) / 2);
    panRef.current.x = Math.min(Math.max(panRef.current.x, -maxPanX), maxPanX);
    panRef.current.y = Math.min(Math.max(panRef.current.y, -maxPanY), maxPanY);
    return {
      scale,
      offX: (w - dw) / 2 + panRef.current.x,
      offY: (h - dh) / 2 + panRef.current.y,
      dw,
      dh,
      w,
      h,
      srcW: src.width,
      srcH: src.height,
    };
  }, []);

  const liveCrop = () => {
    const d = dragRef.current;
    if (d && d.mode !== "pan") return d.crop;
    return propsRef.current.crop;
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = viewRef.current;
    if (w < 4 || h < 4) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const accent = cssVar("--color-accent", "#4f5fe7");
    const accentSoft = cssVar("--color-accent-soft", "#eceeff");
    const surface = cssVar("--color-bg-surface", "#ffffff");
    const checkerA = cssVar("--color-bg-subtle", "#eef0f4");
    const checkerB = cssVar("--color-surface-pressed", "#e4e8ef");

    ctx.fillStyle = propsRef.current.dropActive ? accentSoft : surface;
    ctx.fillRect(0, 0, w, h);

    const m = mapping();
    const img = imgRef.current;
    if (!m || !img) return;

    const ix0 = Math.max(0, m.offX);
    const iy0 = Math.max(0, m.offY);
    const ix1 = Math.min(w, m.offX + m.dw);
    const iy1 = Math.min(h, m.offY + m.dh);
    if (ix1 <= ix0 || iy1 <= iy0) return;

    const checkerKey = `${checkerA}|${checkerB}`;
    let board = checkerRef.current;
    if (!board || checkerKeyRef.current !== checkerKey) {
      board = document.createElement("canvas");
      board.width = 16;
      board.height = 16;
      const bctx = board.getContext("2d");
      if (bctx) {
        bctx.fillStyle = checkerA;
        bctx.fillRect(0, 0, 16, 16);
        bctx.fillStyle = checkerB;
        bctx.fillRect(8, 0, 8, 8);
        bctx.fillRect(0, 8, 8, 8);
      }
      checkerRef.current = board;
      checkerKeyRef.current = checkerKey;
      patternRef.current = null;
    }
    if (!patternRef.current) {
      patternRef.current = ctx.createPattern(board, "repeat");
    }
    const pat = patternRef.current;
    if (pat) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(ix0, iy0, ix1 - ix0, iy1 - iy0);
      ctx.clip();
      ctx.fillStyle = pat;
      ctx.fillRect(ix0, iy0, ix1 - ix0, iy1 - iy0);
      ctx.restore();
    }

    ctx.save();
    ctx.imageSmoothingEnabled = m.scale < 3;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, m.offX, m.offY, m.dw, m.dh);
    ctx.restore();

    const crop = liveCrop();
    if (!crop) return;
    const x1 = Math.round(m.offX + crop.x * m.scale);
    const y1 = Math.round(m.offY + crop.y * m.scale);
    const x2 = Math.round(m.offX + (crop.x + crop.w) * m.scale);
    const y2 = Math.round(m.offY + (crop.y + crop.h) * m.scale);

    const cx1 = Math.min(Math.max(x1, 0), w);
    const cy1 = Math.min(Math.max(y1, 0), h);
    const cx2 = Math.min(Math.max(x2, 0), w);
    const cy2 = Math.min(Math.max(y2, 0), h);
    ctx.fillStyle = DIM;
    if (cy1 > 0) ctx.fillRect(0, 0, w, cy1);
    if (cy2 < h) ctx.fillRect(0, cy2, w, h);
    if (cx1 > 0 && cy2 > cy1) ctx.fillRect(0, cy1, cx1, cy2 - cy1);
    if (cx2 < w && cy2 > cy1) ctx.fillRect(cx2, cy1, w - cx2, cy2 - cy1);

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(x1 + 1, y1 + 1, Math.max(0, x2 - x1 - 2), Math.max(0, y2 - y1 - 2));

    const dragging = dragRef.current !== null;
    if (propsRef.current.guides && (dragging || propsRef.current.selectedCorner)) {
      const gxStart = Math.max(0, m.offX);
      const gyStart = Math.max(0, m.offY);
      const gxEnd = Math.min(w, m.offX + m.dw);
      const gyEnd = Math.min(h, m.offY + m.dh);
      const [hitsX, hitsY] = snapHitsRef.current;
      const source = propsRef.current.source;
      let guideCache = guideCacheRef.current;
      if (!guideCache || guideCache.w !== (source?.width ?? 1) || guideCache.h !== (source?.height ?? 1)) {
        guideCache = {
          w: source?.width ?? 1,
          h: source?.height ?? 1,
          x: guideLines(source?.width ?? 1),
          y: guideLines(source?.height ?? 1),
        };
        guideCacheRef.current = guideCache;
      }
      for (const g of guideCache.x) {
        const lx = Math.round(m.offX + g * m.scale);
        if (lx < gxStart || lx > gxEnd) continue;
        const strong = hitsX.includes(g);
        ctx.strokeStyle = strong ? accent : withAlpha(accent, 0.31);
        ctx.lineWidth = strong ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(lx, gyStart);
        ctx.lineTo(lx, gyEnd);
        ctx.stroke();
      }
      for (const g of guideCache.y) {
        const ly = Math.round(m.offY + g * m.scale);
        if (ly < gyStart || ly > gyEnd) continue;
        const strong = hitsY.includes(g);
        ctx.strokeStyle = strong ? accent : withAlpha(accent, 0.31);
        ctx.lineWidth = strong ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(gxStart, ly);
        ctx.lineTo(gxEnd, ly);
        ctx.stroke();
      }
    }

    const corners: [Corner, number, number][] = [
      ["nw", x1, y1],
      ["ne", x2, y1],
      ["se", x2, y2],
      ["sw", x1, y2],
    ];
    for (const [zone, hx, hy] of corners) {
      if (zone === propsRef.current.selectedCorner) {
        const r = 11;
        ctx.fillStyle = accent;
        ctx.fillRect(hx - r, hy - r, r * 2, r * 2);
        ctx.strokeStyle = surface;
        ctx.lineWidth = 2;
        ctx.strokeRect(hx - r, hy - r, r * 2, r * 2);
      } else {
        const hs = 9;
        ctx.fillStyle = surface;
        ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(hx - hs + 0.5, hy - hs + 0.5, hs * 2 - 1, hs * 2 - 1);
      }
    }

    const label = `${crop.w} × ${crop.h}`;
    ctx.font = '13px "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
    const tw = ctx.measureText(label).width;
    const th = 16;
    const pad = 6;
    let lx = Math.min(x2 - tw - pad * 2, x1);
    let ly = y2 + 6;
    if (ly + th + pad > h) ly = y1 - th - pad * 2;
    ly = Math.max(0, ly);
    lx = Math.max(0, Math.min(lx, w - tw - pad * 2));
    ctx.fillStyle = "rgba(15,16,22,0.84)";
    ctx.beginPath();
    ctx.roundRect(lx, ly, tw + pad * 2, th + pad, 6);
    ctx.fill();
    ctx.fillStyle = "#ebedf7";
    ctx.textBaseline = "top";
    ctx.fillText(label, lx + pad, ly + 3);
  }, [mapping]);

  const scheduleDraw = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const update = () => {
      const r = wrap.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      viewRef.current = { w: Math.floor(r.width), h: Math.floor(r.height) };
      mapping();
      scheduleDraw();
    };
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    update();
    return () => ro.disconnect();
  }, [mapping, scheduleDraw]);

  useEffect(() => {
    if (!props.previewUrl) {
      imgRef.current = null;
      scheduleDraw();
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      scheduleDraw();
    };
    img.onerror = () => {
      if (cancelled) return;
      imgRef.current = null;
      propsRef.current.onStatus("预览加载失败，请重新打开或重试上一步");
      scheduleDraw();
    };
    img.src = props.previewUrl;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [props.previewUrl, scheduleDraw]);

  useEffect(() => {
    scheduleDraw();
  }, [props.crop, props.selectedCorner, props.guides, props.dropActive, props.previewUrl, scheduleDraw]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => scheduleDraw();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [scheduleDraw]);

  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const localPoint = useCallback((e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const hitZone = (mx: number, my: number): Corner | "in" | null => {
    const m = mapping();
    const crop = propsRef.current.crop;
    if (!m || !crop) return null;
    const x1 = m.offX + crop.x * m.scale;
    const y1 = m.offY + crop.y * m.scale;
    const x2 = m.offX + (crop.x + crop.w) * m.scale;
    const y2 = m.offY + (crop.y + crop.h) * m.scale;
    let tol = 10;
    tol = Math.min(tol, Math.max(4, Math.floor(Math.min(x2 - x1, y2 - y1) / 3)));
    if (tol * 2 >= Math.min(x2 - x1, y2 - y1)) tol = -1;
    const corners: [Corner, number, number][] = [
      ["nw", x1, y1],
      ["ne", x2, y1],
      ["se", x2, y2],
      ["sw", x1, y2],
    ];
    for (const [zone, hx, hy] of corners) {
      if (tol >= 0 && Math.abs(mx - hx) <= tol && Math.abs(my - hy) <= tol) return zone;
    }
    if (mx >= x1 - 2 && mx <= x2 + 2 && my >= y1 - 2 && my <= y2 + 2) return "in";
    return null;
  };

  const origFrom = (mx: number, my: number): [number, number] => {
    const m = mapping();
    if (!m) return [0, 0];
    const x = Math.round((mx - m.offX) / m.scale);
    const y = Math.round((my - m.offY) / m.scale);
    return [
      Math.min(Math.max(0, x), m.srcW),
      Math.min(Math.max(0, y), m.srcH),
    ];
  };

  const setCursor = (cursor: string) => {
    if (canvasRef.current) canvasRef.current.style.cursor = cursor;
  };

  const endDrag = () => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onWindowMove);
    window.removeEventListener("pointerup", onWindowUp);
  };

  const onWindowMove = (e: PointerEvent) => {
    if (propsRef.current.disabled) {
      endDrag();
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    const p = localPoint(e);
    if (d.mode === "pan") {
      panRef.current = {
        x: d.panX + (p.x - d.startX),
        y: d.panY + (p.y - d.startY),
      };
      mapping();
      scheduleDraw();
      return;
    }
    const m = mapping();
    const src = propsRef.current.source;
    if (!m || !src) return;
    const [ox, oy] = origFrom(p.x, p.y);
    if (Math.hypot(p.x - d.startX, p.y - d.startY) >= DRAG_THRESHOLD_PX) d.moved = true;
    let next: Rect | null = null;
    if (d.mode === "move") {
      const dx = Math.round((p.x - d.startX) / m.scale);
      const dy = Math.round((p.y - d.startY) / m.scale);
      next = moveRect(d.startCrop, dx, dy, src.width, src.height);
    } else if (d.mode === "corner") {
      next = anchorRectAspect(
        d.anchorX,
        d.anchorY,
        ox,
        oy,
        propsRef.current.ratio,
        src.width,
        src.height,
      );
    } else if (d.moved) {
      next = anchorRectAspect(
        d.anchorX,
        d.anchorY,
        ox,
        oy,
        propsRef.current.ratio,
        src.width,
        src.height,
      );
    } else {
      next = d.crop;
    }
    if (next && d.moved && propsRef.current.guides) {
      const tol = Math.max(4, 6 / m.scale);
      const [snapped, hx, hy] = snapRectToGuides(
        next,
        guideLines(src.width),
        guideLines(src.height),
        tol,
        src.width,
        src.height,
      );
      next = snapped;
      snapHitsRef.current = [hx, hy];
    } else {
      snapHitsRef.current = [[], []];
    }
    d.crop = next;
    if (next) {
      propsRef.current.onCropChange(next);
      propsRef.current.onStatus(
        `选区  X ${next.x} · Y ${next.y} · ${next.w} × ${next.h}`,
      );
    }
    scheduleDraw();
  };

  const onWindowUp = () => {
    const d = dragRef.current;
    if (!d) {
      endDrag();
      return;
    }
    if (d.mode === "pan") {
      endDrag();
      setCursor("default");
      return;
    }
    const crop = d.crop ?? propsRef.current.crop;
    dragRef.current = null;
    if (d.mode === "corner" && !d.moved) {
      propsRef.current.onSelectCorner(d.zone);
      propsRef.current.onStatus(
        "已选中角点 · 按方向键微调（每次 1 像素）· 点别处或 Esc 取消",
      );
    } else {
      propsRef.current.onSelectCorner(null);
    }
    if (d.mode === "new") {
      if (!d.moved) {
        propsRef.current.onCropChange(d.previousCrop);
      } else if (!crop || crop.w < MIN_CROP_SIZE || crop.h < MIN_CROP_SIZE) {
        propsRef.current.onCropChange(null);
      } else {
        propsRef.current.onCropChange(crop);
      }
    } else if (crop) {
      propsRef.current.onCropChange(crop);
    }
    snapHitsRef.current = [[], []];
    endDrag();
    setCursor("default");
    scheduleDraw();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (propsRef.current.disabled) return;
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      const p = localPoint(e);
      dragRef.current = {
        mode: "pan",
        startX: p.x,
        startY: p.y,
        panX: panRef.current.x,
        panY: panRef.current.y,
      };
      setCursor("grab");
      window.addEventListener("pointermove", onWindowMove);
      window.addEventListener("pointerup", onWindowUp);
      return;
    }
    if (e.button !== 0) return;
    if (!propsRef.current.source) {
      propsRef.current.onEmptyClick();
      return;
    }
    const p = localPoint(e);
    const zone = hitZone(p.x, p.y);
    const [ox, oy] = origFrom(p.x, p.y);
    const crop = propsRef.current.crop;
    e.preventDefault();
    if (zone && zone !== "in" && crop) {
      const anchor: Record<Corner, [number, number]> = {
        nw: [crop.x + crop.w, crop.y + crop.h],
        ne: [crop.x, crop.y + crop.h],
        se: [crop.x, crop.y],
        sw: [crop.x + crop.w, crop.y],
      };
      dragRef.current = {
        mode: "corner",
        zone,
        anchorX: anchor[zone][0],
        anchorY: anchor[zone][1],
        startX: p.x,
        startY: p.y,
        moved: false,
        crop,
      };
    } else if (zone === "in" && crop) {
      propsRef.current.onSelectCorner(null);
      dragRef.current = {
        mode: "move",
        startX: p.x,
        startY: p.y,
        startCrop: crop,
        moved: false,
        crop,
      };
    } else {
      propsRef.current.onSelectCorner(null);
      dragRef.current = {
        mode: "new",
        startX: p.x,
        startY: p.y,
        anchorX: ox,
        anchorY: oy,
        moved: false,
        previousCrop: crop,
        crop,
      };
    }
    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("pointerup", onWindowUp);
  };

  const onHover = (e: React.PointerEvent) => {
    if (propsRef.current.disabled || dragRef.current) return;
    if (!propsRef.current.source) {
      setCursor("default");
      return;
    }
    const p = localPoint(e);
    const zone = hitZone(p.x, p.y);
    const cursors: Record<string, string> = {
      nw: "nwse-resize",
      se: "nwse-resize",
      ne: "nesw-resize",
      sw: "nesw-resize",
      in: "move",
    };
    setCursor(zone ? cursors[zone] : "default");
  };

  const onWheel = useCallback((e: WheelEvent) => {
    if (propsRef.current.disabled) return;
    e.preventDefault();
    if (dragRef.current) return;
    const m = mapping();
    if (!m) return;
    const p = localPoint(e);
    const px = (p.x - m.offX) / m.scale;
    const py = (p.y - m.offY) / m.scale;
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    const nextZoom = Math.min(Math.max(zoomRef.current * factor, 1), 8);
    if (nextZoom === zoomRef.current) return;
    zoomRef.current = nextZoom;
    const m2 = mapping()!;
    panRef.current = {
      x: p.x - px * m2.scale - (m2.w - m2.srcW * m2.scale) / 2,
      y: p.y - py * m2.scale - (m2.h - m2.srcH * m2.scale) / 2,
    };
    mapping();
    scheduleDraw();
    propsRef.current.onStatus(
      `缩放 ${Math.round(zoomRef.current * 100)}%（滚轮缩放 · Ctrl+0 复位 · 中键或 Alt+左键拖动平移）`,
    );
  }, [localPoint, mapping, scheduleDraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  useImperativeHandle(ref, () => ({
    resetZoom: () => {
      if (zoomRef.current === 1 && panRef.current.x === 0 && panRef.current.y === 0) {
        return false;
      }
      zoomRef.current = 1;
      panRef.current = { x: 0, y: 0 };
      mapping();
      scheduleDraw();
      propsRef.current.onStatus("缩放已复位（适合窗口）");
      return true;
    },
  }));

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="crop-canvas"
        aria-label="图片预览与框选区域：拖拽框选，角点方向键微调，滚轮缩放"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onHover}
        onPointerLeave={() => {
          if (!dragRef.current) setCursor("default");
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
});
