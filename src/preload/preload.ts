import { contextBridge, ipcRenderer } from 'electron';
const path = require('path');
const os = require('os');
const fs = require('fs');

// Read version from package.json
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
const appVersion = packageJson.version;

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  // App info
  getVersion: () => appVersion,

  // Window controls
  window: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
  },

  // Folder and file operations
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  scanVideos: (folderPath: string) => ipcRenderer.invoke('scan-videos', folderPath),
  watchFolder: (folderPath: string) => ipcRenderer.invoke('watch-folder', folderPath),
  unwatchFolder: (folderPath: string) => ipcRenderer.invoke('unwatch-folder', folderPath),
  getFileStats: (filePath: string) => ipcRenderer.invoke('get-file-stats', filePath),
  trashFiles: (filePaths: string[]) => ipcRenderer.invoke('trash-files', filePaths),
  startDrag: (payload: { filePath: string; iconPath?: string }) => ipcRenderer.invoke('start-drag', payload),

  // Video metadata and thumbnails
  getVideoMetadata: (videoPath: string) => ipcRenderer.invoke('get-video-metadata', videoPath),
  getCachedMetadata: (videoPath: string) => ipcRenderer.invoke('get-cached-metadata', videoPath),
  getCachedThumbnail: (videoPath: string, duration?: number, trimStart?: number, trimEnd?: number) =>
    ipcRenderer.invoke('get-cached-thumbnail', videoPath, duration, trimStart, trimEnd),
  generateThumbnail: (videoPath: string, outputPath: string, timestampSeconds?: number) =>
    ipcRenderer.invoke('generate-thumbnail', videoPath, outputPath, timestampSeconds),
  generateTimelineThumbnails: (videoPath: string, outputDir: string, count?: number) =>
    ipcRenderer.invoke('generate-timeline-thumbnails', videoPath, outputDir, count),

  // Clip operations
  getClipHash: (filepath: string, duration?: number | null) => ipcRenderer.invoke('get-clip-hash', filepath, duration),
  saveClipEdits: (data: any) => ipcRenderer.invoke('save-clip-edits', data),
  getClipEdits: (contentHash: string) => ipcRenderer.invoke('get-clip-edits', contentHash),

  // Favorites
  toggleFavorite: (data: any) => ipcRenderer.invoke('toggle-favorite', data),
  isFavorite: (contentHash: string) => ipcRenderer.invoke('is-favorite', contentHash),
  getAllFavorites: () => ipcRenderer.invoke('get-all-favorites'),

  // Export
  selectSaveLocation: (defaultPath: string, filters?: Array<{ name: string; extensions: string[] }>) =>
    ipcRenderer.invoke('select-save-location', defaultPath, filters),
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
  ) =>
    ipcRenderer.invoke(
      'export-video',
      inputPath,
      outputPath,
      startTime,
      endTime,
      quality,
      audioTracks,
      targetSizeMB,
      jobId,
      audioMode,
      outputType,
      compressionQuality
    ),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),

  // Audio
  extractAudioTracks: (videoPath: string, outputDir: string) =>
    ipcRenderer.invoke('extract-audio-tracks', videoPath, outputDir),
  getCachedExtractedAudio: (videoPath: string, forceRefresh?: boolean) =>
    ipcRenderer.invoke('get-cached-extracted-audio', videoPath, forceRefresh),
  readFileBuffer: (filePath: string) => ipcRenderer.invoke('read-file-buffer', filePath),
  readFileAsDataUrl: (filePath: string) => ipcRenderer.invoke('read-file-as-data-url', filePath),

  // Cache management
  clearCache: () => ipcRenderer.invoke('clear-cache'),

  // Event listeners
  on: (channel: string, func: (payload: any) => void) => {
    const validChannels = ['file-added', 'file-removed', 'export-progress'];
    if (!validChannels.includes(channel)) return () => {};

    const subscription = (_event: any, ...args: any[]) => {
      const payload = args.length > 0 ? args[0] : undefined; // pass only the first arg
      try {
        func(payload);
      } catch (e) {
        console.error('[preload] listener error:', channel, e, { payload });
      }
    };

    ipcRenderer.on(channel, subscription);
    // return an unsubscribe fn you can call later
    return () => ipcRenderer.removeListener(channel, subscription);
  },
  removeListener: (channel: string, _func: (...args: any[]) => void) => {
    // Use the unsubscribe function returned by `on(...)` instead,
    // because we wrap the original callback.
    console.warn('[preload] removeListener: use the function returned by on(channel, fn)');
  },
});

// Helper to convert file paths to local:// URLs
function filePathToLocalURL(filePath: string): string {
  // Normalize path and convert backslashes to forward slashes
  const normalized = path.normalize(filePath).replace(/\\/g, '/');
  // URL encode the path but preserve forward slashes and colons in drive letters
  // Split by /, encode each segment, then rejoin
  const segments = normalized.split('/');
  const encoded = segments.map((segment: string, index: number) => {
    // Don't encode drive letter colons (e.g., "C:")
    if (index === 0 && segment.match(/^[A-Za-z]:$/)) {
      return segment;
    }
    return encodeURIComponent(segment);
  }).join('/');
  // Ensure proper URL format: local:///C:/Users/... (three slashes for absolute paths)
  return `local:///${encoded}`;
}

// Expose safe Node.js modules
contextBridge.exposeInMainWorld('path', {
  join: (...args: string[]) => path.join(...args),
  basename: (p: string, ext?: string) => path.basename(p, ext),
  dirname: (p: string) => path.dirname(p),
  extname: (p: string) => path.extname(p),
  relative: (from: string, to: string) => path.relative(from, to),
  normalize: (p: string) => path.normalize(p),
  toLocalURL: (p: string) => filePathToLocalURL(p),
});

contextBridge.exposeInMainWorld('os', {
  tmpdir: () => os.tmpdir(),
  platform: () => os.platform(),
});

contextBridge.exposeInMainWorld('fs', {
  existsSync: (path: string) => fs.existsSync(path),
  statSync: (path: string) => fs.statSync(path),
  copyFileSync: (src: string, dest: string) => fs.copyFileSync(src, dest),
  writeFileSync: (path: string, data: any) => fs.writeFileSync(path, data),
  writeFile: (path: string, data: any, callback: (err: any) => void) => fs.writeFile(path, data, callback),
  readFileSync: (path: string, encoding?: BufferEncoding) => fs.readFileSync(path, encoding),
});

contextBridge.exposeInMainWorld('Buffer', {
  from: (data: any, encoding?: BufferEncoding) => Buffer.from(data, encoding),
});
