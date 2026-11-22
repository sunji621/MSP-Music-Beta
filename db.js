/**
 * 本地曲库数据库（SQLite / sql.js）
 *
 * 设计目标：
 * - 曲库扫描结果跨重启持久化，避免每次启动重新遍历整个磁盘
 * - 为后续收藏、播放历史、歌单、元数据检索提供统一的 SQL 存储
 * - 不改变现有渲染层协议：扫描仍返回原来的文件描述符数组
 *
 * 使用 sql.js（SQLite 的 WebAssembly 构建），避免 better-sqlite3 在
 * Electron ABI 下需要重新编译原生模块的问题。数据库文件是标准 SQLite
 * 文件，可以用 DB Browser for SQLite 直接打开。
 */

const fs = require('fs');
const path = require('path');

const DB_FILENAME = 'music-library.db';
const SAVE_DEBOUNCE_MS = 1200;

let SQL = null;
let db = null;
let dbPath = '';
let saveTimer = null;
let dirty = false;
let initialized = false;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function ensureSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS tracks (
      track_key TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      folder TEXT,
      name TEXT,
      ext TEXT,
      is_cue INTEGER NOT NULL DEFAULT 0,
      cue_id TEXT,
      cue_no INTEGER,
      cue_start REAL,
      cue_end REAL,
      cue_title TEXT,
      cue_artist TEXT,
      cue_album TEXT,
      size INTEGER,
      mtime REAL,
      title TEXT,
      artist TEXT,
      album TEXT,
      album_artist TEXT,
      duration REAL,
      bitrate INTEGER,
      sample_rate INTEGER,
      year TEXT,
      genre TEXT,
      lyrics TEXT,
      meta_json TEXT,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);

    CREATE TABLE IF NOT EXISTS scan_dirs (
      path TEXT PRIMARY KEY,
      mtime REAL,
      file_count INTEGER,
      files_json TEXT,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    PRAGMA user_version = 1;
  `);
}

function saveNow() {
  if (!db || !dbPath) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const bytes = db.export();
    const tmp = `${dbPath}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(bytes));
    fs.renameSync(tmp, dbPath);
    dirty = false;
  } catch (err) {
    console.warn(`[db] 保存失败: ${err.message}`);
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirty) saveNow();
  }, SAVE_DEBOUNCE_MS);
}

async function init(userDataDir) {
  if (initialized) return stats();
  initialized = true;
  try {
    const initSqlJs = require('sql.js');
    // 直接把 wasm 字节交给 sql.js，避免打包后 asar 内 locateFile 路径问题
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const wasmBinary = fs.readFileSync(wasmPath);
    SQL = await initSqlJs({ wasmBinary });

    fs.mkdirSync(userDataDir, { recursive: true });
    dbPath = path.join(userDataDir, DB_FILENAME);

    if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
      const data = new Uint8Array(fs.readFileSync(dbPath));
      db = new SQL.Database(data);
      console.log(`[db] 已打开 ${dbPath}`);
    } else {
      db = new SQL.Database();
      ensureSchema();
      saveNow();
      console.log(`[db] 已创建 ${dbPath}`);
    }

    // 兼容旧文件缺少新表/索引的情况
    ensureSchema();

    const s = stats();
    console.log(`[db] 曲库 ${s.tracks} 首，目录 ${s.scanDirs} 个，文件 ${s.sizeLabel}`);
    return s;
  } catch (err) {
    console.warn(`[db] 初始化失败，将退回纯内存扫描: ${err.message}`);
    db = null;
    initialized = false;
    return null;
  }
}

function isReady() {
  return !!db;
}

/** 扫描目录缓存：跨重启复用根目录 mtime + 文件列表 */
function getScanDir(dirPath) {
  if (!db) return null;
  try {
    const stmt = db.prepare('SELECT mtime, file_count, files_json FROM scan_dirs WHERE path = ?');
    stmt.bind([dirPath]);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    if (!row || !row.files_json) return null;
    const files = JSON.parse(row.files_json);
    if (!Array.isArray(files)) return null;
    return { mtime: row.mtime, fileCount: row.file_count, files };
  } catch (err) {
    console.warn(`[db] 读取扫描缓存失败: ${err.message}`);
    return null;
  }
}

function setScanDir(dirPath, cache) {
  if (!db) return;
  try {
    const files = Array.isArray(cache && cache.files) ? cache.files : [];
    db.run(
      `INSERT INTO scan_dirs (path, mtime, file_count, files_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         mtime = excluded.mtime,
         file_count = excluded.file_count,
         files_json = excluded.files_json,
         updated_at = excluded.updated_at`,
      [dirPath, cache.mtime || 0, cache.fileCount || files.length, JSON.stringify(files), nowSec()]
    );
    scheduleSave();
  } catch (err) {
    console.warn(`[db] 写入扫描缓存失败: ${err.message}`);
  }
}

function fileStatSafe(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { size: st.size, mtime: st.mtimeMs };
  } catch {
    return { size: null, mtime: null };
  }
}

/** 把扫描结果写入曲库；track_key 兼容 CUE 虚拟分轨 */
function upsertFiles(files, folder) {
  if (!db || !Array.isArray(files) || !files.length) return 0;
  let count = 0;
  try {
    db.run('BEGIN');
    const stmt = db.prepare(`
      INSERT INTO tracks (
        track_key, path, folder, name, ext, is_cue, cue_id, cue_no,
        cue_start, cue_end, cue_title, cue_artist, cue_album, size, mtime, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_key) DO UPDATE SET
        path = excluded.path,
        folder = excluded.folder,
        name = excluded.name,
        ext = excluded.ext,
        is_cue = excluded.is_cue,
        cue_id = excluded.cue_id,
        cue_no = excluded.cue_no,
        cue_start = excluded.cue_start,
        cue_end = excluded.cue_end,
        cue_title = excluded.cue_title,
        cue_artist = excluded.cue_artist,
        cue_album = excluded.cue_album,
        size = excluded.size,
        mtime = excluded.mtime,
        updated_at = excluded.updated_at
    `);
    const ts = nowSec();
    for (const f of files) {
      const isCue = f.cue ? 1 : 0;
      const key = isCue ? (f.cueId || `${f.path}::track${f.cueNo || 0}`) : f.path;
      const st = fileStatSafe(f.path);
      stmt.run([
        key, f.path, folder || null, f.name || path.basename(f.path), f.ext || path.extname(f.path).toLowerCase(),
        isCue, f.cueId || null, f.cueNo || null, f.cueStart ?? null, f.cueEnd ?? null,
        f.cueTitle || null, f.cueArtist || null, f.cueAlbum || null, st.size, st.mtime, ts,
      ]);
      count++;
    }
    stmt.free();
    db.run('COMMIT');
    scheduleSave();
  } catch (err) {
    try { db.run('ROLLBACK'); } catch { /* ignore */ }
    console.warn(`[db] 写入曲库失败: ${err.message}`);
  }
  return count;
}

/** 元数据到达后更新曲库（CUE 虚拟轨暂不覆盖，避免同路径多轨互相覆盖） */
function upsertMeta(filePath, info) {
  if (!db || !filePath || !info) return;
  try {
    const meta = { ...info };
    delete meta.coverBase64;
    delete meta.cover;
    delete meta.lyrics;
    const lyrics = typeof info.lyrics === 'string' ? info.lyrics : (info.lyrics && info.lyrics.text) || null;
    db.run(
      `UPDATE tracks SET
        title = COALESCE(?, title),
        artist = COALESCE(?, artist),
        album = COALESCE(?, album),
        album_artist = COALESCE(?, album_artist),
        duration = COALESCE(?, duration),
        bitrate = COALESCE(?, bitrate),
        sample_rate = COALESCE(?, sample_rate),
        year = COALESCE(?, year),
        genre = COALESCE(?, genre),
        lyrics = COALESCE(?, lyrics),
        meta_json = ?,
        updated_at = ?
       WHERE path = ? AND is_cue = 0`,
      [
        info.title || null, info.artist || null, info.album || null, info.albumArtist || null,
        info.duration || null, info.bitrate || null, info.sampleRate || null,
        info.year ? String(info.year) : null, info.genre || null, lyrics,
        JSON.stringify(meta), nowSec(), filePath,
      ]
    );
    scheduleSave();
  } catch (err) {
    console.warn(`[db] 写入元数据失败: ${err.message}`);
  }
}

function listTracks(limit = 5000) {
  if (!db) return [];
  try {
    const stmt = db.prepare(`SELECT * FROM tracks ORDER BY updated_at DESC LIMIT ?`);
    stmt.bind([limit]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch {
    return [];
  }
}

function stats() {
  if (!db) return { ready: false, tracks: 0, scanDirs: 0, size: 0, sizeLabel: '0 B' };
  const one = (sql) => {
    try {
      const r = db.exec(sql);
      return (r && r[0] && r[0].values && r[0].values[0]) ? Number(r[0].values[0][0]) || 0 : 0;
    } catch { return 0; }
  };
  let size = 0;
  try { size = fs.statSync(dbPath).size; } catch { /* ignore */ }
  const fmt = (n) => n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  return {
    ready: true,
    tracks: one('SELECT COUNT(*) FROM tracks'),
    scanDirs: one('SELECT COUNT(*) FROM scan_dirs'),
    size,
    sizeLabel: fmt(size),
    path: dbPath,
  };
}

function close() {
  if (!db) return;
  saveNow();
  try { db.close(); } catch { /* ignore */ }
  db = null;
  initialized = false;
}

module.exports = {
  init,
  isReady,
  getScanDir,
  setScanDir,
  upsertFiles,
  upsertMeta,
  listTracks,
  stats,
  saveNow,
  close,
  DB_FILENAME,
};
