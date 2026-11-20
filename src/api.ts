import { invoke } from "@tauri-apps/api/core";
import type {
  BatchProgress,
  BatchResult,
  ExportPngResult,
  ImageState,
  SaveIcoResult,
  Settings,
} from "./types";

export const api = {
  loadImage: (path: string) => invoke<ImageState>("load_image", { path }),
  pasteClipboard: () => invoke<ImageState>("paste_clipboard"),
  rotate: (op: string) => invoke<ImageState>("rotate", { op }),
  applyCrop: (x: number, y: number, w: number, h: number) =>
    invoke<ImageState>("apply_crop", { x, y, w, h }),
  undo: () => invoke<ImageState>("undo"),
  copyImage: (mode: string) => invoke<[number, number]>("copy_image", { mode }),
  saveIco: (path: string, sizes: number[], mode: string) =>
    invoke<SaveIcoResult>("save_ico", { path, sizes, mode }),
  exportPngs: (outDir: string, sizes: number[], mode: string) =>
    invoke<ExportPngResult>("export_pngs", { outDir, sizes, mode }),
  batchConvert: (paths: string[], outDir: string, sizes: number[], mode: string) =>
    invoke<BatchResult>("batch_convert", { paths, outDir, sizes, mode }),
  cancelBatch: () => invoke<boolean>("cancel_batch"),
  loadSettings: () => invoke<Settings>("load_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  takeInitialPath: () => invoke<string | null>("take_initial_path"),
};

export type { BatchProgress };