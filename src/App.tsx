import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { join, pictureDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { CropCanvas, type CropCanvasHandle } from "./CropCanvas";
import { api } from "./api";
import {
  ICO_SIZES,
  MIN_CROP_SIZE,
  RATIOS,
  humanSize,
  nudgeRect,
  rectToRatio,
  rotateCrop,
  type Corner,
  type Rect,
} from "./core";
import {
  mergeAppliedSettings,
  parseCustomRatio,
  popEditCheckpoint,
  pushEditCheckpoint,
  invertRatioState,
  type EditCheckpoint,
  type RatioState,
} from "./state";
import type {
  BatchProgress,
  BatchResult,
  ImageState,
  Settings,
  SquareMode,
  ToastState,
} from "./types";

const APP_VERSION = "1.0.0";
const DEFAULT_SIZES = [256, 128, 64, 48, 32, 16];
type ActiveTask =
  | "load"
  | "rotate"
  | "crop"
  | "undo"
  | "paste"
  | "copy"
  | "save"
  | "export"
  | "batch";
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "bmp", "webp", "gif", "tif", "tiff", "ico"];
const IMAGE_FORMAT_LABEL = "PNG · JPG · BMP · WebP · GIF · TIFF · ICO";
const SQUARE_HINTS: Record<SquareMode, string> = {
  pad: "不变形：图片不满正方形的地方补透明（推荐）",
  center: "只取图片正中间最大的正方形，其余裁掉",
  stretch: "强行拉成正方形，画面会变形",
};
const SQUARE_LABELS: [string, SquareMode][] = [
  ["补透明边", "pad"],
  ["居中裁方", "center"],
  ["拉伸成方", "stretch"],
];
const OPEN_FILTERS = [
  { name: "图片", extensions: IMAGE_EXTENSIONS },
  { name: "PNG", extensions: ["png"] },
  { name: "JPEG", extensions: ["jpg", "jpeg"] },
  { name: "TIFF", extensions: ["tif", "tiff"] },
  { name: "ICO 图标", extensions: ["ico"] },
  { name: "所有文件（按内容识别）", extensions: ["*"] },
];

type DiscardPrompt = {
  title: string;
  message: string;
  confirmLabel: string;
  resolve: (confirmed: boolean) => void;
};

const defaultSettings: Settings = {
  lastOpenDir: "",
  lastSaveDir: "",
  lastBatchDir: "",
  icoSizes: DEFAULT_SIZES,
  squareMode: "pad",
  ratio: "free",
  customRatio: [16, 9],
  guides: true,
};

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}
function dirName(p: string): string {
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.join("\\");
}
function formatSizes(values: number[]): string {
  return values.length ? values.join(", ") : "无";
}

export default function App() {
  const [image, setImage] = useState<ImageState | null>(null);
  const [sizes, setSizes] = useState<Set<number>>(new Set(DEFAULT_SIZES));
  const [squareMode, setSquareMode] = useState<SquareMode>("pad");
  const [ratioKey, setRatioKey] = useState("free");
  const [ratio, setRatio] = useState<number | null>(null);
  const [customW, setCustomW] = useState("16");
  const [customH, setCustomH] = useState("9");
  const [guides, setGuides] = useState(true);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [selectedCorner, setSelectedCorner] = useState<Corner | null>(null);
  const [status, setStatusDisplay] = useState("就绪");
  const [task, setTask] = useState<ActiveTask | null>(null);
  const [batchInfo, setBatchInfo] = useState<{ i: number; total: number } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [discardPrompt, setDiscardPrompt] = useState<DiscardPrompt | null>(null);
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [batchReport, setBatchReport] = useState<BatchResult | null>(null);

  const settingsRef = useRef<Settings>(defaultSettings);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const squareModeRef = useRef(squareMode);
  squareModeRef.current = squareMode;
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  const ratioKeyRef = useRef(ratioKey);
  ratioKeyRef.current = ratioKey;
  const appliedCustomRef = useRef<[number, number]>([16, 9]);
  const guidesRef = useRef(guides);
  guidesRef.current = guides;
  const cropRef = useRef<Rect | null>(null);
  cropRef.current = crop;
  const cornerRef = useRef<Corner | null>(null);
  cornerRef.current = selectedCorner;
  const imageRef = useRef<ImageState | null>(null);
  imageRef.current = image;
  const uiUndoRef = useRef<EditCheckpoint[]>([]);
  const taskRef = useRef<ActiveTask | null>(null);
  const closePendingRef = useRef(false);
  const closeBusyRef = useRef(false);
  const closeDialogBusyRef = useRef(false);
  const closePromptRef = useRef(false);
  const batchReportRef = useRef<BatchResult | null>(null);
  batchReportRef.current = batchReport;
  const batchCancelRequestedRef = useRef(false);
  const lastStatusRef = useRef("就绪");
  const toastTimer = useRef<number | undefined>(undefined);
  const toastSeq = useRef(0);
  const lastDlgRef = useRef(0);
  const settingsTimer = useRef<number | undefined>(undefined);
  const settingsChain = useRef<Promise<void>>(Promise.resolve());
  const settingsFailureShown = useRef(false);
  const discardPromptRef = useRef<DiscardPrompt | null>(null);
  const canvasRef = useRef<CropCanvasHandle>(null);

  const busy = task !== null;

  const showToast = (text: string, ok = true, openPath?: string, ms = 3600) => {
    window.clearTimeout(toastTimer.current);
    setToast({ text, ok, openPath, ms, id: ++toastSeq.current });
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  };

  const setStatus = (text: string) => {
    lastStatusRef.current = text;
    setStatusDisplay(text);
  };

  const currentRatioState = (): RatioState => ({
    key: ratioKeyRef.current,
    value: ratioRef.current,
    custom: [...appliedCustomRef.current] as [number, number],
  });

  const captureCheckpoint = (): EditCheckpoint => ({
    ratio: currentRatioState(),
    crop: cropRef.current,
  });

  const resetEditHistory = () => {
    uiUndoRef.current = [];
  };

  const requestDiscard = (
    title: string,
    message: string,
    confirmLabel = "丢弃并继续",
  ): Promise<boolean> => {
    if (!imageRef.current?.edited) return Promise.resolve(true);
    if (discardPromptRef.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      const prompt: DiscardPrompt = { title, message, confirmLabel, resolve };
      discardPromptRef.current = prompt;
      setDiscardPrompt(prompt);
    });
  };

  const answerDiscard = (confirmed: boolean) => {
    const prompt = discardPromptRef.current;
    discardPromptRef.current = null;
    setDiscardPrompt(null);
    prompt?.resolve(confirmed);
  };

  const canReplaceImage = async () =>
    requestDiscard(
      "当前图片有未保存编辑",
      "继续打开、拖入或粘贴新图会丢弃当前编辑。取消后原图和撤销历史都会保留。",
    );

  const buildSettings = (over: Partial<Settings> = {}): Settings =>
    mergeAppliedSettings(
      settingsRef.current,
      {
        icoSizes: ICO_SIZES.filter((s) => sizesRef.current.has(s)),
        squareMode: squareModeRef.current,
        ratio: currentRatioState(),
        guides: guidesRef.current,
      },
      over,
    );

  const flushSettings = async (): Promise<boolean> => {
    window.clearTimeout(settingsTimer.current);
    const next = settingsRef.current;
    settingsChain.current = settingsChain.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await api.saveSettings(next);
          settingsFailureShown.current = false;
        } catch (e) {
          if (!settingsFailureShown.current) {
            settingsFailureShown.current = true;
            showToast(`设置未保存：${String(e)}`, false, undefined, 5200);
          }
          throw e;
        }
      });
    try {
      await settingsChain.current;
      return true;
    } catch {
      return false;
    }
  };

  const persist = (over: Partial<Settings> = {}) => {
    const next = buildSettings(over);
    settingsRef.current = next;
    window.clearTimeout(settingsTimer.current);
    settingsTimer.current = window.setTimeout(() => void flushSettings(), 180);
  };

  const finishTask = () => {
    taskRef.current = null;
    setTask(null);
    setBatchInfo(null);
    if (closePendingRef.current) {
      closePendingRef.current = false;
      window.setTimeout(() => void attemptCloseFlow(), 80);
    }
  };

  const beginTask = (kind: ActiveTask): boolean => {
    if (taskRef.current) {
      showToast("正在处理中，请等当前任务完成", false);
      return false;
    }
    taskRef.current = kind;
    setTask(kind);
    return true;
  };

  const resetViewState = () => {
    setCrop(null);
    setSelectedCorner(null);
  };

  const applyImageState = (st: ImageState) => {
    setImage(st);
    setStatus(
      st.isIco
        ? `已打开图标 ${st.name}（内嵌最大帧 ${st.width}×${st.height}）· 可编辑后另存`
        : `已打开 ${st.name}（${st.width}×${st.height}）· 在图上拖拽即可框选`,
    );
  };

  const loadPath = async (path: string) => {
    if (taskRef.current) return;
    if (!(await canReplaceImage())) return;
    if (!beginTask("load")) return;
    try {
      const st = await api.loadImage(path);
      resetViewState();
      resetEditHistory();
      applyImageState(st);
      const dir = dirName(path);
      if (dir) persist({ lastOpenDir: dir });
    } catch (e) {
      showToast(String(e), false);
    } finally {
      finishTask();
    }
  };

  const openImageDialog = async () => {
    if (taskRef.current) {
      showToast("正在处理中，请等当前任务完成再打开图片", false);
      return;
    }
    const now = Date.now();
    if (now - lastDlgRef.current < 800) return;
    lastDlgRef.current = now;
    let def = settingsRef.current.lastOpenDir;
    if (!def) {
      try {
        def = await pictureDir();
      } catch {
        def = "";
      }
    }
    const picked = await open({
      title: "选择图片",
      multiple: false,
      directory: false,
      defaultPath: def || undefined,
      filters: OPEN_FILTERS,
    });
    if (typeof picked === "string") await loadPath(picked);
  };

  const openRef = useRef(openImageDialog);
  openRef.current = openImageDialog;

  const dropFilesRef = useRef<(files: string[]) => void>(() => undefined);
  dropFilesRef.current = (files: string[]) => {
    if (!files.length) {
      showToast(`请拖入图片文件（${IMAGE_FORMAT_LABEL}）`, false);
      return;
    }
    if (files.length === 1) {
      void loadPath(files[0]);
      return;
    }
    showToast(`拖入了 ${files.length} 个文件，开始批量转换（同目录同名 .ico）`, true);
    void startBatch(files);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const st = await api.loadSettings();
        if (!alive) return;
        settingsRef.current = st;
        appliedCustomRef.current = [...st.customRatio] as [number, number];
        setSizes(new Set(st.icoSizes));
        setSquareMode(st.squareMode);
        setGuides(st.guides);
        setCustomW(String(st.customRatio[0]));
        setCustomH(String(st.customRatio[1]));
        if (st.ratio === "custom") {
          setRatioKey("custom");
          setRatio(st.customRatio[0] / st.customRatio[1]);
        } else {
          const found = RATIOS.find((r) => r.key === st.ratio);
          setRatioKey(found?.key ?? "free");
          setRatio(found?.value ?? null);
        }
        const init = await api.takeInitialPath();
        if (init && alive) void loadPath(init);
      } catch {
        // 设置读取失败时保持默认设置，不影响打开图片
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "over") {
          setDropActive(true);
          setStatusDisplay("松开鼠标即可载入图片");
        } else if (p.type === "leave") {
          setDropActive(false);
          setStatusDisplay(lastStatusRef.current);
        } else if (p.type === "drop") {
          setDropActive(false);
          setStatusDisplay(lastStatusRef.current);
          dropFilesRef.current(p.paths);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        // JS 关闭监听器存在时 Tauri 会先阻止原生关闭；最终必须由应用确认后 destroy。
        event.preventDefault();
        await attemptCloseFlow();
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => window.clearTimeout(settingsTimer.current), []);

  const nudge = (dx: number, dy: number) => {
    const img = imageRef.current;
    const c = cropRef.current;
    const corner = cornerRef.current;
    if (!img || !c || !corner) return;
    const next = nudgeRect(c, corner, dx, dy, ratioRef.current, img.width, img.height);
    setCrop(next);
    setStatus(`选区  X ${next.x} · Y ${next.y} · ${next.w} × ${next.h}`);
  };

  const rotate = async (op: "cw" | "ccw" | "flip_h" | "flip_v") => {
    const img = imageRef.current;
    if (!img) {
      showToast("请先打开一张图片", false);
      return;
    }
    const checkpoint = captureCheckpoint();
    const newCrop = checkpoint.crop ? rotateCrop(checkpoint.crop, op, img.width, img.height) : null;
    const nextRatio = invertRatioState(checkpoint.ratio, op);
    if (!beginTask("rotate")) return;
    try {
      const st = await api.rotate(op);
      setImage(st);
      setCrop(newCrop);
      setSelectedCorner(null);
      setRatioKey(nextRatio.key);
      setRatio(nextRatio.value);
      setCustomW(String(nextRatio.custom[0]));
      setCustomH(String(nextRatio.custom[1]));
      appliedCustomRef.current = nextRatio.custom;
      uiUndoRef.current = pushEditCheckpoint(uiUndoRef.current, checkpoint, st.undoDepth);
      if (op === "cw" || op === "ccw") {
        persist({ ratio: nextRatio.key, customRatio: nextRatio.custom });
      }
      const names = {
        cw: "已右转 90°",
        ccw: "已左转 90°",
        flip_h: "已水平镜像",
        flip_v: "已垂直镜像",
      };
      const historyNote = st.undoTruncated ? " · 撤销历史已按内存预算截断" : "";
      setStatus(`${names[op]}（${st.width}×${st.height}）· Ctrl+Z 可撤销${historyNote}`);
    } catch (e) {
      showToast(String(e), false);
    } finally {
      finishTask();
    }
  };

  const applyCrop = async () => {
    const img = imageRef.current;
    if (!img) {
      showToast("请先点中间空白处选择一张图片", false);
      return;
    }
    const c = cropRef.current;
    if (!c) {
      showToast("请先在图上拖拽框选，再点「裁切」", false);
      return;
    }
    if (c.w < MIN_CROP_SIZE || c.h < MIN_CROP_SIZE) {
      showToast(`选区太小了，至少 ${MIN_CROP_SIZE}×${MIN_CROP_SIZE} 像素`, false);
      return;
    }
    const checkpoint = captureCheckpoint();
    if (!beginTask("crop")) return;
    try {
      const st = await api.applyCrop(c.x, c.y, c.w, c.h);
      setImage(st);
      resetViewState();
      uiUndoRef.current = pushEditCheckpoint(uiUndoRef.current, checkpoint, st.undoDepth);
      const historyNote = st.undoTruncated ? " · 撤销历史已按内存预算截断" : "";
      setStatus(`已裁切为 ${st.width}×${st.height} · 按 Ctrl+Z 可撤销${historyNote}`);
    } catch (e) {
      showToast(String(e), false);
    } finally {
      finishTask();
    }
  };

  const undo = async () => {
    if (!beginTask("undo")) return;
    try {
      const st = await api.undo();
      const restored = popEditCheckpoint(uiUndoRef.current, st.undoDepth);
      uiUndoRef.current = restored.stack;
      setImage(st);
      if (restored.checkpoint) {
        setCrop(restored.checkpoint.crop);
        setSelectedCorner(null);
        setRatioKey(restored.checkpoint.ratio.key);
        setRatio(restored.checkpoint.ratio.value);
        setCustomW(String(restored.checkpoint.ratio.custom[0]));
        setCustomH(String(restored.checkpoint.ratio.custom[1]));
        appliedCustomRef.current = restored.checkpoint.ratio.custom;
        persist({
          ratio: restored.checkpoint.ratio.key,
          customRatio: restored.checkpoint.ratio.custom,
        });
      } else {
        resetViewState();
      }
      const dirtyNote = st.edited ? " · 仍有未保存编辑" : " · 已回到保存检查点";
      setStatus(`已撤销上一步，恢复为 ${st.width}×${st.height}${dirtyNote}`);
    } catch (e) {
      showToast(String(e), false);
    } finally {
      finishTask();
    }
  };

  const pasteClipboard = async () => {
    if (!(await canReplaceImage())) return;
    if (!beginTask("paste")) return;
    try {
      const st = await api.pasteClipboard();
      setImage(st);
      resetViewState();
      resetEditHistory();
      setStatus(`已粘贴剪贴板图片（${st.width}×${st.height}）· 尚未保存，关闭前会提示`);
    } catch (e) {
      showToast(String(e), false);
    } finally {
      finishTask();
    }
  };

  const copyIcon = async () => {
    if (!imageRef.current) {
      showToast("请先打开一张图片", false);
      return;
    }
    if (!beginTask("copy")) return;
    try {
      const [w, h] = await api.copyImage(squareModeRef.current);
      setStatus(`已复制 ${w}×${h} 图标图到剪贴板`);
    } catch (e) {
      showToast(String(e), false);
    } finally {
      finishTask();
    }
  };

  const defaultIcoName = (img: ImageState | null) => {
    if (!img) return "图标.ico";
    if (img.isIco && img.srcPath) {
      const stem = baseName(img.srcPath).replace(/\.[^.]+$/, "");
      return `${stem}-编辑.ico`;
    }
    if (img.srcPath) return baseName(img.srcPath).replace(/\.[^.]+$/, "") + ".ico";
    return "图标.ico";
  };

  const doSave = async (): Promise<boolean> => {
    if (taskRef.current) return false;
    const img = imageRef.current;
    if (!img) {
      showToast("请先打开一张图片", false);
      return false;
    }
    const selected = ICO_SIZES.filter((s) => sizesRef.current.has(s));
    if (!selected.length) {
      showToast("请先勾选至少一个尺寸", false);
      return false;
    }
    let dir = settingsRef.current.lastSaveDir;
    if (!dir && img.srcPath) dir = dirName(img.srcPath);
    const defPath = dir ? await join(dir, defaultIcoName(img)) : defaultIcoName(img);
    const picked = await save({
      title: "保存 ICO",
      defaultPath: defPath,
      filters: [{ name: "Windows 图标", extensions: ["ico"] }],
    });
    if (!picked) return false;
    const path = picked.toLowerCase().endsWith(".ico") ? picked : picked + ".ico";
    persist({ lastSaveDir: dirName(path) });
    if (!beginTask("save")) return false;
    try {
      const res = await api.saveIco(path, selected, squareModeRef.current);
      const savedCurrent = imageRef.current?.version === res.imageVersion && !res.edited;
      if (imageRef.current?.version === res.imageVersion) {
        setImage((prev) => (prev ? { ...prev, edited: res.edited } : prev));
      }
      const note = res.skipped.length
        ? `（源图短边 ${res.sourceSide}px，跳过 ${res.skipped.join(", ")}）`
        : "";
      showToast(
        `已保存 ${baseName(res.path)}：请求 ${res.requested.length} 档，实际 ${res.sizes.length} 档${note}`,
        true,
        res.path,
      );
      setStatus(`ICO 已保存：${res.path}${savedCurrent ? "" : " · 保存期间图片发生变化"}`);
      return savedCurrent;
    } catch (e) {
      showToast(String(e), false);
      return false;
    } finally {
      finishTask();
    }
  };

  const doExportPng = async (): Promise<boolean> => {
    if (taskRef.current) return false;
    const img = imageRef.current;
    if (!img) {
      showToast("请先打开一张图片", false);
      return false;
    }
    const selected = ICO_SIZES.filter((s) => sizesRef.current.has(s));
    if (!selected.length) {
      showToast("请先勾选至少一个尺寸", false);
      return false;
    }
    let dir = settingsRef.current.lastSaveDir;
    if (!dir && img.srcPath) dir = dirName(img.srcPath);
    const out = await open({
      title: "选择 PNG 导出文件夹",
      directory: true,
      multiple: false,
      defaultPath: dir || undefined,
    });
    if (typeof out !== "string") return false;
    persist({ lastSaveDir: out });
    if (!beginTask("export")) return false;
    try {
      const res = await api.exportPngs(out, selected, squareModeRef.current);
      const savedCurrent = imageRef.current?.version === res.imageVersion && !res.edited;
      if (imageRef.current?.version === res.imageVersion) {
        setImage((prev) => (prev ? { ...prev, edited: res.edited } : prev));
      }
      const folderName = baseName(res.folder);
      const note = res.skipped.length
        ? `；源图短边 ${res.sourceSide}px，跳过 ${res.skipped.join(", ")}`
        : "";
      showToast(`已导出 ${res.count} 张 PNG 到 ${folderName}\\${note}`, true, res.first);
      setStatus(`PNG 已导出：${res.count} 张 · ${res.folder}${note}${savedCurrent ? "" : " · 保存期间图片发生变化"}`);
      return savedCurrent;
    } catch (e) {
      showToast(String(e), false);
      return false;
    } finally {
      finishTask();
    }
  };

  const cancelBatchTask = async () => {
    if (taskRef.current !== "batch" || batchCancelRequestedRef.current) return;
    batchCancelRequestedRef.current = true;
    try {
      const accepted = await api.cancelBatch();
      if (accepted) {
        setStatus("正在取消批量任务：当前文件若已开始编码，会完成该文件后停止");
        showToast("已请求取消：已完成产物会保留，未开始文件不会记为成功或失败", true, undefined, 5200);
      } else {
        showToast("批量任务已结束，无需取消", true);
      }
    } catch (e) {
      showToast(`取消批量失败：${e}`, false);
    }
  };

  const startBatch = async (paths: string[], outDir?: string) => {
    if (taskRef.current) {
      showToast("正在处理中，请等当前任务完成", false);
      return;
    }
    const imgs = paths.filter(Boolean);
    if (!imgs.length) {
      showToast("没有可转换的文件", false);
      return;
    }
    const selected = ICO_SIZES.filter((s) => sizesRef.current.has(s));
    if (!selected.length) {
      showToast("请先勾选至少一个尺寸", false);
      return;
    }
    const out = outDir || dirName(imgs[0]);
    if (!beginTask("batch")) return;
    batchCancelRequestedRef.current = false;
    setBatchReport(null);
    setBatchInfo({ i: 0, total: imgs.length });
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<BatchProgress>("batch-progress", (event) => {
        const { index, total, name } = event.payload;
        setBatchInfo({ i: index + 1, total });
        setStatus(`批量转换中 ${index + 1}/${total}：${name}`);
      });
      const res = await api.batchConvert(imgs, out, selected, squareModeRef.current);
      setBatchReport(res);
      if (res.cancelled) {
        showToast(
          `批量已取消：已处理 ${res.processed}/${res.total}，未开始 ${res.remaining}；已完成产物保留`,
          true,
          res.ok[0],
          6500,
        );
      } else if (res.errors.length) {
        const note = res.errors
          .slice(0, 2)
          .map((e) => `${baseName(e.path)}：${e.message}`)
          .join("；");
        const more = res.errors.length > 2 ? ` 等共 ${res.errors.length} 张失败` : "";
        showToast(
          `批量完成：成功 ${res.ok.length}，失败 ${res.errors.length}（${note}${more}）`,
          false,
          res.ok[0],
          6500,
        );
      } else if (res.ok.length) {
        showToast(`批量完成：${res.ok.length} 张已转成 .ico`, true, res.ok[0]);
      } else {
        showToast("没有可转换的文件", false);
      }
      setStatus(
        `${res.cancelled ? "批量转换已取消" : "批量转换完成"}：成功 ${res.ok.length} 张 · 失败 ${res.errors.length} 张 · 未开始 ${res.remaining} 张`,
      );
    } catch (e) {
      showToast(`批量转换失败：${e}`, false);
    } finally {
      unlisten?.();
      batchCancelRequestedRef.current = false;
      finishTask();
    }
  };

  const startBatchDialog = async () => {
    if (taskRef.current) {
      showToast("正在处理中，请等当前任务完成", false);
      return;
    }
    const picked = await open({
      title: "选择要转成 ICO 的图片（可多选）",
      multiple: true,
      directory: false,
      defaultPath: settingsRef.current.lastOpenDir || undefined,
      filters: OPEN_FILTERS,
    });
    if (!picked || !Array.isArray(picked) || !picked.length) return;
    const firstDir = dirName(picked[0]);
    const out = await open({
      title: "选择输出文件夹（每张图生成同名 .ico）",
      directory: true,
      multiple: false,
      defaultPath: settingsRef.current.lastBatchDir || firstDir || undefined,
    });
    if (typeof out !== "string") return;
    persist({ lastBatchDir: out });
    await startBatch(picked, out);
  };

  const finalizeClose = async () => {
    if (closeBusyRef.current) return;
    if (taskRef.current) {
      closePendingRef.current = true;
      return;
    }
    closeBusyRef.current = true;
    try {
      const settingsSaved = await flushSettings();
      if (!settingsSaved) {
        closePendingRef.current = false;
        showToast("设置未保存，已取消关闭窗口", false, undefined, 5200);
        return;
      }
      await getCurrentWindow().destroy();
    } catch (e) {
      closePendingRef.current = false;
      showToast(`关闭窗口失败：${e}`, false, undefined, 5200);
    } finally {
      closeBusyRef.current = false;
    }
  };

  const attemptCloseFlow = async () => {
    if (taskRef.current) {
      closePendingRef.current = true;
      if (taskRef.current === "batch") {
        await cancelBatchTask();
        showToast("正在取消批量任务，收尾后会继续关闭检查", true, undefined, 4200);
      } else {
        showToast("正在处理，完成后会继续关闭检查…", true, undefined, 3200);
      }
      return;
    }
    if (discardPromptRef.current) return;
    if (imageRef.current?.edited) {
      // 批量结果弹窗不能盖住关闭保护弹窗；关闭检查优先。
      setBatchReport(null);
      closePromptRef.current = true;
      setClosePromptOpen(true);
      return;
    }
    await finalizeClose();
  };

  const saveThenClose = async () => {
    if (closeDialogBusyRef.current) return;
    closeDialogBusyRef.current = true;
    closePromptRef.current = false;
    setClosePromptOpen(false);
    try {
      const saved = await doSave();
      if (saved) {
        closePendingRef.current = true;
        await finalizeClose();
      } else {
        showToast("图片未保存，窗口保持打开", false, undefined, 4200);
      }
    } finally {
      closeDialogBusyRef.current = false;
    }
  };

  const discardThenClose = async () => {
    if (closeDialogBusyRef.current) return;
    closeDialogBusyRef.current = true;
    closePromptRef.current = false;
    setClosePromptOpen(false);
    closePendingRef.current = true;
    try {
      await finalizeClose();
    } finally {
      closeDialogBusyRef.current = false;
    }
  };

  const cancelClose = () => {
    if (closeDialogBusyRef.current) return;
    closePromptRef.current = false;
    setClosePromptOpen(false);
    closePendingRef.current = false;
    setStatus("已取消关闭，当前编辑仍保留");
  };
  const pickRatio = (key: string) => {
    const item = RATIOS.find((r) => r.key === key);
    if (!item) return;
    setRatioKey(key);
    setRatio(item.value);
    if (item.value !== null && cropRef.current && imageRef.current) {
      setCrop(rectToRatio(cropRef.current, item.value, imageRef.current.width, imageRef.current.height));
    }
    persist({ ratio: key });
  };

  const applyCustomRatio = () => {
    const parsed = parseCustomRatio(customW, customH);
    if (!parsed.ok) {
      const [appliedW, appliedH] = appliedCustomRef.current;
      setCustomW(String(appliedW));
      setCustomH(String(appliedH));
      showToast(`${parsed.message}；当前仍为 ${appliedW}:${appliedH}`, false, undefined, 5200);
      return;
    }
    const [w, h] = parsed.value;
    appliedCustomRef.current = [w, h];
    setRatioKey("custom");
    const r = w / h;
    setRatio(r);
    if (cropRef.current && imageRef.current) {
      setCrop(rectToRatio(cropRef.current, r, imageRef.current.width, imageRef.current.height));
    }
    persist({ ratio: "custom", customRatio: [w, h] });
    setStatus(`自定义比例 ${w}:${h}`);
  };

  const toggleSize = (s: number) => {
    const next = new Set(sizesRef.current);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setSizes(next);
    persist({ icoSizes: ICO_SIZES.filter((v) => next.has(v)) });
  };

  const setAllSizes = (on: boolean) => {
    const next = new Set(on ? ICO_SIZES : []);
    setSizes(next);
    persist({ icoSizes: on ? ICO_SIZES : [] });
  };

  const changeSquareMode = (m: SquareMode) => {
    setSquareMode(m);
    persist({ squareMode: m });
  };

  const toggleGuides = () => {
    const next = !guidesRef.current;
    setGuides(next);
    persist({ guides: next });
    setStatus(
      next
        ? "辅助线已开启：拖拽框选时显示参考线，靠近会自动吸附"
        : "辅助线已关闭",
    );
  };

  const handleEscape = () => {
    if (discardPromptRef.current) {
      answerDiscard(false);
      return;
    }
    if (closePromptRef.current) {
      cancelClose();
      return;
    }
    if (batchReportRef.current) {
      setBatchReport(null);
      return;
    }
    if (taskRef.current) return;
    if (cornerRef.current) {
      setSelectedCorner(null);
      setStatus("已取消选中角点");
    } else if (cropRef.current) {
      setCrop(null);
      setStatus("已清除框选，改用整张图");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      // 输入框获得焦点时交还给浏览器处理复制、粘贴和撤销。
      if (typing) return;
      if (discardPromptRef.current || closePromptRef.current || batchReportRef.current) {
        if (e.key === "Escape") {
          e.preventDefault();
          handleEscape();
        }
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && key === "o") {
        e.preventDefault();
        void openRef.current();
      } else if (ctrl && key === "z") {
        e.preventDefault();
        void undo();
      } else if (ctrl && key === "v") {
        e.preventDefault();
        void pasteClipboard();
      } else if (ctrl && key === "c") {
        e.preventDefault();
        void copyIcon();
      } else if (ctrl && key === "r") {
        e.preventDefault();
        void rotate("cw");
      } else if (ctrl && key === "l") {
        e.preventDefault();
        void rotate("ccw");
      } else if (ctrl && (e.key === "0" || e.code === "Numpad0")) {
        e.preventDefault();
        canvasRef.current?.resetZoom();
      } else if (e.key === "Escape") {
        handleEscape();
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        if (e.key === "ArrowLeft") nudge(-1, 0);
        else if (e.key === "ArrowRight") nudge(1, 0);
        else if (e.key === "ArrowUp") nudge(0, -1);
        else nudge(0, 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // 处理器全部通过 ref 读取最新状态，监听器只注册一次，避免每次渲染重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const meta = image
    ? image.edited
      ? `${image.width} × ${image.height} · 未保存${image.undoDepth > 0 ? "（Ctrl+Z 可撤销）" : "（请另存）"}${image.undoTruncated ? " · 撤销历史已截断" : ""}`
      : image.srcPath
        ? `${image.width} × ${image.height} · ${image.ext} · ${humanSize(image.bytes)}`
        : `${image.width} × ${image.height}`
    : "拖入或打开一张图片开始";

  const selectedCount = ICO_SIZES.filter((s) => sizes.has(s)).length;
  const saveLabel =
    task === "save"
      ? "正在生成…"
      : task === "export"
        ? "正在导出…"
        : task === "batch"
          ? `批量 ${batchInfo?.i ?? 0}/${batchInfo?.total ?? 0}…`
          : "保存 ICO 文件";

  const previewUrl = image
    ? convertFileSrc(image.previewPath) + `?v=${image.version}`
    : "";

  return (
    <div className={"app" + (busy ? " is-busy" : "")} aria-busy={busy}>
      <div className="main">
        <div className="left">
          <div className="canvas-card">
            <CropCanvas
              key={image?.version ?? 0}
              ref={canvasRef}
              source={image ? { width: image.width, height: image.height } : null}
              previewUrl={previewUrl}
              crop={crop}
              ratio={ratio}
              guides={guides}
              selectedCorner={selectedCorner}
              dropActive={dropActive}
              disabled={busy}
              onCropChange={(r) => setCrop(r)}
              onSelectCorner={(c) => setSelectedCorner(c)}
              onStatus={setStatus}
              onEmptyClick={() => void openImageDialog()}
            />
            {!image && (
              <div className="empty-overlay">
                <div className="empty-box">ICO</div>
                <div className="empty-line1">点击此处选择图片，或把图片拖进窗口</div>
                <div className="empty-line2">支持 {IMAGE_FORMAT_LABEL}，也可选择“所有文件”按内容识别</div>
              </div>
            )}
          </div>
        </div>

        <aside className="panel">
          <div className="p-name">{image ? image.name : "未打开图片"}</div>
          <div className="p-meta">{meta}</div>

          <Section
            title="快速调整"
            actions={[{ label: "撤销上一步", onClick: () => void undo(), testId: "undo-button" }]}
          />
          <div className="edit-grid">
            <button className="chip" onClick={() => void rotate("ccw")}>左转 90°</button>
            <button className="chip" onClick={() => void rotate("cw")}>右转 90°</button>
            <button className="chip" onClick={() => void rotate("flip_h")}>水平镜像</button>
            <button className="chip" onClick={() => void rotate("flip_v")}>垂直镜像</button>
          </div>

          <Section
            title="框选要做成图标的部分"
            actions={[
              {
                label: "辅助线",
                onClick: toggleGuides,
                color: guides ? "accent" : "muted",
              },
              {
                label: "全图",
                onClick: () => {
                  setCrop(null);
                  setStatus("已改用整张图");
                },
              },
            ]}
          />
          <div className="ratio-grid">
            {RATIOS.map((r) => (
              <button
                key={r.key}
                className={"chip small" + (ratioKey === r.key ? " active" : "")}
                onClick={() => pickRatio(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="custom-row">
            <button
              className={"chip custom-chip" + (ratioKey === "custom" ? " active" : "")}
              onClick={applyCustomRatio}
            >
              自定义
            </button>
            <span className="tiny-label">宽</span>
            <input
              className="ratio-input"
              aria-label="自定义比例宽度"
              inputMode="numeric"
              value={customW}
              onChange={(e) => setCustomW(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyCustomRatio();
              }}
            />
            <span className="ratio-colon">:</span>
            <input
              className="ratio-input"
              aria-label="自定义比例高度"
              inputMode="numeric"
              value={customH}
              onChange={(e) => setCustomH(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyCustomRatio();
              }}
            />
            <span className="tiny-label">高</span>
          </div>
          <div className="hint small">拖拽贴近辅助线自动吸附 · 点角点后方向键微调 1px</div>
          <div className="rect-label">
            {crop
              ? `选区  ${crop.w} × ${crop.h}（原图像素）· 点「裁切」应用后保存`
              : "当前用整张图，也可在图上拖拽框选"}
          </div>

          <Section title="图片不是正方形时" />
          <div className="segmented">
            {SQUARE_LABELS.map(([label, key]) => (
              <button
                key={key}
                className={"seg" + (squareMode === key ? " active" : "")}
                onClick={() => changeSquareMode(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="hint small">{SQUARE_HINTS[squareMode]}</div>

          <Section
            title="图片生成哪些尺寸"
            actions={[
              { label: "全不选", onClick: () => setAllSizes(false) },
              { label: "全选", onClick: () => setAllSizes(true) },
            ]}
          />
          <div className="size-grid">
            {ICO_SIZES.map((s) => (
              <button
                key={s}
                className={"chip size-chip" + (sizes.has(s) ? " active" : "")}
                onClick={() => toggleSize(s)}
              >
                {s}×{s}
              </button>
            ))}
          </div>

          <Section title="小提示" />
          <div className="tips">
            Ctrl+O 打开 · Ctrl+V 粘贴截图 · Ctrl+C 复制成品{"\n"}
            Ctrl+R/L 旋转 · Ctrl+Z 撤销 · 滚轮缩放 · Ctrl+0 复位
          </div>

          <div className="panel-actions">
            <button className="secondary crop-btn" disabled={busy} onClick={() => void applyCrop()}>
              裁切（应用框选）
            </button>
            <div className="row2">
              {task === "batch" ? (
                <button className="secondary cancel-btn" onClick={() => void cancelBatchTask()}>
                  取消批量
                </button>
              ) : (
                <button className="secondary" disabled={busy} onClick={() => void startBatchDialog()}>
                  批量转换…
                </button>
              )}
              <button className="secondary" disabled={busy} onClick={() => void doExportPng()}>
                导出 PNG…
              </button>
            </div>
            <button className="primary" disabled={busy} onClick={() => void doSave()}>
              {saveLabel}
            </button>
          </div>
        </aside>
      </div>

      <div className="statusbar">
        <div className="status-text">{status}</div>
        <span className="sizes-label">已选 {selectedCount} 档尺寸</span>
        <span className="signature">v{APP_VERSION}</span>
      </div>

      {toast && (
        <div
          key={toast.id}
          className={"toast " + (toast.ok ? "toast-ok" : "toast-err")}
          role="status"
          aria-live="polite"
        >
          <span className="toast-text">{toast.text}</span>
          {toast.openPath && (
            <button
              className="toast-btn"
              onClick={() => {
                revealItemInDir(toast.openPath!).catch(() => undefined);
                setToast(null);
              }}
            >
              打开文件夹
            </button>
          )}
        </div>
      )}

      {discardPrompt && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="discard-title">
            <h2 id="discard-title">{discardPrompt.title}</h2>
            <p>{discardPrompt.message}</p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => answerDiscard(false)}>
                取消
              </button>
              <button className="primary" onClick={() => answerDiscard(true)}>
                {discardPrompt.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {closePromptOpen && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="close-title">
            <h2 id="close-title">当前图片有未保存编辑</h2>
            <p>可以保存后退出、放弃本次编辑退出，或取消关闭继续编辑。</p>
            <div className="modal-actions modal-actions-3">
              <button className="secondary" onClick={cancelClose}>
                取消
              </button>
              <button className="secondary danger" onClick={() => void discardThenClose()}>
                不保存退出
              </button>
              <button className="primary" onClick={() => void saveThenClose()}>
                保存后退出
              </button>
            </div>
          </div>
        </div>
      )}

      {batchReport && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal batch-modal" role="dialog" aria-modal="true" aria-labelledby="batch-title">
            <h2 id="batch-title">批量转换结果</h2>
            <div className="batch-summary">
              <span>{batchReport.cancelled ? "已取消" : "已完成"}</span>
              <span>已处理 {batchReport.processed}/{batchReport.total}</span>
              <span>未开始 {batchReport.remaining}</span>
            </div>
            <div className="batch-list">
              {batchReport.items.map((item, index) => (
                <div className={"batch-item " + (item.output ? "batch-item-ok" : "batch-item-err")} key={`${item.source}-${index}`}>
                  <div className="batch-item-name">{baseName(item.source)}</div>
                  <div className="batch-item-meta">
                    请求 {formatSizes(item.requested)} · 实际 {formatSizes(item.actual)} · 跳过 {formatSizes(item.skipped)}
                  </div>
                  {item.message && <div className="batch-item-error">{item.stage}：{item.message}</div>}
                </div>
              ))}
              {!batchReport.items.length && <div className="batch-empty">没有已处理的文件。</div>}
            </div>
            <div className="modal-actions">
              <button className="primary" onClick={() => setBatchReport(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  actions = [],
}: {
  title: string;
  actions?: { label: string; onClick: () => void; color?: "accent" | "muted"; testId?: string }[];
}) {
  return (
    <div className="section-head">
      <span className="section-bar" />
      <span className="section-title">{title}</span>
      <span className="section-actions">
        {actions.map((a) => (
          <button
            key={a.label}
            className={"link-btn" + (a.color === "muted" ? " muted" : "")}
            data-testid={a.testId}
            onClick={a.onClick}
          >
            {a.label}
          </button>
        ))}
      </span>
    </div>
  );
}
