import { app, BrowserWindow, ipcMain, dialog, nativeImage, shell, protocol } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpeg from 'fluent-ffmpeg';
import * as db from './database';

const execFileAsync = promisify(execFile);

// File watcher state
const folderWatchers = new Map<string, fs.FSWatcher>();
const watchedBaseFolders = new Map<string, string>();
const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv'];

function resolveFfmpeg(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
  }
  return path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
}

function resolveFfprobe(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'ffprobe.exe');
  }
  return path.join(process.cwd(), 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe');
}

ffmpeg.setFfmpegPath(resolveFfmpeg());
ffmpeg.setFfprobePath(resolveFfprobe());

// Helper function to validate if a video file is complete and readable
async function isValidVideoFile(videoPath: string): Promise<boolean> {
  try {
    // Check if file exists and is accessible
    const stats = await fs.promises.stat(videoPath);
    if (stats.size === 0) {
      console.log(`[Validation] File has zero size: ${videoPath}`);
      return false;
    }

    // Check file stability (not actively being written)
    // Wait 100ms and check if size changed
    const initialSize = stats.size;
    await new Promise(resolve => setTimeout(resolve, 100));
    const newStats = await fs.promises.stat(videoPath);
    if (newStats.size !== initialSize) {
      console.log(`[Validation] File is still being written: ${videoPath}`);
      return false;
    }

    // Try to probe with a 5-second timeout
    const ffprobePath = resolveFfprobe();
    const probePromise = execFileAsync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'json',
      '-i', videoPath
    ]);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Probe timeout')), 5000);
    });

    const { stdout } = await Promise.race([probePromise, timeoutPromise]);
    const data = JSON.parse(stdout);

    // Check if we have at least one video stream
    if (!data.streams || data.streams.length === 0) {
      console.log(`[Validation] No streams found: ${videoPath}`);
      return false;
    }

    const hasVideoStream = data.streams.some((s: any) => s.codec_type === 'video');
    if (!hasVideoStream) {
      console.log(`[Validation] No video stream found: ${videoPath}`);
      return false;
    }

    // Check if format has a valid duration
    if (!data.format || !data.format.duration || parseFloat(data.format.duration) <= 0) {
      console.log(`[Validation] Invalid duration: ${videoPath}`);
      return false;
    }

    return true;
  } catch (error: any) {
    console.log(`[Validation] Failed to validate ${videoPath}:`, error.message);
    return false;
  }
}

// Helper function to run ffprobe with full metadata extraction
async function ffprobeWithFullMetadata(videoPath: string): Promise<any> {
  const ffprobePath = resolveFfprobe();
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-show_format',
      '-show_streams',
      '-print_format', 'json',
      '-i', videoPath
    ]);
    return JSON.parse(stdout);
  } catch (error: any) {
    console.error('FFprobe error:', error);
    throw new Error(`Failed to probe video: ${error.message}`);
  }
}

// Ensure proper taskbar grouping & notifications on Windows.
app.setAppUserModelId('com.videoclipmanager.app');

let mainWindow: BrowserWindow | null = null;

// Track active export commands per renderer to allow cancellation
const activeExports = new Map<number, ffmpeg.FfmpegCommand>();
const canceledExports = new Set<number>();

// Register the protocol as privileged before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      bypassCSP: false,
      stream: true,
      corsEnabled: true
    }
  }
]);

function createWindow() {
  const iconPath = path.join(__dirname, '../assets/icon.ico');
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 740,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    },
    icon: iconPath
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupAutoUpdate() {
  if (!app.isPackaged) return; // only check when packaged

  autoUpdater.logger = log;
  // @ts-ignore
  autoUpdater.logger.transports.file.level = 'info';


  autoUpdater.allowPrerelease = /\bbeta\b/i.test(app.getVersion());

  autoUpdater.on('checking-for-update', () => log.info('Checking for update…'));
  autoUpdater.on('update-available', (info) => log.info('Update available', info));
  autoUpdater.on('update-not-available', () => log.info('No update available'));
  autoUpdater.on('error', (err) => log.error('AutoUpdate error', err));
  autoUpdater.on('download-progress', (p) => log.info(`Download ${Math.round(p.percent)}%`));
  autoUpdater.on('update-downloaded', async () => {
    const res = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      message: 'An update is ready to install.',
      detail: 'Restart the app to apply it.'
    });
    if (res.response === 0) autoUpdater.quitAndInstall();
  });

  // Kick off a check shortly after the UI is ready
  setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 2000);
}

app.whenReady().then(() => {
  if (process.env.NODE_ENV !== 'production') {
    process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  }
  const iconPath = path.join(__dirname, '../assets/icon.ico');
  if (fs.existsSync(iconPath)) {
    app.dock?.setIcon(iconPath);
    console.log('Application icon set from:', iconPath);
  } else {
    console.warn('Icon file not found at:', iconPath);
  }

  // Register custom protocol for serving local files securely
  protocol.handle('local', (request) => {
    try {
      const url = new URL(request.url);
      let filePath = decodeURIComponent(url.pathname);
      if (filePath.startsWith('/')) filePath = filePath.substring(1);
      const normalizedPath = path.normalize(filePath.replace(/\//g, path.sep));

      console.log('[local protocol] Request:', request.url);
      const requestHeaders: { [key: string]: string } = {};
      request.headers.forEach((value, key) => { requestHeaders[key] = value; });
      console.log('[local protocol] Request headers:', requestHeaders);

      const tmpDir = path.normalize(os.tmpdir());
      let isAllowed = normalizedPath.startsWith(tmpDir);

      if (!isAllowed) {
        for (const [watchedFolder] of watchedBaseFolders) {
          const normalizedWatched = path.normalize(watchedFolder);
          if (normalizedPath.startsWith(normalizedWatched)) {
            isAllowed = true;
            break;
          }
        }
      }

      if (!isAllowed) {
        console.error('[local protocol] Rejected access to:', normalizedPath);
        return new Response('Access denied', { status: 403, headers: { 'content-type': 'text/plain' } });
      }

      if (!fs.existsSync(normalizedPath)) {
        console.error('[local protocol] File not found:', normalizedPath);
        return new Response('File not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      }

      const ext = path.extname(normalizedPath).toLowerCase();
      const mimeTypes: { [key: string]: string } = {
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      };
      const mimeType = mimeTypes[ext] || 'application/octet-stream';

      const stat = fs.statSync(normalizedPath);
      const fileSize = stat.size;
      const rangeHeader = request.headers.get('range');

      if (rangeHeader) {
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;

        const buffer = Buffer.alloc(chunkSize);
        const fd = fs.openSync(normalizedPath, 'r');
        fs.readSync(fd, buffer, 0, chunkSize, start);
        fs.closeSync(fd);

        const headers = new Headers({
          'content-type': mimeType,
          'content-length': String(chunkSize),
          'content-range': `bytes ${start}-${end}/${fileSize}`,
          'accept-ranges': 'bytes',
          'cache-control': 'no-cache',
          'access-control-allow-origin': '*'
        });
        return new Response(buffer, { status: 206, headers });
      }

      // For non-range requests, return full file
      const fileContent = fs.readFileSync(normalizedPath);

      const headers = new Headers({
        'content-type': mimeType,
        'content-length': String(fileSize),
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*'
      });
      return new Response(fileContent, { status: 200, headers });
    } catch (error) {
      console.error('[local protocol] Error:', error);
      return new Response('Internal server error', { status: 500, headers: { 'content-type': 'text/plain' } });
    }
  });

  db.initDatabase();
  createWindow();

  setupAutoUpdate();
});


app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// IPC Handlers
ipcMain.handle('updater:check-now', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'dev' };
  await autoUpdater.checkForUpdates();
  return { ok: true };
});


ipcMain.handle('win:minimize', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (win) win.minimize();
});

ipcMain.handle('win:maximize', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (win) {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }
});

ipcMain.handle('win:close', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (win) win.close();
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });

  if (result.canceled) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('select-save-location', async (event, defaultPath: string, filters?: Array<{ name: string; extensions: string[] }>) => {
  const result = await dialog.showSaveDialog({
    defaultPath,
    filters: filters && filters.length > 0 ? filters : [
      { name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv'] }
    ]
  });

  return result;
});

ipcMain.handle('scan-videos', async (event, folderPath: string) => {
  const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv'];
  const videos: any[] = [];

  function scanDirectory(dirPath: string) {
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        scanDirectory(fullPath);
      } else {
        const ext = path.extname(file).toLowerCase();
        if (videoExtensions.includes(ext)) {
          // Calculate relative path from root folder
          const relativePath = path.relative(folderPath, fullPath);
          const folderName = path.dirname(relativePath);

          videos.push({
            name: file,
            path: fullPath,
            size: stat.size,
            created: stat.birthtime,
            modified: stat.mtime,
            relativePath: relativePath,
            folderPath: folderName === '.' ? '' : folderName
          });
        }
      }
    }
  }

  try {
    scanDirectory(folderPath);
    return videos;
  } catch (error) {
    console.error('Error scanning videos:', error);
    return [];
  }
});

ipcMain.handle('get-video-metadata', async (event, videoPath: string) => {
  return await ffprobeWithFullMetadata(videoPath);
});

// Cached metadata (ffprobe) keyed by path + mtime + size
const metaTasks = new Map<string, Promise<any>>();
function computeMetaCachePath(videoPath: string): string {
  try {
    const stat = fs.statSync(videoPath);
    const hash = crypto
      .createHash('sha1')
      .update(videoPath)
      .update(String(stat.mtimeMs))
      .update(String(stat.size))
      .digest('hex')
      .slice(0, 16);
    const base = path.basename(videoPath, path.extname(videoPath));
    return path.join(os.tmpdir(), 'vcm-meta', `${base}-${hash}.json`);
  } catch {
    const hash = crypto.createHash('sha1').update(videoPath).digest('hex').slice(0, 16);
    const base = path.basename(videoPath, path.extname(videoPath));
    return path.join(os.tmpdir(), 'vcm-meta', `${base}-${hash}.json`);
  }
}

const metadataMemoryCache = new Map<string, any>();

ipcMain.handle('get-cached-metadata', async (event, videoPath: string) => {
  // Check in-memory cache first
  if (metadataMemoryCache.has(videoPath)) {
    return metadataMemoryCache.get(videoPath);
  }

  const cachePath = computeMetaCachePath(videoPath);

  try {
    if (fs.existsSync(cachePath)) {
      const raw = fs.readFileSync(cachePath, 'utf8');
      const metadata = JSON.parse(raw);
      // Store in memory for next time
      metadataMemoryCache.set(videoPath, metadata);
      return metadata;
    }
  } catch (e) {
    console.error('[Metadata Cache] Error reading cache:', e);
  }

  // Check if already being fetched
  let p = metaTasks.get(cachePath);
  if (!p) {
    p = (async () => {
      try {
        const metadata = await ffprobeWithFullMetadata(videoPath);
        try {
          const dir = path.dirname(cachePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(cachePath, JSON.stringify(metadata));
          // Store in memory cache
          metadataMemoryCache.set(videoPath, metadata);
        } catch (e) {
          console.error('[Metadata Cache] Error writing cache:', e);
        }
        return metadata;
      } catch (error: any) {
        console.error('[Metadata] Error fetching metadata:', error.message);
        // Return null for files that can't be probed (corrupted or actively recording)
        return null;
      } finally {
        try { metaTasks.delete(cachePath); } catch {}
      }
    })();
    metaTasks.set(cachePath, p);
  }
  return await p;
});

ipcMain.handle('generate-thumbnail', async (event, videoPath: string, outputPath: string, timestampSeconds?: number) => {
  return new Promise((resolve, reject) => {
    const screenshotsOpts: any = {
      filename: path.basename(outputPath),
      folder: path.dirname(outputPath),
      size: '960x540'
    };
    if (typeof timestampSeconds === 'number' && !Number.isNaN(timestampSeconds)) {
      screenshotsOpts.timestamps = [timestampSeconds];
    } else {
      screenshotsOpts.timestamps = ['10%'];
    }
    ffmpeg(videoPath)
      .screenshots(screenshotsOpts)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err));
  });
});

const thumbTasks = new Map<string, Promise<string>>();
function getThumbCacheDir(): string {
  const dir = path.join(os.tmpdir(), 'vcm-thumbs');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function computeCachedThumbPath(videoPath: string, trimStart?: number, trimEnd?: number): string {
  try {
    const stat = fs.statSync(videoPath);
    const hashInput = crypto
      .createHash('sha1')
      .update(videoPath)
      .update(String(stat.mtimeMs))
      .update(String(stat.size));

    // Include trim data in hash if present
    if (trimStart !== undefined && trimEnd !== undefined) {
      hashInput.update(`trim-${trimStart}-${trimEnd}`);
    }

    const hash = hashInput.digest('hex').slice(0, 16);
    const base = path.basename(videoPath, path.extname(videoPath));
    return path.join(getThumbCacheDir(), `${base}-${hash}.jpg`);
  } catch {
    const hashInput = crypto.createHash('sha1').update(videoPath);

    // Include trim data in hash if present
    if (trimStart !== undefined && trimEnd !== undefined) {
      hashInput.update(`trim-${trimStart}-${trimEnd}`);
    }

    const hash = hashInput.digest('hex').slice(0, 16);
    const base = path.basename(videoPath, path.extname(videoPath));
    return path.join(getThumbCacheDir(), `${base}-${hash}.jpg`);
  }
}

ipcMain.handle('get-cached-thumbnail', async (event, videoPath: string, duration?: number, trimStart?: number, trimEnd?: number) => {
  const outPath = computeCachedThumbPath(videoPath, trimStart, trimEnd);

  // Debug logging
  console.log('Thumbnail request:', {
    videoPath: path.basename(videoPath),
    duration,
    trimStart,
    trimEnd,
    cachePath: path.basename(outPath)
  });

  try {
    if (fs.existsSync(outPath)) {
      console.log('Thumbnail cache HIT:', path.basename(outPath));
      return outPath;
    } else {
      // Check if old cache exists (without trim data in hash)
      const oldPath = computeCachedThumbPath(videoPath);
      if (fs.existsSync(oldPath) && (!trimStart || !trimEnd)) {
        console.log('Using old thumbnail cache:', path.basename(oldPath));
        return oldPath;
      }
      console.log('Thumbnail cache MISS - generating new thumbnail');
    }
  } catch (err) {
    console.error('Error checking thumbnail cache:', err);
  }

  let task = thumbTasks.get(outPath);
  if (!task) {
    console.log('Creating new thumbnail generation task. Active tasks:', thumbTasks.size);
    task = new Promise<string>((resolve, reject) => {
      try {
        const dir = path.dirname(outPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      } catch {}

      let timeoutId: NodeJS.Timeout | null = null;
      let command: ffmpeg.FfmpegCommand | null = null;

      // Calculate thumbnail timestamp
      let timestamp: number;
      if (trimStart !== undefined && trimEnd !== undefined && trimStart >= 0 && trimEnd > trimStart) {
        // If there's a trim, use the start of the trim
        timestamp = trimStart;
        console.log('Using trimStart:', trimStart);
      } else if (duration !== undefined && duration > 0) {
        // If no trim, use middle of video
        timestamp = duration / 2;
        console.log('Using 50% of duration:', duration / 2);
      } else {
        // Fallback to 1 second if no duration provided
        timestamp = 1;
        console.log('Using fallback 1 second');
      }

      // Set a 10-second timeout for thumbnail generation
      timeoutId = setTimeout(() => {
        if (command) {
          command.kill('SIGKILL');
        }
        reject(new Error('Thumbnail generation timeout'));
      }, 10000);

      console.log('Starting ffmpeg thumbnail generation at timestamp:', timestamp);

      // Use input seeking (-ss before -i) for faster seeking
      command = ffmpeg(videoPath)
        .seekInput(timestamp)
        .outputOptions([
          '-vframes 1',
          '-s 960x540'
        ])
        .output(outPath)
        .on('end', () => {
          console.log('Thumbnail generated successfully:', path.basename(outPath));
          if (timeoutId) clearTimeout(timeoutId);
          resolve(outPath);
        })
        .on('error', (err) => {
          console.error('ffmpeg thumbnail error:', err.message);
          if (timeoutId) clearTimeout(timeoutId);
          reject(err);
        });

      command.run();
    })
      .finally(() => {
        try {
          thumbTasks.delete(outPath);
          console.log('Thumbnail task completed. Remaining tasks:', thumbTasks.size);
        } catch {}
      });
    thumbTasks.set(outPath, task);
  } else {
    console.log('Reusing existing thumbnail generation task');
  }
  return await task;
});

ipcMain.handle('extract-audio-tracks', async (event, videoPath: string, outputDir: string) => {
  return new Promise(async (resolve, reject) => {
    try {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // First, get metadata to know how many audio tracks there are
      try {
        const metadata = await ffprobeWithFullMetadata(videoPath);
        const audioStreams = metadata.streams.filter((s: any) => s.codec_type === 'audio');

        if (audioStreams.length === 0) {
          resolve([]);
          return;
        }

        const extractedFiles: string[] = new Array(audioStreams.length);
        let completed = 0;
        let hasError = false;

        // Extract each audio track separately
        audioStreams.forEach((stream: any, index: number) => {
          const outputFile = path.join(outputDir, `audio_track_${index}.wav`);


          ffmpeg(videoPath)
            .outputOptions([
              `-map 0:a:${index}`,  // Select specific audio track
              '-acodec pcm_s16le',  // Convert to WAV for Web Audio API
              '-ar 48000',          // Sample rate
              '-ac 2'               // Stereo
            ])
            .output(outputFile)
            .on('start', (cmd) => {
            })
            .on('end', () => {
              extractedFiles[index] = outputFile;
              completed++;

              if (completed === audioStreams.length && !hasError) {
                resolve(extractedFiles);
              }
            })
            .on('error', (err, stdout, stderr) => {
              if (!hasError) {
                hasError = true;
                console.error(`Error extracting audio track ${index}:`, err.message);
                console.error('FFmpeg stderr:', stderr);
                reject(new Error(`Failed to extract audio track ${index}: ${err.message}`));
              }
            })
            .run();
        });
      } catch (metadataError) {
        console.error('FFprobe error:', metadataError);
        reject(metadataError);
      }
    } catch (error) {
      console.error('Extract audio tracks error:', error);
      reject(error);
    }
  });
});

const audioExtractTasks = new Map<string, Promise<string[]>>();
function computeAudioCacheDir(videoPath: string): string {
  try {
    const stat = fs.statSync(videoPath);
    const hash = crypto
      .createHash('sha1')
      .update(videoPath)
      .update(String(stat.mtimeMs))
      .update(String(stat.size))
      .digest('hex')
      .slice(0, 16);
    const base = path.basename(videoPath, path.extname(videoPath));
    return path.join(os.tmpdir(), 'vcm-audio', `${base}-${hash}`);
  } catch {
    const hash = crypto.createHash('sha1').update(videoPath).digest('hex').slice(0, 16);
    const base = path.basename(videoPath, path.extname(videoPath));
    return path.join(os.tmpdir(), 'vcm-audio', `${base}-${hash}`);
  }
}

ipcMain.handle('get-cached-extracted-audio', async (event, videoPath: string, forceRefresh: boolean = false) => {
  const cacheDir = computeAudioCacheDir(videoPath);
  const ensureDir = () => {
    try {
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    } catch {}
  };

  const checkExisting = (expected: number): string[] | null => {
    try {
      const files = Array.from({ length: expected }, (_, i) => path.join(cacheDir, `audio_track_${i}.wav`));
      for (const f of files) {
        if (!fs.existsSync(f)) return null;
        const s = fs.statSync(f);
        if (!s.isFile() || s.size <= 0) return null;
      }
      return files;
    } catch {
      return null;
    }
  };

  const cleanupCache = () => {
    try {
      if (fs.existsSync(cacheDir)) {
        const files = fs.readdirSync(cacheDir);
        for (const file of files) {
          try {
            fs.unlinkSync(path.join(cacheDir, file));
          } catch (e) {
            console.warn('[Audio Extract] Failed to delete cache file:', file, e);
          }
        }
      }
    } catch (e) {
      console.warn('[Audio Extract] Failed to cleanup cache dir:', e);
    }
  };

  if (forceRefresh) {
    console.log('[Audio Extract] Force refresh requested, cleaning cache');
    cleanupCache();
    audioExtractTasks.delete(cacheDir);
  }

  let task = audioExtractTasks.get(cacheDir);
  if (task) return await task;

  task = (async () => {
    try {
      ensureDir();
      const metadata = await ffprobeWithFullMetadata(videoPath);

      const audioStreams = (metadata.streams || []).filter((s: any) => s.codec_type === 'audio');
      const expected = audioStreams.length;
      if (expected <= 0) {
        return [];
      }

      const existing = checkExisting(expected);
      if (existing && !forceRefresh) {
        return existing;
      }

      // Clean up any corrupted cache files before extraction
      console.log('[Audio Extract] Cleaning up cache before extraction');
      cleanupCache();
      ensureDir();

      return new Promise<string[]>((resolve, reject) => {

        const outputs: string[] = Array.from({ length: expected }, (_, i) => path.join(cacheDir, `audio_track_${i}.wav`));

        let completed = 0;
        let hasError = false;

        audioStreams.forEach((stream: any, index: number) => {
          const outputFile = outputs[index];

          const cmd = ffmpeg(videoPath)
            .outputOptions([
              `-map 0:a:${index}`,
              '-acodec pcm_s16le',
              '-ar 48000',
              '-ac 2'
            ])
            .output(outputFile);

          let trackResolved = false;
          const timeout = setTimeout(() => {
            if (!trackResolved) {
              console.error(`[Audio Extract] Timeout on track ${index}`);
              cmd.kill('SIGKILL');
            }
          }, 30000);

          cmd
            .on('start', (commandLine) => {
              console.log(`[Audio Extract] Starting track ${index}:`, commandLine);
            })
            .on('end', () => {
              trackResolved = true;
              clearTimeout(timeout);
              completed++;
              console.log(`[Audio Extract] Completed track ${index} (${completed}/${expected})`);

              if (completed === expected && !hasError) {
                const allValid = outputs.every(f => {
                  try {
                    return fs.existsSync(f) && fs.statSync(f).size > 0;
                  } catch {
                    return false;
                  }
                });

                if (allValid) {
                  console.log('[Audio Extract] All tracks extracted successfully');
                  resolve(outputs);
                } else {
                  console.error('[Audio Extract] Some output files are invalid');
                  cleanupCache();
                  reject(new Error('Audio extraction produced invalid files'));
                }
              }
            })
            .on('error', (e, stdout, stderr) => {
              trackResolved = true;
              clearTimeout(timeout);

              if (!hasError) {
                hasError = true;
                console.error(`[Audio Extract] Failed on track ${index}:`, e.message);
                console.error('[Audio Extract] FFmpeg stderr:', stderr);
                cleanupCache();
                reject(new Error(`Audio extraction failed on track ${index}: ${e.message}`));
              }
            })
            .run();
        });
      });
    } catch (e) {
      cleanupCache();
      throw e;
    } finally {
      try { audioExtractTasks.delete(cacheDir); } catch {}
    }
  })();

  audioExtractTasks.set(cacheDir, task);
  return await task;
});

ipcMain.handle('generate-timeline-thumbnails', async (event, videoPath: string, outputDir: string, count: number = 10) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }

      const duration = metadata.format.duration || 0;
      const interval = duration / count;
      const timestamps = Array.from({ length: count }, (_, i) => i * interval);

      const thumbnails: string[] = [];

      ffmpeg(videoPath)
        .on('filenames', (filenames) => {
          thumbnails.push(...filenames.map(f => path.join(outputDir, f)));
        })
        .on('end', () => resolve(thumbnails))
        .on('error', (err) => reject(err))
        .screenshots({
          timestamps,
          folder: outputDir,
          filename: 'thumb-%i.png',
          size: '160x90'
        });
    });
  });
});

ipcMain.handle('export-video', async (
  event,
  inputPath: string,
  outputPath: string,
  startTime: number,
  endTime: number,
  quality: 'full' | 'compressed',
  audioTracks?: { index: number; volume: number }[],
  targetSizeMB?: number,
  jobId?: string,
  audioMode?: 'combine' | 'separate',
  outputType?: 'video' | 'mp3',
  compressionQuality: 'fast' | 'standard' | 'high' = 'standard'
) => {
  const duration = endTime - startTime;
  const meta: any = await new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, data) => resolve(data || { format: {}, streams: [] }));
  });
  const audioStreams = (meta.streams || []).filter((s: any) => s.codec_type === 'audio');
  const numAudioStreams = audioStreams.length;
  const getVolumeForIndex = (idx: number): number => {
    const found = (audioTracks || []).find(t => t.index === idx);
    return found ? (typeof found.volume === 'number' ? found.volume : 1.0) : 1.0;
  };

  const buildFilterAndMaps = (mode: 'combine' | 'separate', type: 'video' | 'mp3') => {
    const filterParts: string[] = [];
    const mapOptions: string[] = [];

    const useCombine = type === 'mp3' ? true : (mode === 'combine');

    if (type === 'video') {
      mapOptions.push('-map', '0:v:0');
    } else {
      mapOptions.push('-vn');
    }

    if (numAudioStreams <= 0) {
      return { filterParts, mapOptions };
    }

    if (useCombine) {
      const inputLabels: string[] = [];
      for (let i = 0; i < numAudioStreams; i++) {
        const vol = getVolumeForIndex(i);
        if (Math.abs(vol - 1.0) > 1e-6) {
          filterParts.push(`[0:a:${i}]volume=${vol}[a${i}]`);
          inputLabels.push(`[a${i}]`);
        } else {
          inputLabels.push(`[0:a:${i}]`);
        }
      }
      if (inputLabels.length === 1 && inputLabels[0] === '[0:a:0]') {
        mapOptions.push('-map', '0:a:0');
      } else {
        filterParts.push(`${inputLabels.join('')}amix=inputs=${inputLabels.length}:duration=longest[aout]`);
        mapOptions.push('-map', '[aout]');
      }
    } else {
      for (let i = 0; i < numAudioStreams; i++) {
        const vol = getVolumeForIndex(i);
        if (Math.abs(vol - 1.0) > 1e-6) {
          filterParts.push(`[0:a:${i}]volume=${vol}[a${i}]`);
          mapOptions.push('-map', `[a${i}]`);
        } else {
          mapOptions.push('-map', `0:a:${i}`);
        }
      }
    }

    return { filterParts, mapOptions };
  };

  // Get encoding preset based on compression quality
  const getPreset = (): string => {
    switch (compressionQuality) {
      case 'fast': return 'fast';
      case 'standard': return 'medium';
      case 'high': return 'veryslow';
      default: return 'medium';
    }
  };

  // Get CRF value based on compression quality (lower = better quality)
  const getCRF = (): number => {
    switch (compressionQuality) {
      case 'fast': return 23;
      case 'standard': return 21;
      case 'high': return 18; // Lower CRF for better quality (was 19)
      default: return 21;
    }
  };

  // Get advanced x264 parameters based on compression quality
  const getX264Params = (): string => {
    const baseParams = 'aq-mode=2:aq-strength=1.0';
    
    switch (compressionQuality) {
      case 'fast':
        return baseParams;
      case 'standard':
        // Light quality improvements without significant speed impact
        return `${baseParams}:subme=6:trellis=1:ref=3:bframes=3`;
      case 'high':
        // Maximum quality settings
        return `${baseParams}:aq-mode=3:aq-strength=1.2:me=umh:subme=9:trellis=2:ref=6:bframes=6:deblock=1,1:psy-rd=1.0:0.15`;
      default:
        return baseParams;
    }
  };

  const encodeOnce = (videoBitrateKbps?: number, useCRF: boolean = false) => {
    return new Promise<string | { status: 'canceled' }>((resolve, reject) => {
      let command = ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(duration);

      const type: 'video' | 'mp3' = outputType === 'mp3' ? 'mp3' : 'video';
      const outputExt = path.extname(outputPath).toLowerCase();

      if (type === 'mp3') {
        // Audio-only export - determine codec by extension
        if (outputExt === '.mp3') {
          command = command
            .audioCodec('libmp3lame')
            .outputOptions(['-y', '-b:a 192k']);
        } else if (outputExt === '.wav') {
          command = command
            .audioCodec('pcm_s16le')
            .outputOptions(['-y', '-ar 48000', '-ac 2']);
        } else if (outputExt === '.aac') {
          command = command
            .audioCodec('aac')
            .outputOptions(['-y', '-b:a 192k']);
        } else {
          // Default to mp3
          command = command
            .audioCodec('libmp3lame')
            .outputOptions(['-y', '-b:a 192k']);
        }
      } else if (quality === 'compressed') {
        const audioBitrateKbps = 128;
        if (!videoBitrateKbps) {
          videoBitrateKbps = 800;
        }

        // Video codec selection based on container
        let videoCodec = 'libx264';
        let audioCodec = 'aac';
        const preset = getPreset();
        const baseOptions = ['-y', `-preset ${preset}`];

        if (outputExt === '.avi') {
          videoCodec = 'mpeg4';
          audioCodec = 'libmp3lame';
        }

        const videoOptions: string[] = [...baseOptions];
        
        if (useCRF && outputExt !== '.avi') {
          // Use CRF mode for better quality
          const crf = getCRF();
          videoOptions.push(`-crf ${crf}`);
          // Set max bitrate as a safety limit
          videoOptions.push(`-maxrate ${Math.max(100, Math.floor(videoBitrateKbps * 1.2))}k`);
          videoOptions.push(`-bufsize ${Math.max(200, Math.floor(videoBitrateKbps * 2.5))}k`);
        } else {
          // Use target bitrate mode
          videoOptions.push(`-b:v ${videoBitrateKbps}k`);
          videoOptions.push(`-maxrate ${Math.max(100, Math.floor(videoBitrateKbps * 1.1))}k`);
          videoOptions.push(`-bufsize ${Math.max(200, Math.floor(videoBitrateKbps * 2))}k`);
        }

        // Add quality improvements for complex scenes
        if (outputExt !== '.avi') {
          videoOptions.push('-profile:v high');
          videoOptions.push('-level 4.0');
          // Better handling of motion and detail
          videoOptions.push('-tune film');
          // Advanced x264 parameters for better quality
          videoOptions.push(`-x264-params "${getX264Params()}"`);
        }

        videoOptions.push(`-b:a ${audioBitrateKbps}k`);
        
        // Add flags to prevent AAC encoding issues
        if (outputExt !== '.avi') {
          videoOptions.push('-shortest'); // Ensure audio and video end together
          videoOptions.push('-fflags +genpts'); // Generate presentation timestamps
        }

        command = command
          .videoCodec(videoCodec)
          .audioCodec(audioCodec)
          .outputOptions(videoOptions);

        if (outputExt === '.mp4' || outputExt === '.mov') {
          command = command.outputOptions(['-movflags +faststart']);
        }
      } else {
        // Full quality - copy video stream
        let audioCodec = 'aac';
        if (outputExt === '.avi') {
          audioCodec = 'libmp3lame';
        }

        command = command
          .outputOptions(['-c:v copy'])
          .audioCodec(audioCodec)
          .outputOptions(['-y']);

        if (outputExt === '.mp4' || outputExt === '.mov') {
          command = command.outputOptions(['-movflags +faststart']);
        }
      }

      const { filterParts, mapOptions } = buildFilterAndMaps(audioMode || 'combine', type);
      if (filterParts.length > 0) {
        command = command.complexFilter(filterParts.join(';'));
      }
      if (mapOptions.length > 0) {
        command = command.outputOptions(mapOptions);
      }

      command
        .output(outputPath)
        .on('progress', (progress) => {
          if (mainWindow) {
            try {
              mainWindow.webContents.send('export-progress', { ...progress, jobId });
            } catch {}
          }
        })
        .on('start', () => {
          try {
            activeExports.set(event.sender.id, command);
          } catch {}
        })
        .on('end', () => {
          try { activeExports.delete(event.sender.id); } catch {}
          resolve(outputPath);
        })
        .on('error', (err, stdout, stderr) => {
          const senderId = event.sender.id;
          const msg = (err && err.message) ? err.message : 'Unknown error';
          const wasCanceled = canceledExports.has(senderId) || /kill|SIGKILL|terminated|canceled/i.test(msg);
          try { activeExports.delete(senderId); } catch {}
          if (wasCanceled) {
            try { canceledExports.delete(senderId); } catch {}
            resolve({ status: 'canceled' });
          } else {
            console.error('Export error:', err);
            console.error('FFmpeg stderr:', stderr);
            reject(new Error(`Export failed: ${msg}\n${stderr}`));
          }
        })
        .run();
    });
  };

  // Two-pass encoding for high quality mode
  const encodeTwoPass = (videoBitrateKbps: number): Promise<string | { status: 'canceled' }> => {
    return new Promise(async (resolve, reject) => {
      const outputExt = path.extname(outputPath).toLowerCase();
      const preset = getPreset();
      const audioBitrateKbps = 128;
      const tempLogFile = path.join(os.tmpdir(), `ffmpeg2pass_${Date.now()}.log`);

      // Video codec selection
      let videoCodec = 'libx264';
      let audioCodec = 'aac';
      if (outputExt === '.avi') {
        // AVI doesn't support two-pass well, fall back to single pass
        return encodeOnce(videoBitrateKbps, false).then(resolve).catch(reject);
      }

      const { filterParts, mapOptions } = buildFilterAndMaps(audioMode || 'combine', 'video');

      // First pass: analyze video
      // Use video filter for trimming to ensure two-pass encoding works correctly
      const trimFilter = `[0:v]trim=start=${startTime}:duration=${duration},setpts=PTS-STARTPTS[v]`;
      const firstPassOptions = [
        '-y',
        `-preset ${preset}`,
        `-b:v ${videoBitrateKbps}k`,
        `-maxrate ${Math.max(100, Math.floor(videoBitrateKbps * 1.1))}k`,
        `-bufsize ${Math.max(200, Math.floor(videoBitrateKbps * 2))}k`,
        '-profile:v high',
        '-level 4.0',
        '-tune film',
        `-x264-params "${getX264Params()}"`,
        '-pass 1',
        '-passlogfile', tempLogFile,
        '-an', // No audio in first pass
        '-f null'
      ];

      // Use video filter for trimming (more reliable for two-pass encoding)
      let firstPassCommand = ffmpeg(inputPath)
        .videoCodec(videoCodec)
        .complexFilter([trimFilter])
        .outputOptions(['-map', '[v]']) // Map the trimmed video
        .outputOptions(firstPassOptions)
        .output('NUL'); // Windows null device

      // Note: Audio filters are not needed in first pass since we use -an

      try {
        await new Promise<void>((resolvePass, rejectPass) => {
          const senderId = event.sender.id;
          firstPassCommand
            .on('start', () => {
              try {
                activeExports.set(senderId, firstPassCommand);
              } catch {}
            })
            .on('end', () => {
              try { activeExports.delete(senderId); } catch {}
              // Verify log file was created successfully
              const logFile = `${tempLogFile}-0.log`;
              if (!fs.existsSync(logFile)) {
                rejectPass(new Error('First pass completed but log file was not created'));
                return;
              }
              resolvePass();
            })
            .on('error', (err, stdout, stderr) => {
              try { activeExports.delete(senderId); } catch {}
              const msg = (err && err.message) ? err.message : 'Unknown error';
              const wasCanceled = canceledExports.has(senderId) || /kill|SIGKILL|terminated|canceled/i.test(msg);
              if (wasCanceled) {
                try { canceledExports.delete(senderId); } catch {}
                rejectPass({ status: 'canceled' });
              } else {
                console.error('First pass error:', err);
                rejectPass(new Error(`First pass failed: ${msg}\n${stderr}`));
              }
            })
            .on('progress', (progress) => {
              if (mainWindow) {
                try {
                  // Report first pass as 0-50% progress
                  const adjustedProgress = { ...progress, percent: (progress.percent || 0) * 0.5 };
                  mainWindow.webContents.send('export-progress', { ...adjustedProgress, jobId });
                } catch {}
              }
            })
            .run();
        });

        // Check for cancellation
        if (canceledExports.has(event.sender.id)) {
          try {
            if (fs.existsSync(tempLogFile)) fs.unlinkSync(tempLogFile);
          } catch {}
          return resolve({ status: 'canceled' });
        }

        // Verify first pass log file exists and is valid before proceeding
        const logFile = `${tempLogFile}-0.log`;
        const mbtreeFile = `${tempLogFile}-0.log.mbtree`;
        
        // Wait a bit for file system to sync
        await new Promise(resolve => setTimeout(resolve, 100));
        
        if (!fs.existsSync(logFile)) {
          const errorMsg = 'First pass log file not found. First pass may have failed silently.';
          console.error(errorMsg);
          try {
            if (fs.existsSync(tempLogFile)) fs.unlinkSync(tempLogFile);
          } catch {}
          return reject(new Error(errorMsg));
        }
        
        // Check if log file has reasonable size (at least 1KB)
        try {
          const logStats = fs.statSync(logFile);
          if (logStats.size < 1024) {
            const errorMsg = `First pass log file is too small (${logStats.size} bytes). First pass may not have completed properly.`;
            console.error(errorMsg);
            try {
              if (fs.existsSync(tempLogFile)) fs.unlinkSync(tempLogFile);
              if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
              if (fs.existsSync(mbtreeFile)) fs.unlinkSync(mbtreeFile);
            } catch {}
            return reject(new Error(errorMsg));
          }
        } catch (err) {
          console.warn('Could not check log file size:', err);
        }

        // Second pass: encode with audio
        // Build filter chain: trim audio tracks first, then apply volume/mixing
        const allFilters: string[] = [trimFilter]; // Start with video trim
        
        if (numAudioStreams > 0) {
          // Trim each audio track
          const trimmedAudioLabels: string[] = [];
          for (let i = 0; i < numAudioStreams; i++) {
            const label = `at${i}`;
            allFilters.push(`[0:a:${i}]atrim=start=${startTime}:duration=${duration},asetpts=PTS-STARTPTS[${label}]`);
            trimmedAudioLabels.push(`[${label}]`);
          }
          
          // Apply volume adjustments and mixing
          const useCombine = audioMode === 'combine';
          if (useCombine) {
            // Apply volume to each track, then mix
            const volumeAdjustedLabels: string[] = [];
            for (let i = 0; i < numAudioStreams; i++) {
              const vol = getVolumeForIndex(i);
              if (Math.abs(vol - 1.0) > 1e-6) {
                const volLabel = `av${i}`;
                allFilters.push(`${trimmedAudioLabels[i]}volume=${vol}[${volLabel}]`);
                volumeAdjustedLabels.push(`[${volLabel}]`);
              } else {
                volumeAdjustedLabels.push(trimmedAudioLabels[i]);
              }
            }
            if (volumeAdjustedLabels.length === 1) {
              // Single track, no mixing needed - use it directly
              allFilters.push(`${volumeAdjustedLabels[0]}anull[aout]`);
            } else {
              allFilters.push(`${volumeAdjustedLabels.join('')}amix=inputs=${volumeAdjustedLabels.length}:duration=longest[aout]`);
            }
          } else {
            // Keep tracks separate with volume adjustments
            for (let i = 0; i < numAudioStreams; i++) {
              const vol = getVolumeForIndex(i);
              if (Math.abs(vol - 1.0) > 1e-6) {
                allFilters.push(`${trimmedAudioLabels[i]}volume=${vol}[a${i}]`);
              } else {
                // Volume is 1.0, use trimmed audio directly
                allFilters.push(`${trimmedAudioLabels[i]}anull[a${i}]`);
              }
            }
          }
        }
        
        const secondPassOptions = [
          '-y',
          `-preset ${preset}`,
          `-b:v ${videoBitrateKbps}k`,
          `-maxrate ${Math.max(100, Math.floor(videoBitrateKbps * 1.1))}k`,
          `-bufsize ${Math.max(200, Math.floor(videoBitrateKbps * 2))}k`,
          '-profile:v high',
          '-level 4.0',
          '-tune film',
          `-x264-params "${getX264Params()}"`,
          '-pass 2',
          '-passlogfile', tempLogFile,
          `-b:a ${audioBitrateKbps}k`,
          '-fflags +genpts' // Generate presentation timestamps for better sync
        ];

        if (outputExt === '.mp4' || outputExt === '.mov') {
          secondPassOptions.push('-movflags +faststart');
        }

        // Use the same video filter for trimming as first pass, plus audio filters
        let secondPassCommand = ffmpeg(inputPath)
          .videoCodec(videoCodec)
          .audioCodec(audioCodec)
          .complexFilter(allFilters)
          .outputOptions(['-map', '[v]']) // Map the trimmed video
          .outputOptions(secondPassOptions)
          .output(outputPath);

        // Add audio mapping
        if (audioMode === 'combine' && numAudioStreams > 0) {
          secondPassCommand = secondPassCommand.outputOptions(['-map', '[aout]']);
        } else if (audioMode === 'separate' && numAudioStreams > 0) {
          for (let i = 0; i < numAudioStreams; i++) {
            secondPassCommand = secondPassCommand.outputOptions(['-map', `[a${i}]`]);
          }
        }

        secondPassCommand
          .on('start', () => {
            try {
              activeExports.set(event.sender.id, secondPassCommand);
            } catch {}
          })
          .on('end', () => {
            try {
              activeExports.delete(event.sender.id);
              // Clean up log file
              try {
                if (fs.existsSync(tempLogFile)) fs.unlinkSync(tempLogFile);
                if (fs.existsSync(`${tempLogFile}-0.log`)) fs.unlinkSync(`${tempLogFile}-0.log`);
                if (fs.existsSync(`${tempLogFile}-0.log.mbtree`)) fs.unlinkSync(`${tempLogFile}-0.log.mbtree`);
              } catch {}
            } catch {}
            resolve(outputPath);
          })
          .on('error', (err, stdout, stderr) => {
            const senderId = event.sender.id;
            const msg = (err && err.message) ? err.message : 'Unknown error';
            const wasCanceled = canceledExports.has(senderId) || /kill|SIGKILL|terminated|canceled/i.test(msg);
            
            // Check if this is a non-critical AAC warning about frames in queue
            const isAACQueueWarning = /frames left in the queue|Qavg/i.test(stderr || '') && 
                                     !/error|failed|invalid/i.test(stderr || '');
            
            // If output file exists and is valid, treat AAC queue warnings as non-fatal
            if (isAACQueueWarning && fs.existsSync(outputPath)) {
              try {
                const stats = fs.statSync(outputPath);
                if (stats.size > 0) {
                  console.warn('AAC queue warning detected but file exists, treating as success:', stderr);
                  try {
                    activeExports.delete(senderId);
                    // Clean up log file
                    try {
                      if (fs.existsSync(tempLogFile)) fs.unlinkSync(tempLogFile);
                      if (fs.existsSync(`${tempLogFile}-0.log`)) fs.unlinkSync(`${tempLogFile}-0.log`);
                      if (fs.existsSync(`${tempLogFile}-0.log.mbtree`)) fs.unlinkSync(`${tempLogFile}-0.log.mbtree`);
                    } catch {}
                  } catch {}
                  return resolve(outputPath);
                }
              } catch {}
            }
            
            try {
              activeExports.delete(senderId);
              // Clean up log file
              try {
                if (fs.existsSync(tempLogFile)) fs.unlinkSync(tempLogFile);
                if (fs.existsSync(`${tempLogFile}-0.log`)) fs.unlinkSync(`${tempLogFile}-0.log`);
                if (fs.existsSync(`${tempLogFile}-0.log.mbtree`)) fs.unlinkSync(`${tempLogFile}-0.log.mbtree`);
              } catch {}
            } catch {}
            if (wasCanceled) {
              try { canceledExports.delete(senderId); } catch {}
              resolve({ status: 'canceled' });
            } else {
              console.error('Second pass error:', err);
              console.error('FFmpeg stderr:', stderr);
              reject(new Error(`Second pass failed: ${msg}\n${stderr}`));
            }
          })
          .on('progress', (progress) => {
            if (mainWindow) {
              try {
                // Report second pass as 50-100% progress
                const adjustedProgress = { ...progress, percent: 50 + ((progress.percent || 0) * 0.5) };
                mainWindow.webContents.send('export-progress', { ...adjustedProgress, jobId });
              } catch {}
            }
          })
          .run();
      } catch (err: any) {
        try {
          if (fs.existsSync(tempLogFile)) fs.unlinkSync(tempLogFile);
        } catch {}
        if (err && typeof err === 'object' && (err as any).status === 'canceled') {
          return resolve({ status: 'canceled' });
        }
        reject(err);
      }
    });
  };

  if (outputType === 'mp3' || quality !== 'compressed') {
    return await encodeOnce();
  }

  // Compressed with size target: improved bitrate calculation and encoding
  const targetMB = targetSizeMB || 10;
  const targetBytes = targetMB * 1024 * 1024;
  // Safety ratio to aim for ~95% of target (e.g., 9.5MB for 10MB target)
  const safetyRatio = 0.95;
  const audioBitrateKbps = 128; // estimate audio bitrate (combined)
  const targetBits = Math.max(1, Math.floor(targetBytes * safetyRatio * 8));
  // Calculate video bitrate more accurately, accounting for container overhead
  const containerOverhead = 0.02; // 2% overhead for container format
  const effectiveTargetBits = Math.floor(targetBits * (1 - containerOverhead));
  let videoBitrateKbps = Math.max(100, Math.floor(effectiveTargetBits / duration / 1000) - audioBitrateKbps);

  // Use two-pass encoding for high quality mode
  if (compressionQuality === 'high') {
    const result = await encodeTwoPass(videoBitrateKbps);
    if (typeof result === 'object' && (result as any).status === 'canceled') {
      return result;
    }

    // Verify size and adjust if needed
    try {
      let size = fs.statSync(outputPath).size;
      let attempts = 0;
      const maxAttempts = 3;
      
      while (size > targetBytes && attempts < maxAttempts) {
        attempts++;
        // Reduce bitrate more aggressively
        videoBitrateKbps = Math.max(100, Math.floor(videoBitrateKbps * 0.80));
        try {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
        } catch {}
        
        const retryResult = await encodeTwoPass(videoBitrateKbps);
        if (typeof retryResult === 'object' && (retryResult as any).status === 'canceled') {
          return retryResult;
        }
        size = fs.statSync(outputPath).size;
      }
    } catch (err) {
      console.warn('Could not validate/adjust output size:', err);
    }

    return outputPath;
  }

  // Single-pass encoding for fast and standard modes
  // Try CRF mode first for standard quality (better quality/size ratio)
  let useCRF = compressionQuality === 'standard';
  let firstResult = await encodeOnce(videoBitrateKbps, useCRF);
  if (typeof firstResult === 'object' && (firstResult as any).status === 'canceled') {
    return firstResult;
  }

  try {
    let size = fs.statSync(outputPath).size;
    let attempts = 0;
    const maxAttempts = 3;
    
    while (size > targetBytes && attempts < maxAttempts) {
      attempts++;
      // If CRF mode was used and overshoot, switch to bitrate mode
      if (useCRF && attempts === 1) {
        useCRF = false;
        // Recalculate bitrate more conservatively
        videoBitrateKbps = Math.max(100, Math.floor(videoBitrateKbps * 0.85));
      } else {
        // Reduce bitrate progressively
        videoBitrateKbps = Math.max(100, Math.floor(videoBitrateKbps * 0.85));
      }
      
      try {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      } catch {}
      
      const retryResult = await encodeOnce(videoBitrateKbps, useCRF);
      if (typeof retryResult === 'object' && (retryResult as any).status === 'canceled') {
        return retryResult;
      }
      size = fs.statSync(outputPath).size;
    }
  } catch (err) {
    console.warn('Could not validate/adjust output size:', err);
  }

  return outputPath;
});

ipcMain.handle('cancel-export', async (event) => {
  const senderId = event.sender.id;
  const cmd = activeExports.get(senderId);
  if (cmd) {
    try {
      canceledExports.add(senderId);
      cmd.kill('SIGKILL');
    } catch {}
    try {
      activeExports.delete(senderId);
    } catch {}
  }
  return true;
});

ipcMain.handle('start-drag', async (event, payload: { filePath: string; iconPath?: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  const { filePath, iconPath } = payload || ({} as any);

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Drag file does not exist');
  }

  let iconImg;
  try {
    if (iconPath && fs.existsSync(iconPath)) {
      iconImg = nativeImage.createFromPath(iconPath);
      const size = 256;
      iconImg = iconImg.resize({ width: size, height: size, quality: 'best' });
    }

    if (!iconImg || iconImg.isEmpty()) {
      const transparentPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
      iconImg = nativeImage.createFromDataURL(`data:image/png;base64,${transparentPngBase64}`);
    }
  } catch (err) {
    console.error('Error creating drag icon:', err);
    const transparentPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
    iconImg = nativeImage.createFromDataURL(`data:image/png;base64,${transparentPngBase64}`);
  }

  win.webContents.startDrag({
    file: filePath,
    icon: iconImg
  });
});

// Get content hash for a clip
ipcMain.handle('get-clip-hash', async (event, filepath: string, duration?: number | null) => {
  try {
    const hash = await db.getClipHash(filepath, duration);
    return hash;
  } catch (error) {
    console.error('Error getting clip hash:', error);
    throw error;
  }
});

// Save clip edits (trim points, audio tracks)
ipcMain.handle('save-clip-edits', async (event, data: {
  contentHash: string;
  filepath: string;
  fileSize: number;
  duration: number | null;
  edits: db.ClipEdits;
}) => {
  try {
    db.saveClipEdits(
      data.contentHash,
      data.filepath,
      data.fileSize,
      data.duration,
      data.edits
    );
    return { success: true };
  } catch (error) {
    console.error('Error saving clip edits:', error);
    throw error;
  }
});

// Get saved edits for a clip
ipcMain.handle('get-clip-edits', async (event, contentHash: string) => {
  try {
    const edits = db.getClipEdits(contentHash);
    return edits;
  } catch (error) {
    console.error('Error getting clip edits:', error);
    throw error;
  }
});

// Toggle favorite status
ipcMain.handle('toggle-favorite', async (event, data: {
  contentHash: string;
  filepath: string;
  fileSize: number;
  duration: number | null;
}) => {
  try {
    const isFavorite = db.toggleFavorite(
      data.contentHash,
      data.filepath,
      data.fileSize,
      data.duration
    );
    return { isFavorite };
  } catch (error) {
    console.error('Error toggling favorite:', error);
    throw error;
  }
});

// Check if clip is favorited
ipcMain.handle('is-favorite', async (event, contentHash: string) => {
  try {
    const favorite = db.isFavorite(contentHash);
    return favorite;
  } catch (error) {
    console.error('Error checking favorite status:', error);
    return false;
  }
});

// Get all favorited clips
ipcMain.handle('get-all-favorites', async () => {
  try {
    const favorites = db.getAllFavorites();
    return favorites;
  } catch (error) {
    console.error('Error getting favorites:', error);
    return [];
  }
});

// Get file stats
ipcMain.handle('get-file-stats', async (event, filePath: string) => {
  try {
    const stat = fs.statSync(filePath);
    const fileName = path.basename(filePath);

    // Find the base folder this file belongs to
    let relativePath = fileName;
    let folderPath = '';

    for (const [watchedFolder] of watchedBaseFolders) {
      if (filePath.startsWith(watchedFolder)) {
        relativePath = path.relative(watchedFolder, filePath);
        const folderName = path.dirname(relativePath);
        folderPath = folderName === '.' ? '' : folderName;
        break;
      }
    }

    return {
      name: fileName,
      size: stat.size,
      created: stat.birthtime,
      modified: stat.mtime,
      relativePath,
      folderPath,
    };
  } catch (error) {
    console.error('Error getting file stats:', error);
    return null;
  }
});

// Watch a folder for changes
ipcMain.handle('watch-folder', async (event, folderPath: string) => {
  try {
    // Don't watch if already watching
    if (folderWatchers.has(folderPath)) {
      console.log('[FileWatcher] Already watching:', folderPath);
      return;
    }

    console.log('[FileWatcher] Starting watch on:', folderPath);
    watchedBaseFolders.set(folderPath, folderPath);

    // Track existing files
    const existingFiles = new Set<string>();
    const scanExistingFiles = (dir: string) => {
      try {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            scanExistingFiles(fullPath);
          } else {
            const ext = path.extname(file).toLowerCase();
            if (videoExtensions.includes(ext)) {
              existingFiles.add(fullPath);
            }
          }
        });
      } catch (error) {
        console.error('Error scanning directory:', error);
      }
    };
    scanExistingFiles(folderPath);

    // Debounce timers for each file path
    const debounceTimers = new Map<string, NodeJS.Timeout>();

    // Watch folder recursively
    const watcher = fs.watch(folderPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      const fullPath = path.join(folderPath, filename);
      const ext = path.extname(filename).toLowerCase();

      // Only handle video files
      if (!videoExtensions.includes(ext)) return;

      console.log(`[FileWatcher] Event: ${eventType}, File: ${filename}, Full path: ${fullPath}`);

      // Clear existing timer for this file
      const existingTimer = debounceTimers.get(fullPath);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set new timer - only process after events stop
      const timer = setTimeout(async () => {
        try {
          debounceTimers.delete(fullPath);

          // Check if file exists and is readable
          const fileExists = fs.existsSync(fullPath);
          const wasTracked = existingFiles.has(fullPath);

          console.log(`[FileWatcher] Processing: exists=${fileExists}, wasTracked=${wasTracked}, path=${fullPath}`);

          if (fileExists && !wasTracked) {
            // Verify file is readable and has size > 0
            try {
              const stat = fs.statSync(fullPath);
              if (stat.size === 0) {
                console.log('[FileWatcher] File has 0 size, ignoring...', fullPath);
                return;
              }

              // Check file stability - wait 200ms and verify size hasn't changed
              const initialSize = stat.size;
              await new Promise(resolve => setTimeout(resolve, 200));
              const newStat = fs.statSync(fullPath);

              if (newStat.size !== initialSize) {
                console.log('[FileWatcher] File is still being written, will retry...', fullPath);
                return;
              }

              console.log('[FileWatcher] New file detected, adding to library:', fullPath);
              existingFiles.add(fullPath);
              if (mainWindow) {
                mainWindow.webContents.send('file-added', { filePath: fullPath });
              }
            } catch (err) {
              console.log('[FileWatcher] File not readable yet:', fullPath, err);
            }
          } else if (!fileExists && wasTracked) {
            // File removed
            console.log('[FileWatcher] File removed from library:', fullPath);
            existingFiles.delete(fullPath);
            if (mainWindow) {
              mainWindow.webContents.send('file-removed', { filePath: fullPath });
            }
          }
        } catch (error) {
          console.error('[FileWatcher] Error processing event:', error);
        }
      }, 500);

      debounceTimers.set(fullPath, timer);
    });

    folderWatchers.set(folderPath, watcher);
  } catch (error) {
    console.error('Error watching folder:', error);
  }
});

// Stop watching a folder
ipcMain.handle('unwatch-folder', async (event, folderPath: string) => {
  const watcher = folderWatchers.get(folderPath);
  if (watcher) {
    console.log('[FileWatcher] Stopping watch on:', folderPath);
    watcher.close();
    folderWatchers.delete(folderPath);
  }
});

// Move files to trash
ipcMain.handle('trash-files', async (event, filePaths: string[]) => {
  try {
    const results: Array<{ path: string; success: boolean; error?: string }> = [];
    for (const filePath of filePaths) {
      try {
        await shell.trashItem(filePath);
        console.log('[Trash] Moved to trash:', filePath);
        results.push({ path: filePath, success: true });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[Trash] Failed to trash file:', filePath, error);
        results.push({ path: filePath, success: false, error: errorMessage });
      }
    }

    // Check if any failed
    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
      throw new Error(`Failed to trash ${failed.length} file(s): ${failed.map(f => f.path).join(', ')}`);
    }

    return { success: true, count: results.length };
  } catch (error) {
    console.error('[Trash] Error in trash-files handler:', error);
    throw error;
  }
});

// Secure file reading handlers

// Read file and return as data URL (for images)
ipcMain.handle('read-file-as-data-url', async (event, filePath: string) => {
  try {
    // Validate the file path is from a trusted location
    const tmpDir = os.tmpdir();
    const normalizedPath = path.normalize(filePath);

    let isAllowed = normalizedPath.startsWith(tmpDir);

    // Also allow access to watched folders
    if (!isAllowed) {
      for (const [watchedFolder] of watchedBaseFolders) {
        if (normalizedPath.startsWith(path.normalize(watchedFolder))) {
          isAllowed = true;
          break;
        }
      }
    }

    if (!isAllowed) {
      throw new Error('Access denied: File is not in a trusted location');
    }

    if (!fs.existsSync(normalizedPath)) {
      throw new Error('File not found');
    }

    // Read file and convert to base64
    const fileBuffer = fs.readFileSync(normalizedPath);
    const base64 = fileBuffer.toString('base64');

    // Determine MIME type from extension
    const ext = path.extname(normalizedPath).toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml'
    };

    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error('[read-file-as-data-url] Error:', error);
    throw error;
  }
});

// Read file and return as buffer (for audio files)
ipcMain.handle('read-file-buffer', async (event, filePath: string) => {
  try {
    // Validate the file path is from a trusted location
    const tmpDir = os.tmpdir();
    const normalizedPath = path.normalize(filePath);

    let isAllowed = normalizedPath.startsWith(tmpDir);

    // Also allow access to watched folders
    if (!isAllowed) {
      for (const [watchedFolder] of watchedBaseFolders) {
        if (normalizedPath.startsWith(path.normalize(watchedFolder))) {
          isAllowed = true;
          break;
        }
      }
    }

    if (!isAllowed) {
      throw new Error('Access denied: File is not in a trusted location');
    }

    if (!fs.existsSync(normalizedPath)) {
      throw new Error('File not found');
    }

    // Read file as buffer
    const fileBuffer = fs.readFileSync(normalizedPath);
    return fileBuffer;
  } catch (error) {
    console.error('[read-file-buffer] Error:', error);
    throw error;
  }
});

// Clear all app caches
ipcMain.handle('clear-cache', async () => {
  try {
    const tmpDir = os.tmpdir();
    const cacheDirs = [
      path.join(tmpDir, 'vcm-meta'),
      path.join(tmpDir, 'vcm-thumbs'),
      path.join(tmpDir, 'vcm-audio')
    ];

    let totalCleared = 0;
    let errors: string[] = [];

    // Clear each cache directory
    for (const cacheDir of cacheDirs) {
      try {
        if (fs.existsSync(cacheDir)) {
          const files = fs.readdirSync(cacheDir);
          for (const file of files) {
            try {
              const filePath = path.join(cacheDir, file);
              const stat = fs.statSync(filePath);
              if (stat.isDirectory()) {
                // Recursively delete subdirectories
                fs.rmSync(filePath, { recursive: true, force: true });
              } else {
                fs.unlinkSync(filePath);
              }
              totalCleared++;
            } catch (fileError) {
              const errorMsg = `Failed to delete ${file}: ${fileError instanceof Error ? fileError.message : String(fileError)}`;
              errors.push(errorMsg);
              console.warn('[Cache Clear]', errorMsg);
            }
          }
        }
      } catch (dirError) {
        const errorMsg = `Failed to access cache directory ${cacheDir}: ${dirError instanceof Error ? dirError.message : String(dirError)}`;
        errors.push(errorMsg);
        console.warn('[Cache Clear]', errorMsg);
      }
    }

    // Clear in-memory caches
    metadataMemoryCache.clear();
    metaTasks.clear();
    thumbTasks.clear();
    audioExtractTasks.clear();

    console.log(`[Cache Clear] Cleared ${totalCleared} cache files`);
    
    return {
      success: true,
      filesCleared: totalCleared,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (error) {
    console.error('[Cache Clear] Error clearing cache:', error);
    throw error;
  }
});
