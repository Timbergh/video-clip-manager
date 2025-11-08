import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import ffmpeg from 'fluent-ffmpeg';

// Database instance
let db: Database.Database | null = null;

// Types
export interface ClipEdits {
  trimStart?: number;
  trimEnd?: number;
  audioTracks?: AudioTrackEdit[];
}

export interface AudioTrackEdit {
  index: number;
  volume: number;
  isMuted: boolean;
}

export interface ClipRecord {
  contentHash: string;
  filepath: string;
  fileSize: number;
  duration: number | null;
  isFavorite: number;
  trimStart: number | null;
  trimEnd: number | null;
  audioTracks: string | null;
  updatedAt: string;
}

/**
 * Initialize the database and create tables if they don't exist
 */
export function initDatabase(): void {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'vcm.db');

  console.log('[Database] Initializing database at:', dbPath);

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS clips (
      contentHash TEXT PRIMARY KEY,
      filepath TEXT NOT NULL,
      fileSize INTEGER NOT NULL,
      duration REAL,
      isFavorite INTEGER DEFAULT 0,
      trimStart REAL,
      trimEnd REAL,
      audioTracks TEXT,
      updatedAt TEXT NOT NULL
    )
  `);

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_filepath ON clips(filepath);
    CREATE INDEX IF NOT EXISTS idx_favorite ON clips(isFavorite);
  `);

  console.log('[Database] Database initialized successfully');
}

/**
 * Calculate a partial content hash for a video file
 * Uses first 64KB + file size + duration for fast, reliable tracking
 */
export function calculatePartialHash(
  filepath: string,
  fileSize: number,
  duration: number | null
): Promise<string> {
  return new Promise((resolve, reject) => {
    const CHUNK_SIZE = 64 * 1024; // 64KB

    // Read first 64KB of the file
    const buffer = Buffer.alloc(CHUNK_SIZE);

    fs.open(filepath, 'r', (err, fd) => {
      if (err) {
        return reject(err);
      }

      fs.read(fd, buffer, 0, CHUNK_SIZE, 0, (err, bytesRead) => {
        fs.close(fd, () => {});

        if (err) {
          return reject(err);
        }

        // Create hash from: first64KB + fileSize + duration
        const hash = crypto.createHash('sha256');
        hash.update(buffer.slice(0, bytesRead));
        hash.update(String(fileSize));
        hash.update(String(duration || 0));

        resolve(hash.digest('hex'));
      });
    });
  });
}

/**
 * Get duration of a video file using ffprobe
 */
export function getVideoDuration(filepath: string): Promise<number | null> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filepath, (err, metadata) => {
      if (err || !metadata.format.duration) {
        resolve(null);
      } else {
        resolve(metadata.format.duration);
      }
    });
  });
}

/**
 * Calculate content hash for a clip (with duration lookup)
 */
export async function getClipHash(filepath: string, duration?: number | null): Promise<string> {
  const stats = fs.statSync(filepath);
  // Use provided duration if available, otherwise lookup
  const dur = duration !== undefined ? duration : await getVideoDuration(filepath);
  return calculatePartialHash(filepath, stats.size, dur);
}

/**
 * Save or update clip edits
 */
export function saveClipEdits(
  contentHash: string,
  filepath: string,
  fileSize: number,
  duration: number | null,
  edits: ClipEdits
): void {
  if (!db) throw new Error('Database not initialized');

  const stmt = db.prepare(`
    INSERT INTO clips (contentHash, filepath, fileSize, duration, trimStart, trimEnd, audioTracks, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contentHash) DO UPDATE SET
      filepath = excluded.filepath,
      fileSize = excluded.fileSize,
      duration = excluded.duration,
      trimStart = excluded.trimStart,
      trimEnd = excluded.trimEnd,
      audioTracks = excluded.audioTracks,
      updatedAt = excluded.updatedAt
  `);

  stmt.run(
    contentHash,
    filepath,
    fileSize,
    duration,
    edits.trimStart ?? null,
    edits.trimEnd ?? null,
    edits.audioTracks ? JSON.stringify(edits.audioTracks) : null,
    new Date().toISOString()
  );
}

/**
 * Get clip edits by content hash
 */
export function getClipEdits(contentHash: string): ClipEdits | null {
  if (!db) throw new Error('Database not initialized');

  const stmt = db.prepare(`
    SELECT trimStart, trimEnd, audioTracks
    FROM clips
    WHERE contentHash = ?
  `);

  const row = stmt.get(contentHash) as {
    trimStart: number | null;
    trimEnd: number | null;
    audioTracks: string | null;
  } | undefined;

  if (!row) return null;

  const edits: ClipEdits = {};

  if (row.trimStart !== null) edits.trimStart = row.trimStart;
  if (row.trimEnd !== null) edits.trimEnd = row.trimEnd;
  if (row.audioTracks) {
    try {
      edits.audioTracks = JSON.parse(row.audioTracks);
    } catch (e) {
      console.error('[Database] Failed to parse audioTracks JSON:', e);
    }
  }

  return edits;
}

/**
 * Toggle favorite status for a clip
 */
export function toggleFavorite(
  contentHash: string,
  filepath: string,
  fileSize: number,
  duration: number | null
): boolean {
  if (!db) throw new Error('Database not initialized');

  // First check if clip exists
  const existingStmt = db.prepare('SELECT isFavorite FROM clips WHERE contentHash = ?');
  const existing = existingStmt.get(contentHash) as { isFavorite: number } | undefined;

  if (existing) {
    // Toggle existing favorite status
    const newStatus = existing.isFavorite === 1 ? 0 : 1;
    const updateStmt = db.prepare(`
      UPDATE clips
      SET isFavorite = ?, updatedAt = ?
      WHERE contentHash = ?
    `);
    updateStmt.run(newStatus, new Date().toISOString(), contentHash);
    return newStatus === 1;
  } else {
    // Create new record with favorite = true
    const insertStmt = db.prepare(`
      INSERT INTO clips (contentHash, filepath, fileSize, duration, isFavorite, updatedAt)
      VALUES (?, ?, ?, ?, 1, ?)
    `);
    insertStmt.run(contentHash, filepath, fileSize, duration, new Date().toISOString());
    return true;
  }
}

/**
 * Check if a clip is favorited
 */
export function isFavorite(contentHash: string): boolean {
  if (!db) throw new Error('Database not initialized');

  const stmt = db.prepare('SELECT isFavorite FROM clips WHERE contentHash = ?');
  const row = stmt.get(contentHash) as { isFavorite: number } | undefined;

  return row ? row.isFavorite === 1 : false;
}

/**
 * Get all favorited clips
 */
export function getAllFavorites(): ClipRecord[] {
  if (!db) throw new Error('Database not initialized');

  const stmt = db.prepare(`
    SELECT * FROM clips WHERE isFavorite = 1
    ORDER BY updatedAt DESC
  `);

  return stmt.all() as ClipRecord[];
}

/**
 * Get all clips (with edits and favorite status)
 */
export function getAllClips(): ClipRecord[] {
  if (!db) throw new Error('Database not initialized');

  const stmt = db.prepare('SELECT * FROM clips ORDER BY updatedAt DESC');
  return stmt.all() as ClipRecord[];
}

/**
 * Update filepath for a clip (when file is moved/renamed)
 */
export function updateFilepath(contentHash: string, newFilepath: string): void {
  if (!db) throw new Error('Database not initialized');

  const stmt = db.prepare(`
    UPDATE clips
    SET filepath = ?, updatedAt = ?
    WHERE contentHash = ?
  `);

  stmt.run(newFilepath, new Date().toISOString(), contentHash);
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log('[Database] Database closed');
  }
}
