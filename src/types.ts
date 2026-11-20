export type SquareMode = "pad" | "center" | "stretch";

export type Settings = {
  lastOpenDir: string;
  lastSaveDir: string;
  lastBatchDir: string;
  icoSizes: number[];
  squareMode: SquareMode;
  ratio: string;
  customRatio: [number, number];
  guides: boolean;
};

export type ImageState = {
  name: string;
  srcPath: string | null;
  width: number;
  height: number;
  ext: string;
  bytes: number;
  edited: boolean;
  previewPath: string;
  version: number;
  isIco: boolean;
  undoDepth: number;
  undoTruncated: boolean;
};

export type SizeReport = {
  requested: number[];
  sizes: number[];
  skipped: number[];
  sourceSide: number;
};

export type SaveIcoResult = SizeReport & {
  path: string;
  edited: boolean;
  imageVersion: number;
};

export type ExportPngResult = SizeReport & {
  count: number;
  first: string;
  folder: string;
  files: string[];
  edited: boolean;
  imageVersion: number;
};

export type BatchError = {
  path: string;
  message: string;
  stage: string;
};

export type BatchItemResult = {
  source: string;
  output: string | null;
  requested: number[];
  actual: number[];
  skipped: number[];
  sourceSide: number;
  stage: string;
  message: string | null;
};

export type BatchResult = {
  ok: string[];
  errors: BatchError[];
  items: BatchItemResult[];
  cancelled: boolean;
  processed: number;
  total: number;
  remaining: number;
};

export type BatchProgress = { index: number; total: number; name: string };

export type ToastState = {
  text: string;
  ok: boolean;
  openPath?: string;
  ms?: number;
  id: number;
};