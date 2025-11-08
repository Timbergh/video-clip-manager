/// <reference types="node" />
/// <reference types="react" />

interface IElectronAPI {
  getVersion: () => string;
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
  };
  selectFolder: () => Promise<string | null>;
  scanVideos: (folderPath: string) => Promise<any[]>;
  watchFolder: (folderPath: string) => Promise<void>;
  unwatchFolder: (folderPath: string) => Promise<void>;
  getFileStats: (filePath: string) => Promise<any>;
  trashFiles: (filePaths: string[]) => Promise<any>;
  startDrag: (payload: { filePath: string; iconPath?: string }) => Promise<void>;
  getVideoMetadata: (videoPath: string) => Promise<any>;
  getCachedMetadata: (videoPath: string) => Promise<any>;
  getCachedThumbnail: (videoPath: string, duration?: number, trimStart?: number, trimEnd?: number) => Promise<string>;
  generateThumbnail: (videoPath: string, outputPath: string, timestampSeconds?: number) => Promise<string>;
  generateTimelineThumbnails: (videoPath: string, outputDir: string, count?: number) => Promise<string[]>;
  getClipHash: (filepath: string, duration?: number | null) => Promise<string>;
  saveClipEdits: (data: any) => Promise<any>;
  getClipEdits: (contentHash: string) => Promise<any>;
  toggleFavorite: (data: any) => Promise<any>;
  isFavorite: (contentHash: string) => Promise<boolean>;
  getAllFavorites: () => Promise<any[]>;
  selectSaveLocation: (
    defaultPath: string,
    filters?: Array<{ name: string; extensions: string[] }>
  ) => Promise<any>;
  exportVideo: (
    inputPath: string,
    outputPath: string,
    startTime: number,
    endTime: number,
    quality: 'full' | 'compressed',
    audioTracks?: any[],
    targetSizeMB?: number,
    jobId?: string,
    audioMode?: 'combine' | 'separate',
    outputType?: 'video' | 'mp3',
    compressionQuality?: 'fast' | 'standard' | 'high'
  ) => Promise<any>;
  cancelExport: () => Promise<boolean>;
  extractAudioTracks: (videoPath: string, outputDir: string) => Promise<string[]>;
  getCachedExtractedAudio: (videoPath: string, forceRefresh?: boolean) => Promise<string[]>;
  readFileBuffer: (filePath: string) => Promise<Buffer>;
  readFileAsDataUrl: (filePath: string) => Promise<string>;
  clearCache: () => Promise<{ success: boolean; filesCleared: number; errors?: string[] }>;
  on: (channel: string, func: (...args: any[]) => void) => (() => void) | undefined;
  removeListener: (channel: string, func: (...args: any[]) => void) => void;
}

interface IPath {
  join: (...args: string[]) => string;
  basename: (p: string, ext?: string) => string;
  dirname: (p: string) => string;
  extname: (p: string) => string;
  relative: (from: string, to: string) => string;
  normalize: (p: string) => string;
  toLocalURL: (p: string) => string;
}

interface IOS {
  tmpdir: () => string;
  platform: () => string;
}

interface IFS {
  existsSync: (path: string) => boolean;
  statSync: (path: string) => any;
  copyFileSync: (src: string, dest: string) => void;
  writeFileSync: (path: string, data: any) => void;
  writeFile: (path: string, data: any, callback: (err: any) => void) => void;
  readFileSync: (path: string, encoding?: BufferEncoding) => any;
}

interface IBuffer {
  from: (data: any, encoding?: BufferEncoding) => Buffer;
}

declare global {
  interface Window {
    api: IElectronAPI;
    path: IPath;
    os: IOS;
    fs: IFS;
    Buffer: IBuffer;
  }
}

export {};
