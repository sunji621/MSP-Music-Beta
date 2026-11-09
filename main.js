/**
 * ─── main.js ───
 * Electron 主进程。职责：
 * 1. 管理窗口生命周期
 * 2. 通过 IPC 暴露文件夹选择、音频元数据读取、在线 API 查询
 * 3. 内嵌 MusicMetaFetcher 模块（不拆分额外文件）
 *    在线刮取优先级：QQ 音乐（名称/专辑/封面/歌词）→ 网易云（歌词）→ MusicBrainz/CAA（封面）→ LRCLIB（歌词）
 *    全部歌词统一转换为简体中文，优先带简体翻译
 */

const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, Tray, Menu, nativeImage, protocol, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');
const { spawn, spawnSync } = require('child_process');
const mmRaw = require('music-metadata');
const mpvEngine = require('./mpv-engine');
const lanServer = require('./lan-server');

// 防止登录页（QQ等）检测到自动化环境，须在 app ready 前设置
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
// ── 性能优化（v26.9.14）──
// 旧版曾用 disable-gpu-compositing 规避个别 GPU 驱动的 damage 跟踪失效，
// 但该开关强制所有 UI 走 CPU 软件合成，导致播放时 CPU 占用 30%+、风扇狂转。
// Electron 33 (Chromium 130+) 合成器已稳定，恢复 GPU 合成可把 CPU 降到 5% 以内。
// 若极少数驱动仍出现不重绘，可加 --disable-features=CalculateNativeWinOcclusion 兜底。
app.commandLine.appendSwitch('disable-gpu-watchdog');
// 视频叠加层：MV 播放时让 B站 DASH 视频走 DirectComposition 硬件叠加层，
// 降低 GPU 合成开销（旧版因透明窗口欠曝问题禁用，现窗口非透明，可安全启用）。
// 保留可由用户在设置中切换的余地，默认启用硬件路径。

// 注册自定义协议为特权协议：
//  - bilistream：B站 MV 视频流（带 Referer 拉取）
//  - audiostream：在线音频代理（带 Referer + 注入 CORS 头，使 Web Audio EQ 可处理跨域音频）
protocol.registerSchemesAsPrivileged([
  { scheme: 'bilistream', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: 'audiostream', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);
// music-metadata v10 是纯 ESM 包，其 CJS 入口只导出 loadMusicMetadata 异步加载器。
// 在 Electron 主进程里必须 await loadMusicMetadata() 才能拿到真正的 parseFile 等 API。
const mmPromise = (async () => {
  if (mmRaw && typeof mmRaw.loadMusicMetadata === 'function') {
    const mod = await mmRaw.loadMusicMetadata();
    // 兼容命名空间 default 嵌套
    return mod.parseFile ? mod : (mod.default && mod.default.parseFile ? mod.default : mod);
  }
  // 旧版/纯 Node 环境：直接可用
  if (mmRaw && typeof mmRaw.parseFile === 'function') return mmRaw;
  return mmRaw;
})();
// 启动时确认模块加载完成
mmPromise.then((mm) => {
  console.log(`[music-metadata] 加载完成, parseFile 可用: ${typeof mm.parseFile === 'function'}`);
}).catch((err) => {
  console.error(`[music-metadata] 加载失败: ${err.message}`);
});
const axios = require('axios');

// ============================================================
// 日志系统：收集主进程 console 输出，推送到渲染进程（设置页日志查看器）
// 中文乱码根因：Windows 控制台默认用 GBK 代码页，console.log 的中文在非 UTF-8 终端
// 会显示为乱码。此处不改终端编码（不可靠），而是把日志同时存入内存环形缓冲，
// 渲染进程通过 IPC 读取，渲染进程用 UTF-8 显示，不受终端编码影响。
// ============================================================
const LOG_RING_MAX = 2000; // 内存环形缓冲上限
const logRing = [];
let logListeners = [];   // 已注册的渲染进程回调

/** 格式化时间戳 */
function logTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 记录一条日志并推送给渲染进程 */
function appendLog(level, args) {
  const entry = {
    time: logTimestamp(),
    level: level, // 'log' | 'warn' | 'error'
    msg: args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' '),
  };
  logRing.push(entry);
  if (logRing.length > LOG_RING_MAX) logRing.shift();
  // 推送给所有已注册的渲染进程
  logListeners.forEach((sender) => {
    try { sender.send('log-push', entry); } catch (e) { /* 窗口已关闭，忽略 */ }
  });
}

// 劫持 console 输出（保留原行为同时收集）
['log', 'warn', 'error'].forEach((level) => {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    appendLog(level, args);
    orig(...args); // 仍输出到终端（可能有乱码，但内存/渲染进程里是正确 UTF-8）
  };
});

/** 注册一个渲染进程为日志监听者，并返回已有日志 */
ipcMain.handle('log-subscribe', (event) => {
  const sender = event.sender;
  logListeners = logListeners.filter((s) => {
    try { return !s.isDestroyed(); } catch (e) { return false; }
  });
  logListeners.push(sender);
  // 返回已有日志快照
  return logRing.slice();
});
ipcMain.handle('log-clear', () => {
  logRing.length = 0;
  return true;
});

// 简繁转换（opencc-js，可选依赖，加载失败时跳过转换）
let t2sConverter = null;
try {
  const OpenCC = require('opencc-js');
  t2sConverter = OpenCC.Converter({ from: 't', to: 'cn' });
} catch (err) {
  console.warn('[opencc] 简繁转换模块未加载，歌词将不做简体转换');
}

// ============================================================
// 常量
// ============================================================
const USER_AGENT = 'LocalElectronMusicPlayer/1.0 (dev@test.com)';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const API_DELAY_MS = 300;   // 普通线上 API 请求间隔（毫秒）
const MB_DELAY_MS = 1100;   // MusicBrainz 官方要求 ≥1 请求/秒
const SUPPORTED_EXTS = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.aac', '.wma', '.dsf', '.dff', '.aif', '.aiff', '.opus', '.wv', '.ape', '.tak']);

// 可在开发时通过环境变量跳过大窗口尺寸
const IS_DEV = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// ============================================================
// 全局状态
// ============================================================
let mainWindow = null;
let tray = null;
let isQuiting = false;      // true 时关闭窗口不再拦截（真正退出）
let trayPrefs = { minimizeToTray: false }; // 关闭时"始终最小化到托盘"记忆

// 元数据请求队列（串行处理，防止并发限流）
const metaQueue = [];
let isProcessingMeta = false;

// ============================================================
// 工具函数
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 文件路径 → 安全的 file:// URL */
function pathToFileUrl(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return `file:///${encodeURI(normalized)}`;
}

/** 规范化文本用于相似度比较（去括号注释、标点、空白） */
function normalizeText(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/\(\s*[^)]*(?:feat|ft|version|remix|live|cover|acoustic)[^)]*\)/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*(?:ver|live|remix)[^\]]*\]/g, '')
    .replace(/[\s~！!？?，,。.·\-—_:：;；'’"“”`()（）&/\\|]+/g, '');
}

/** 文件名匹配用的归一化：去掉歌手前缀、音轨号、所有括号注释，只留歌名核心
 *  例："宇多田光 - One Last Kiss (最后一吻)" → "onelastkiss"
 *      "宇多田ヒカル-One Last Kiss"            → "onelastkiss"  */
function normalizeForMatch(name) {
  if (!name) return '';
  let s = String(name).toLowerCase();
  // 去开头音轨号 "01." "01 - " "01_"
  s = s.replace(/^\d{1,3}[\s._-]+/, '');
  // 去掉歌手前缀："artist - title" 或 "artist-title" → 只留 title
  // 优先匹配带空格的 " - "，再匹配不带空格的 "-"
  const dashIdx = s.indexOf(' - ');
  if (dashIdx > 0) {
    s = s.slice(dashIdx + 3);
  } else {
    // 尝试第一个 "-"（但需确保前面不是纯数字音轨号已被去掉的情况）
    const m = s.match(/^[^-]+-(.+)$/);
    if (m) s = m[1];
  }
  // 去掉所有括号内容（中英文括号）
  s = s.replace(/\([^)]*\)/g, '').replace(/（[^）]*）/g, '').replace(/【[^】]*】/g, '').replace(/\[[^\]]*\]/g, '');
  // 去空格和标点
  s = s.replace(/[\s~！!？?，,。.·\-—_:：;；'’"“”`&/\\|]+/g, '');
  return s.trim();
}

/** Dice 系数（二元组相似度），0~1，对中英文都有效 */
function diceSimilarity(a, b) {
  a = normalizeText(a);
  b = normalizeText(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = grams.get(g) || 0;
    if (c > 0) { hit++; grams.set(g, c - 1); }
  }
  return (2 * hit) / ((a.length - 1) + (b.length - 1));
}

/** 对候选结果打分：标题 0.6 + 艺术家 0.4（艺术家未知时取中性 0.5） */
function scoreCandidate(cand, artist, title) {
  const t = diceSimilarity(cand.title, title || '');
  const a = artist ? diceSimilarity(cand.artist, artist) : 0.5;
  return t * 0.6 + a * 0.4;
}

/** 下载图片并转为 data URL（渲染进程 CSP 不允许外域 <img>，统一在主进程转 base64） */
async function downloadImageAsDataUrl(imageUrl) {
  try {
    const resp = await axios.get(imageUrl, {
      timeout: 10000,
      responseType: 'arraybuffer',
      headers: { 'User-Agent': UA_BROWSER },
    });
    const contentType = resp.headers['content-type'] || 'image/jpeg';
    if (!String(contentType).startsWith('image/')) return null;
    return `data:${contentType};base64,${bytesToBase64(resp.data)}`;
  } catch (err) {
    console.warn(`[downloadImage] 失败: ${imageUrl} — ${err.message}`);
    return null;
  }
}

/** 将 Buffer / Uint8Array / ArrayBuffer 安全转为 base64 字符串。
 *  Electron 中 Uint8Array 跨 realm 时直接 .toString('base64') 会退化为逗号分隔字节，
 *  必须从底层 ArrayBuffer 构造 Node Buffer 再编码。 */
function bytesToBase64(data) {
  if (Buffer.isBuffer(data)) return data.toString('base64');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('base64');
  if (data && typeof data === 'object' && data.buffer instanceof ArrayBuffer) {
    return Buffer.from(data.buffer, data.byteOffset | 0, data.byteLength | 0).toString('base64');
  }
  return Buffer.from(data).toString('base64');
}

/** 文本 → 简体 */
function toSimplified(text) {
  if (!text || !t2sConverter) return text;
  try { return t2sConverter(text); } catch (err) { return text; }
}

/** LRC 文本逐行转简体（保留时间标签） */
function lrcToSimplified(lrcText) {
  if (!lrcText || !t2sConverter) return lrcText;
  return lrcText.split('\n').map((line) => {
    const m = line.match(/^((?:\[\d+:\d+(?:\.\d+)?\])+)(.*)$/);
    if (m) return m[1] + toSimplified(m[2]);
    return toSimplified(line);
  }).join('\n');
}

/** 判断文本是否包含中文汉字（用于判断是否为外语歌曲） */
function hasChinese(s) {
  return !!s && /[\u4e00-\u9fff]/.test(String(s));
}

/** 异步递归遍历目录：收集音频文件与 .cue 分轨表
 *  并发遍历子目录（最多同时 8 个），onProgress(count) 每收集 500 个文件回调一次。
 *  跳过隐藏目录（以 "." 开头）。错误处理：console.warn 并跳过该目录。 */
async function walkMusicDir(dirPath, audioOut, cueOut, onProgress) {
  const CONCURRENCY = 8;
  const queue = [dirPath];
  let active = 0;
  let done = false;

  return new Promise((resolve) => {
    function maybeFinish() {
      if (done) return;
      if (queue.length === 0 && active === 0) {
        done = true;
        resolve();
      }
    }

    function schedule() {
      while (active < CONCURRENCY && queue.length > 0) {
        const dir = queue.shift();
        active++;
        processDir(dir).then(() => {
          active--;
          if (queue.length > 0) {
            schedule();
          } else {
            maybeFinish();
          }
        });
      }
      maybeFinish();
    }

    async function processDir(dirPath) {
      let entries;
      try {
        entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch (err) {
        console.warn(`[scanAudioFiles] 跳过目录 ${dirPath}: ${err.message}`);
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          // 跳过隐藏目录
          if (!entry.name.startsWith('.')) queue.push(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTS.has(ext)) {
            audioOut.push(fullPath);
            if (onProgress && audioOut.length % 500 === 0) onProgress(audioOut.length);
          } else if (ext === '.cue') {
            cueOut.push(fullPath);
          }
        }
      }
    }

    schedule();
  });
}

/** 智能解码文本 Buffer：BOM → UTF-8 → GBK 回退（中文 CUE 常为 GBK） */
function decodeTextBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    try { return require('iconv-lite').decode(buf, 'utf16be'); } catch { return buf.toString('utf8'); }
  }
  const s = buf.toString('utf8');
  if (!s.includes('\uFFFD')) return s;
  try {
    const g = require('iconv-lite').decode(buf, 'gbk');
    if (g && !g.includes('\uFFFD')) return g;
  } catch { /* iconv 不可用时退回 UTF-8 */ }
  return s;
}

/** CUE 时间码 mm:ss:ff（ff 为 1/75 秒帧） */
function cueTimeToSeconds(tok) {
  const m = String(tok).trim().match(/^(\d+):(\d{1,2}):(\d{1,3})$/);
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]) + (+m[3]) / 75;
}

/** 取 CUE 指令后引号内的值，无引号时取剩余整行 */
function cueValue(rest) {
  const m = rest.match(/^"(.*)"\s*$/);
  return (m ? m[1] : rest.trim()).trim();
}

/**
 * 解析 CUE 分轨表。
 * @returns {{album:string, artist:string, files: Array<{name:string, path:string|null,
 *            tracks: Array<{no:string,title:string,artist:string,start:number,end:number|null}>}>}|null}
 */
function parseCueSheet(cuePath) {
  let text;
  try { text = decodeTextBuffer(fs.readFileSync(cuePath)); } catch { return null; }
  const globalMeta = { title: '', performer: '' };
  const files = [];
  let curFile = null;
  let curTrack = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^FILE\s+(.+)$/i))) {
      // FILE 行形如：FILE "专辑.wav" WAVE；末 token 为类型，文件名可带引号或空格
      let name = m[1].trim();
      const qm = name.match(/^"(.*)"\s+\S+\s*$/);
      if (qm) name = qm[1];
      else {
        const parts = name.split(/\s+/);
        if (parts.length > 1) parts.pop();
        name = parts.join(' ');
      }
      curFile = { name, path: null, tracks: [] };
      files.push(curFile);
      curTrack = null;
    } else if ((m = line.match(/^TRACK\s+(\d+)\s+AUDIO\b/i))) {
      if (!curFile) { curFile = { name: '', path: null, tracks: [] }; files.push(curFile); }
      curTrack = { no: m[1], title: '', performer: '', start: null, end: null };
      curFile.tracks.push(curTrack);
    } else if ((m = line.match(/^TITLE\s+(.+)$/i))) {
      const v = cueValue(m[1]);
      if (curTrack) curTrack.title = v; else globalMeta.title = v;
    } else if ((m = line.match(/^PERFORMER\s+(.+)$/i))) {
      const v = cueValue(m[1]);
      if (curTrack) curTrack.performer = v; else globalMeta.performer = v;
    } else if ((m = line.match(/^INDEX\s+(\d+)\s+(\d+:\d{1,2}:\d{1,3})/i))) {
      if (curTrack && m[1] === '01') curTrack.start = cueTimeToSeconds(m[2]);
    }
  }
  // 解析每个 FILE 引用的真实音频路径，并补齐每轨结束时间
  const cueDir = path.dirname(cuePath);
  let dirEntries = null;
  for (const f of files) {
    if (!f.tracks.length || !f.name) continue;
    const direct = path.join(cueDir, f.name);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) { f.path = direct; }
    else {
      // 容错：扩展名/大小写不一致（CUE 写 .wav，实际是 .ape/.flac）→ 同目录按主名匹配
      if (!dirEntries) {
        try { dirEntries = fs.readdirSync(cueDir); } catch { dirEntries = []; }
      }
      const wantBase = path.basename(f.name).replace(/\.[^.]+$/, '').toLowerCase();
      const hit = dirEntries.find((n) => {
        if (n.toLowerCase() === f.name.toLowerCase()) return true;
        return n.replace(/\.[^.]+$/, '').toLowerCase() === wantBase &&
          SUPPORTED_EXTS.has(path.extname(n).toLowerCase());
      });
      if (hit) f.path = path.join(cueDir, hit);
    }
    for (let i = 0; i < f.tracks.length; i++) {
      const t = f.tracks[i];
      if (!Number.isFinite(t.start)) t.start = i === 0 ? 0 : (f.tracks[i - 1].start || 0);
      t.end = i + 1 < f.tracks.length ? f.tracks[i + 1].start : null;
    }
  }
  const validFiles = files.filter((f) => f.path && f.tracks.some((t) => Number.isFinite(t.start)));
  if (!validFiles.length) return null;
  return { album: globalMeta.title, artist: globalMeta.performer, files: validFiles };
}

// 增量扫描缓存：Map<dirPath, {mtime, fileCount}>，记录上次扫描时的根目录 mtime 与文件数。
// 下次扫描时若根目录 mtime 未变且 fileCount > 0，可跳过整棵子树的遍历。
const scanDirCache = new Map();

/**
 * 异步递归扫描目录，返回曲目描述符数组。
 * 普通曲目：{ path, name, ext }
 * CUE 虚拟轨：{ path(整轨文件), name, ext, cue:true, cueId, cueNo, cueStart, cueEnd,
 *               cueTitle, cueArtist, cueAlbum }
 * 成功解析的整轨文件会被其虚拟分轨替换（不再作为单首出现）。
 * @param {string} dirPath 要扫描的根目录
 * @param {(count:number)=>void} [onProgress] 可选进度回调，每收集 500 个文件调用一次
 */
async function scanAudioFiles(dirPath, onProgress) {
  // 增量扫描：检查根目录 mtime，未变且缓存中有该目录的歌曲则跳过整棵子树
  try {
    const rootStat = fs.statSync(dirPath);
    const cached = scanDirCache.get(dirPath);
    if (cached && cached.mtime === rootStat.mtimeMs && cached.fileCount > 0) {
      console.log(`[scanAudioFiles] 根目录 mtime 未变，跳过扫描: ${dirPath}`);
      return [];
    }
  } catch (err) { /* 根目录 stat 失败，继续正常扫描 */ }

  const audioFiles = [];
  const cueFiles = [];
  await walkMusicDir(dirPath, audioFiles, cueFiles, onProgress);

  // CUE 分轨：按整轨文件聚合虚拟轨
  const cueTracksByFile = new Map(); // audioPath -> [descriptor...]
  for (const cuePath of cueFiles) {
    const sheet = parseCueSheet(cuePath);
    if (!sheet) continue;
    for (const f of sheet.files) {
      if (!cueTracksByFile.has(f.path)) cueTracksByFile.set(f.path, []);
      const ext = path.extname(f.path).toLowerCase();
      f.tracks.forEach((t) => {
        const title = t.title || `${path.basename(f.path, ext)} - ${t.no}`;
        cueTracksByFile.get(f.path).push({
          path: f.path,
          name: title,
          ext,
          cue: true,
          cueId: `${f.path}::track${t.no}`,
          cueNo: t.no,
          cueStart: t.start,
          cueEnd: t.end,
          cueTitle: title,
          cueArtist: t.performer || sheet.artist || '',
          cueAlbum: sheet.album || '',
        });
      });
    }
  }

  // 用虚拟分轨替换整轨：在整轨首次出现的位置插入其分轨
  const out = [];
  for (const fp of audioFiles) {
    const tracks = cueTracksByFile.get(fp);
    if (tracks && tracks.length) out.push(...tracks);
    else out.push({ path: fp, name: path.basename(fp), ext: path.extname(fp).toLowerCase() });
  }

  // 更新增量扫描缓存
  try {
    const rootStat = fs.statSync(dirPath);
    scanDirCache.set(dirPath, { mtime: rootStat.mtimeMs, fileCount: out.length });
  } catch (err) { /* 忽略 */ }

  return out;
}

// ============================================================
// MusicMetaFetcher — 内嵌元数据读取 + 在线补全模块
// ============================================================
const MusicMetaFetcher = {
  /** ⓪ 快速标签：纯文件系统操作，不调 music-metadata
   *  用于大规模曲库的快速首屏展示，避免逐个解析 ID3 的开销。
   *  仅从 stat 取 size + mtime，从文件名猜测 title/artist。 */
  quickTags(filePath) {
    let stat;
    try { stat = fs.statSync(filePath); }
    catch (err) { stat = { size: 0 }; }
    const guessed = this.guessFromFilename(filePath);
    return {
      title: guessed.title,
      artist: guessed.artist,
      album: null,
      coverBase64: null,
      duration: null,
      bitrate: null,
      sampleRate: null,
      size: stat.size,
      quick: true,
    };
  },

  /** ① 读取本地 ID3 元数据（快速版：不读内嵌封面、不计算时长） */
  async readLocalTags(filePath) {
    try {
      const mm = await mmPromise;
      // 优先 parseFile；若不可用则回退 parseBuffer
      let meta;
      if (typeof mm.parseFile === 'function') {
        meta = await mm.parseFile(filePath, { duration: false, skipCovers: true });
      } else if (typeof mm.parseBuffer === 'function') {
        const buf = fs.readFileSync(filePath);
        const ext = path.extname(filePath).slice(1).toLowerCase();
        meta = await mm.parseBuffer(buf, { mimeType: ext ? `audio/${ext}` : undefined }, { duration: false, skipCovers: true });
      } else {
        throw new Error('music-metadata 的 parseFile/parseBuffer 均不可用');
      }
      const common = meta.common || {};
      return {
        title: common.title || null,
        artist: common.artist || (common.artists && common.artists[0]) || null,
        album: common.album || null,
        coverBase64: null, // 封面改为在 readCover 中按需提取
        duration: null, // 时长不在此计算（duration: false）
        bitrate: meta.format.bitrate || null,
        sampleRate: meta.format.sampleRate || null,
        quick: false,
      };
    } catch (err) {
      console.warn(`[readLocalTags] 读取失败: ${filePath} — ${err.message}`);
      return { title: null, artist: null, album: null, coverBase64: null, duration: null, bitrate: null, sampleRate: null, quick: false };
    }
  },

  /** ①b 按需提取内嵌封面：只取 common.picture[0]，返回 base64 data URL 或 null */
  async readCover(filePath) {
    try {
      const mm = await mmPromise;
      let meta;
      if (typeof mm.parseFile === 'function') {
        meta = await mm.parseFile(filePath, { duration: false, skipCovers: false });
      } else if (typeof mm.parseBuffer === 'function') {
        const buf = fs.readFileSync(filePath);
        const ext = path.extname(filePath).slice(1).toLowerCase();
        meta = await mm.parseBuffer(buf, { mimeType: ext ? `audio/${ext}` : undefined }, { duration: false, skipCovers: false });
      } else {
        return null;
      }
      const common = meta.common || {};
      if (common.picture && common.picture.length > 0) {
        const pic = common.picture[0];
        return `data:${pic.format};base64,${bytesToBase64(pic.data)}`;
      }
      return null;
    } catch (err) {
      console.warn(`[readCover] 读取封面失败: ${filePath} — ${err.message}`);
      return null;
    }
  },

  /** ② 从文件名猜测歌曲信息（ID3 全空时的兜底） */
  guessFromFilename(filePath) {
    const basename = path.basename(filePath, path.extname(filePath));
    // 去掉文件名开头的点（隐藏文件）
    let cleanBasename = basename.replace(/^\./, '');
    // 去掉开头的音轨序号，如 "01 - "、"01."、"01_"、"001 "
    cleanBasename = cleanBasename.replace(/^\d{1,3}[\s._-]+/, '');
    // 尝试 "artist - title" 格式
    const dashIdx = cleanBasename.indexOf(' - ');
    if (dashIdx > 0) {
      const title = cleanBasename.slice(dashIdx + 3).trim().replace(/^\./, '');
      const artist = cleanBasename.slice(0, dashIdx).trim();
      return { title: title || null, artist: artist || null };
    }
    // 直接作为标题（去掉前导点）
    const title = cleanBasename.trim().replace(/^\./, '');
    return { title: title || null, artist: null };
  },

  /** ③ MusicBrainz 搜索录音 MBID */
  async searchMusicBrainz(artist, title) {
    if (!artist && !title) return { recordingMbid: null, releaseMbid: null, releaseTitle: null };
    try {
      // 构建多层查询策略：先精确，再模糊
      const queries = [];
      
      // 策略1: 带引号的精确搜索
      const parts = [];
      if (title) parts.push(`recording:"${title.replace(/"/g, '').trim()}"`);
      if (artist) parts.push(`artist:"${artist.replace(/"/g, '').trim()}"`);
      if (parts.length > 0) queries.push(parts.join(' AND '));
      
      // 策略2: 无引号宽松搜索
      const looseParts = [];
      if (title) looseParts.push(`recording:${title.replace(/"/g, '').trim()}`);
      if (artist) looseParts.push(`artist:${artist.replace(/"/g, '').trim()}`);
      if (looseParts.length > 0) queries.push(looseParts.join(' AND '));
      
      // 策略3: 仅按标题搜索
      if (title) queries.push(`recording:"${title.replace(/"/g, '').trim()}"`);
      
      let recordings = null;
      for (const query of queries) {
        console.log(`[MusicBrainz] 尝试查询: ${query}`);
        const resp = await axios.get('https://musicbrainz.org/ws/2/recording', {
          params: {
            query,
            limit: 5,
            fmt: 'json',
          },
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' // 指定中文优先
          },
          timeout: 10000,
        });
        recordings = resp.data?.recordings;
        if (recordings && recordings.length > 0) {
          console.log(`[MusicBrainz] 查询成功，找到 ${recordings.length} 条结果`);
          break;
        }
        await sleep(300);
      }

      if (!recordings || recordings.length === 0) {
        console.warn(`[MusicBrainz] 所有查询策略均无结果: artist=${artist}, title=${title}`);
        return { recordingMbid: null, releaseMbid: null, releaseTitle: null };
      }
      // 对候选结果按标题+艺术家相似度打分，避免取到完全无关的第一条
      let best = null;
      let bestScore = -1;
      for (const rec of recordings) {
        const recArtist = Array.isArray(rec['artist-credit'])
          ? rec['artist-credit'].map((c) => (c && c.name) || '').join('')
          : '';
        const sc = scoreCandidate({ title: rec.title, artist: recArtist }, artist || '', title || '');
        if (sc > bestScore) { bestScore = sc; best = rec; }
      }
      if (!best || bestScore < 0.4) {
        console.warn(`[MusicBrainz] 最佳结果得分过低(${bestScore.toFixed(2)})，放弃`);
        return { recordingMbid: null, releaseMbid: null, releaseTitle: null };
      }
      const release = best.releases && best.releases[0];
      return {
        recordingMbid: best.id || null,
        releaseMbid: release ? release.id : null,
        releaseTitle: release ? release.title : null,
      };
    } catch (err) {
      console.warn(`[searchMusicBrainz] 请求失败: ${err.message}`);
      return { recordingMbid: null, releaseMbid: null, releaseTitle: null };
    }
  },

  /** ④ Cover-Art-Archive 获取封面 URL（优先 front-500） */
  async getCoverArt(releaseMbid) {
    if (!releaseMbid) return null;
    try {
      const resp = await axios.get(
        `https://coverartarchive.org/release/${releaseMbid}/front-500`,
        { timeout: 8000, responseType: 'arraybuffer' }
      );
      const base64 = Buffer.from(resp.data).toString('base64');
      const contentType = resp.headers['content-type'] || 'image/jpeg';
      return `data:${contentType};base64,${base64}`;
    } catch (err) {
      // 404 等表示无封面，返回 null 而不崩溃
      if (err.response && err.response.status === 404) {
        console.warn(`[getCoverArt] 封面不存在: release=${releaseMbid}`);
      } else {
        console.warn(`[getCoverArt] 请求失败: ${err.message}`);
      }
      return null;
    }
  },

  /** ⑤ 读取本地侧车 LRC 歌词文件（最高优先级）。
   *  匹配策略：① 同名 .lrc（song.mp3 → song.lrc）；
   *           ② 同目录下模糊匹配（忽略空格/大小写/括号注释/音轨号，
   *              比较歌名核心部分，如 "宇多田光 - One Last Kiss" 匹配 "宇多田ヒカル-One Last Kiss"）。 */
  readLocalLRC(filePath) {
    const dir = path.dirname(filePath);
    const audioName = path.basename(filePath, path.extname(filePath));
    const audioCore = normalizeForMatch(audioName);

    // ① 同名精确匹配
    const exactPath = path.join(dir, audioName + '.lrc');
    if (fs.existsSync(exactPath)) return this._loadLRC(exactPath);

    // ② 扫描同目录所有 .lrc，模糊匹配歌名
    let lrcFiles;
    try {
      lrcFiles = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.lrc'));
    } catch (err) { return null; }

    let bestMatch = null;
    let bestScore = 0;
    for (const lrcName of lrcFiles) {
      const lrcCore = normalizeForMatch(path.basename(lrcName, '.lrc'));
      if (!lrcCore) continue;
      // 核心歌名互相包含即认为匹配（取较长的那个做包含判断）
      const [longer, shorter] = audioCore.length >= lrcCore.length ? [audioCore, lrcCore] : [lrcCore, audioCore];
      if (longer.includes(shorter)) {
        const score = shorter.length / longer.length; // 越接近1越匹配
        if (score > bestScore) { bestScore = score; bestMatch = lrcName; }
      }
    }
    if (bestMatch && bestScore >= 0.5) {
      return this._loadLRC(path.join(dir, bestMatch));
    }
    return null;
  },

  /** 实际读取 LRC 文件并解析（UTF-8 优先，乱码时按 GBK/GB18030 重解码） */
  _loadLRC(lrcPath) {
    try {
      const buf = fs.readFileSync(lrcPath);
      let text = buf.toString('utf-8');
      // 去 BOM
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      // 含替换符说明不是有效 UTF-8（常见于中文 ANSI/GBK 编码的 .lrc），改用 GB18030 解码
      if (text.includes('\uFFFD')) {
        try {
          const iconv = require('iconv-lite');
          text = iconv.decode(buf, 'gb18030');
          console.log(`[readLocalLRC] UTF-8 解码乱码，已用 GB18030 重解码: ${path.basename(lrcPath)}`);
        } catch (err) { /* iconv-lite 不可用时保留原文本 */ }
      }
      const synced = lrcToSimplified(text.trim());
      // 提取纯文本歌词（去掉时间标签）
      const plain = synced
        .split('\n')
        .map((l) => l.replace(/\[[^\]]*\]/g, '').trim())
        .filter(Boolean)
        .join('\n');
      console.log(`[readLocalLRC] 找到本地歌词: ${path.basename(lrcPath)}`);
      return { syncedLyrics: synced, plainLyrics: plain, translationLyrics: null, source: 'local-lrc' };
    } catch (err) {
      console.warn(`[readLocalLRC] 读取失败: ${lrcPath} — ${err.message}`);
      return null;
    }
  },

  /** ⑥ LRCLIB 获取同步歌词 */
  async searchLRCLib(artist, title) {
    if (!artist && !title) return null;
    try {
      const resp = await axios.get('https://lrclib.net/api/search', {
        params: {
          artist_name: artist || '',
          track_name: title || '',
        },
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
        timeout: 10000,
      });
      const results = resp.data;
      if (!results || results.length === 0) return null;
      // 优先选择同步歌词
      const best = results.find((r) => r.syncedLyrics) || results[0];
      return {
        syncedLyrics: best.syncedLyrics || null,
        translationLyrics: null,
        plainLyrics: best.plainLyrics || null,
        source: 'lrclib',
      };
    } catch (err) {
      console.warn(`[searchLRCLib] 请求失败: ${err.message}`);
      return null;
    }
  },

  /** ⑥ QQ 音乐搜索：中文曲目排序质量最好，返回名称/专辑/封面/歌词 ID */
  async fetchQQMusic(artist, title) {
    const term = [artist, title].filter(Boolean).join(' ');
    if (!term) return null;
    const headers = { 'User-Agent': UA_BROWSER, 'Referer': 'https://y.qq.com/' };
    try {
      const resp = await axios.get('https://c.y.qq.com/soso/fcgi-bin/client_search_cp', {
        params: { w: term, format: 'json', n: 6 },
        headers,
        timeout: 10000,
      });
      const list = resp.data && resp.data.data && resp.data.data.song && resp.data.data.song.list;
      if (!list || list.length === 0) return null;
      let best = null;
      let bestScore = -1;
      for (const s of list) {
        const cand = {
          title: s.songname,
          artist: s.singer && s.singer.map((x) => x.name).join('/'),
          album: s.albumname || null,
          albummid: s.albummid || null,
          songmid: s.songmid || null,
          duration: s.interval || null,
        };
        const sc = scoreCandidate(cand, artist || '', title || '');
        if (sc > bestScore) { bestScore = sc; best = cand; }
      }
      if (!best || bestScore < 0.4) {
        console.warn(`[QQMusic] 最佳匹配得分过低(${bestScore.toFixed(2)})，放弃`);
        return null;
      }
      best.score = bestScore;
      return best;
    } catch (err) {
      console.warn(`[fetchQQMusic] 请求失败: ${err.message}`);
      return null;
    }
  },

  /** ⑦ QQ 音乐封面：albummid → 500x500 官方图 → data URL */
  async fetchQQCover(albummid) {
    if (!albummid) return null;
    const url = `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albummid}.jpg`;
    const dataUrl = await downloadImageAsDataUrl(url);
    if (dataUrl) console.log('[QQMusic] 封面获取成功');
    return dataUrl;
  },

  /** ⑧ QQ 音乐歌词：同步 LRC + 简体翻译（base64 编码） */
  async fetchQQLyrics(songmid) {
    if (!songmid) return null;
    try {
      const resp = await axios.get('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
        params: { songmid, g_tk: '5381', format: 'json', loginUin: '0', hostUin: '0', platform: 'yqq', needNewCode: '0' },
        headers: { 'User-Agent': UA_BROWSER, 'Referer': 'https://y.qq.com/' },
        timeout: 10000,
      });
      const d = resp.data || {};
      const synced = d.lyric ? Buffer.from(d.lyric, 'base64').toString('utf-8') : null;
      const translation = d.trans ? Buffer.from(d.trans, 'base64').toString('utf-8') : null;
      if (!synced) return null;
      console.log(`[QQMusic] 歌词获取成功: synced=${!!synced}, translation=${!!translation}`);
      return {
        syncedLyrics: lrcToSimplified(synced),
        translationLyrics: translation ? lrcToSimplified(translation) : null,
        plainLyrics: null,
        source: 'qqmusic',
      };
    } catch (err) {
      console.warn(`[fetchQQLyrics] 请求失败: ${err.message}`);
      return null;
    }
  },

  /** ⑨ 网易云音乐歌词：备选源（简体歌词 + 简体翻译，排序质量一般需严格打分） */
  async fetchNeteaseLyrics(artist, title) {
    const term = [artist, title].filter(Boolean).join(' ');
    if (!term) return null;
    const headers = {
      'User-Agent': UA_BROWSER,
      'Referer': 'https://music.163.com/',
      'Cookie': 'os=pc; appver=2.9.7',
    };
    try {
      const resp = await axios.get('https://music.163.com/api/search/get', {
        params: { s: term, type: 1, limit: 5 },
        headers,
        timeout: 10000,
      });
      const songs = resp.data && resp.data.result && resp.data.result.songs;
      if (!songs || songs.length === 0) return null;

      // 选标题+歌手最匹配的一首
      let best = songs[0];
      let bestScore = -1;
      for (const s of songs) {
        const cand = {
          title: s.name,
          artist: s.artists && s.artists.map((a) => a.name).join('/'),
        };
        const sc = scoreCandidate(cand, artist || '', title || '');
        if (sc > bestScore) { bestScore = sc; best = s; }
      }
      if (bestScore < 0.35) {
        console.warn(`[NetEase] 最佳匹配得分过低(${bestScore.toFixed(2)})，放弃`);
        return null;
      }

      const lyricResp = await axios.get('https://music.163.com/api/song/lyric', {
        params: { id: best.id, lv: -1, tv: -1, kv: -1 },
        headers,
        timeout: 10000,
      });
      const d = lyricResp.data || {};
      const synced = (d.lrc && d.lrc.lyric) || null;
      const translation = (d.tlyric && d.tlyric.lyric) || null;
      const plain = (!synced && d.txt && d.txt.lyric) || null;
      if (!synced && !plain) return null;
      console.log(`[NetEase] 歌词获取成功: synced=${!!synced}, translation=${!!translation}`);
      return {
        syncedLyrics: synced ? lrcToSimplified(synced) : null,
        translationLyrics: translation ? lrcToSimplified(translation) : null,
        plainLyrics: plain ? toSimplified(plain) : null,
        source: 'netease',
      };
    } catch (err) {
      console.warn(`[fetchNeteaseLyrics] 请求失败: ${err.message}`);
      return null;
    }
  },

  /** 获取一首歌的完整元数据（本地 + 在线补全） */
  async getFullSongInfo(filePath) {
    // 1. 读取本地 ID3
    const local = await this.readLocalTags(filePath);
    const hadTags = !!(local.title || local.artist);
    // 2. 如果本地标签全空，从文件名猜测
    if (!hadTags) {
      const guessed = this.guessFromFilename(filePath);
      local.title = local.title || guessed.title;
      local.artist = local.artist || guessed.artist;
    }
    console.log(`[getFullSongInfo] 本地标签: title=${local.title}, artist=${local.artist}, album=${local.album}, hasCover=${!!local.coverBase64}`);

    // 3. 在线补全：QQ 音乐（中文曲目排序质量最好）→ 名称/专辑/封面/歌词 ID
    let coverUrl = await this.readCover(filePath); // 内嵌封面按需提取优先
    let releaseMbid = null;
    let releaseTitle = null;
    let corrected = null; // { title, artist, album } 在线修正后的显示信息
    let qqSong = null;

    if (local.artist || local.title) {
      await sleep(API_DELAY_MS);
      qqSong = await this.fetchQQMusic(local.artist, local.title);
      if (qqSong) {
        console.log(`[getFullSongInfo] QQ音乐匹配得分: ${qqSong.score.toFixed(2)} → ${qqSong.artist} - ${qqSong.title} [${qqSong.album}]`);
        // 名称/歌手仅在本地无标签（来自文件名猜测）时才覆盖；专辑缺失时补全
        corrected = hadTags
          ? {
              title: local.title,
              artist: local.artist,
              album: local.album || qqSong.album,
            }
          : {
              title: qqSong.title || local.title,
              artist: qqSong.artist || local.artist,
              album: qqSong.album || local.album,
            };
        if (!coverUrl && qqSong.albummid) {
          await sleep(API_DELAY_MS);
          coverUrl = await this.fetchQQCover(qqSong.albummid);
        }
      }
    }

    // 4. 仍未获得封面 → MusicBrainz + Cover-Art-Archive
    if (!coverUrl && (local.artist || local.title)) {
      await sleep(MB_DELAY_MS);
      const mbResult = await this.searchMusicBrainz(local.artist, local.title);
      releaseMbid = mbResult.releaseMbid;
      releaseTitle = mbResult.releaseTitle;
      console.log(`[getFullSongInfo] MusicBrainz 结果: releaseMbid=${releaseMbid}, releaseTitle=${releaseTitle}`);

      if (releaseMbid) {
        await sleep(API_DELAY_MS);
        coverUrl = await this.getCoverArt(releaseMbid);
        console.log(`[getFullSongInfo] 封面结果: ${coverUrl ? '获取成功' : '无封面'}`);
      }
    }

    // 5. 歌词（全部转简体，优先带简体翻译）：
    //    本地侧车 .lrc（最高优先级）→ QQ 音乐 → 外语歌补网易云翻译 → 网易云 → LRCLIB
    let lyrics = this.readLocalLRC(filePath);
    if (lyrics) {
      console.log('[getFullSongInfo] 使用本地 LRC 歌词');
    }
    if (!lyrics && qqSong && qqSong.songmid) {
      await sleep(API_DELAY_MS);
      lyrics = await this.fetchQQLyrics(qqSong.songmid);
    }
    const displayTitle = (corrected && corrected.title) || local.title || '';
    // 外语歌：QQ 通常无翻译，用网易云补一份带简体翻译的歌词。
    // 注意：本地 LRC（source=local-lrc）是最高优先级，绝不被在线源覆盖。
    const isLocalLrc = lyrics && lyrics.source === 'local-lrc';
    if (!isLocalLrc && lyrics && !lyrics.translationLyrics && !hasChinese(displayTitle) && (local.artist || local.title)) {
      await sleep(API_DELAY_MS);
      const neLyrics = await this.fetchNeteaseLyrics(
        (corrected && corrected.artist) || local.artist,
        displayTitle
      );
      if (neLyrics && neLyrics.translationLyrics) {
        lyrics = neLyrics;
      }
    }
    if (!lyrics && (local.artist || local.title)) {
      await sleep(API_DELAY_MS);
      lyrics = await this.fetchNeteaseLyrics(
        (corrected && corrected.artist) || local.artist,
        displayTitle
      );
    }
    if (!lyrics && (local.artist || local.title)) {
      await sleep(API_DELAY_MS);
      lyrics = await this.searchLRCLib(local.artist, local.title);
      if (lyrics) {
        // LRCLIB 多为繁体，转换为简体
        lyrics.syncedLyrics = lrcToSimplified(lyrics.syncedLyrics);
        lyrics.plainLyrics = toSimplified(lyrics.plainLyrics);
      }
    }
    if (lyrics) {
      console.log(`[getFullSongInfo] 歌词结果: ${lyrics.translationLyrics ? '同步歌词+翻译' : lyrics.syncedLyrics ? '同步歌词' : '纯文本歌词'} [${lyrics.source}]`);
    }

    // 封面优先级：内嵌封面 > QQ音乐/CAA 网络封面 > default_cover.png 占位图
    if (!coverUrl) {
      const defaultCover = path.join(__dirname, 'default_cover.png');
      if (fs.existsSync(defaultCover)) {
        coverUrl = pathToFileUrl(defaultCover);
      }
    }
    return {
      filePath,
      fileUrl: pathToFileUrl(filePath),
      fileName: path.basename(filePath),
      title: (corrected && corrected.title) || local.title || '未知歌曲',
      artist: (corrected && corrected.artist) || local.artist || '未知艺术家',
      album: (corrected && corrected.album) || local.album || releaseTitle || '未知专辑',
      coverUrl, // data:base64 内嵌 / data:base64 网络 / file:// 占位图 / null
      duration: local.duration || (qqSong && qqSong.duration) || null,
      bitrate: local.bitrate,
      sampleRate: local.sampleRate,
      lyrics,
      releaseMbid,
      matchScore: qqSong ? Number(qqSong.score.toFixed(2)) : 0,
    };
  },
};

// ============================================================
// 在线账号存储（网易云 / B站），落盘到 userData/accounts.json
// ============================================================
function accountsPath() {
  return path.join(app.getPath('userData'), 'accounts.json');
}
let accountsCache = null;
function loadAccounts() {
  if (accountsCache !== null) return accountsCache;
  try {
    const p = accountsPath();
    if (fs.existsSync(p)) {
      accountsCache = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } else {
      accountsCache = {};
    }
  } catch (e) { accountsCache = {}; }
  return accountsCache;
}
function saveAccounts() {
  try {
    fs.writeFileSync(accountsPath(), JSON.stringify(accountsCache || {}, null, 2));
  } catch (e) { console.warn('[accounts] 保存失败:', e.message); }
}
function getNeteaseCookie() {
  const a = loadAccounts();
  return (a.netease && a.netease.cookie) || '';
}
function getBilibiliCookie() {
  const a = loadAccounts();
  return (a.bilibili && a.bilibili.cookie) || '';
}

// ============================================================
// 网易云 weapi 加密（/weapi/* 端点需要 params + encSecKey）
// ============================================================
const crypto = require('crypto');
const WEAPI_KEY = '0CoJUm6Qyw8W8jud';
const WEAPI_IV = Buffer.from('0102030405060708', 'utf8');
const WEAPI_PUBKEY = '010001';
const WEAPI_MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
function _aesCbcEncrypt(text, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), WEAPI_IV);
  let out = cipher.update(text, 'utf8', 'base64');
  out += cipher.final('base64');
  return out;
}
function _rsaEncrypt(text, pubKey, modulus) {
  // 网易云 weapi 的 RSA：明文反转后做模幂
  const reversed = text.split('').reverse().join('');
  const hex = Buffer.from(reversed, 'utf8').toString('hex');
  const base = BigInt('0x' + hex);
  const exp = BigInt('0x' + pubKey);
  const mod = BigInt('0x' + modulus);
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result.toString(16).padStart(256, '0');
}
function _randomStr(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function weapi(object) {
  const text = JSON.stringify(object);
  const first = _aesCbcEncrypt(text, WEAPI_KEY);
  const secKey = _randomStr(16);
  const params = _aesCbcEncrypt(first, secKey);
  const encSecKey = _rsaEncrypt(secKey, WEAPI_PUBKEY, WEAPI_MODULUS);
  return { params, encSecKey };
}

// ============================================================
// 网易云音乐 API（搜索 / 播放地址 / 登录）
// ============================================================
const NeteaseAPI = {
  /** 搜索歌曲，返回精简列表（使用 weapi cloudsearch，可直接拿到封面 picUrl） */
  async search(keyword, limit = 30) {
    if (!keyword) return [];
    const cookie = getNeteaseCookie();
    const finalCookie = cookie ? `${cookie}; os=pc; appver=2.9.7` : 'os=pc; appver=2.9.7';
    try {
      const { params, encSecKey } = weapi({ s: keyword, type: 1, limit, offset: 0 });
      const resp = await axios.post(
        'https://music.163.com/weapi/cloudsearch/get/web',
        new URLSearchParams({ params, encSecKey }).toString(),
        {
          headers: {
            'User-Agent': UA_BROWSER,
            'Referer': 'https://music.163.com/',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': finalCookie,
          },
          timeout: 10000,
        }
      );
      const songs = resp.data && resp.data.result && resp.data.result.songs;
      if (!songs || !songs.length) return [];
      return songs.map((s) => ({
        id: s.id,
        name: s.name,
        artist: (s.ar || []).map((a) => a.name).join('/'),
        album: s.al && s.al.name,
        albumId: s.al && s.al.id,
        duration: s.dt ? Math.round(s.dt / 1000) : null,
        cover: s.al && s.al.picUrl ? s.al.picUrl.replace(/^http:/, 'https:') + '?param=300y300' : null,
        // fee: 0=免费 1=VIP 8=数字专辑；plLevel=none 表示无VIP不可播放
        fee: s.fee || 0,
        playable: !(s.privilege && s.privilege.plLevel === 'none'),
      }));
    } catch (err) {
      console.warn('[Netease] 搜索失败:', err.message);
      return [];
    }
  },

  /** 获取歌曲可播放直链（优先 320kbps，无 cookie 时降级） */
  async getSongUrl(id, br = 320000) {
    const cookie = getNeteaseCookie();
    try {
      // 注意：enhance/player/url 必须带 os=pc 头，否则免费歌曲也返回 url:null
      const finalCookie = cookie ? `${cookie}; os=pc; appver=2.9.7` : 'os=pc; appver=2.9.7';
      const resp = await axios.get('https://music.163.com/api/song/enhance/player/url', {
        params: { ids: `[${id}]`, br },
        headers: {
          'User-Agent': UA_BROWSER,
          'Referer': 'https://music.163.com/',
          'Cookie': finalCookie,
        },
        timeout: 10000,
      });
      const data = resp.data && resp.data.data && resp.data.data[0];
      if (!data || !data.url) return null;
      return { url: data.url, br: data.br, size: data.size };
    } catch (err) {
      console.warn('[Netease] 获取播放地址失败:', err.message);
      return null;
    }
  },

  /** 按歌曲 ID 获取歌词（同步 LRC + 翻译 + 纯文本） */
  async getLyric(id) {
    const cookie = getNeteaseCookie();
    const finalCookie = cookie ? `${cookie}; os=pc; appver=2.9.7` : 'os=pc; appver=2.9.7';
    try {
      const { params, encSecKey } = weapi({ id, lv: -1, tv: -1, kv: -1 });
      const resp = await axios.post(
        'https://music.163.com/weapi/song/lyric',
        new URLSearchParams({ params, encSecKey }).toString(),
        {
          headers: {
            'User-Agent': UA_BROWSER,
            'Referer': 'https://music.163.com/',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': finalCookie,
          },
          timeout: 10000,
        }
      );
      const d = resp.data || {};
      const synced = (d.lrc && d.lrc.lyric) || null;
      const translation = (d.tlyric && d.tlyric.lyric) || null;
      const plain = (!synced && d.txt && d.txt.lyric) || null;
      if (!synced && !plain) return null;
      return {
        syncedLyrics: synced || null,
        translationLyrics: translation || null,
        plainLyrics: plain || null,
      };
    } catch (err) {
      console.warn('[Netease] 获取歌词失败:', err.message);
      return null;
    }
  },

  /** 发送手机验证码 */
  async sendCaptcha(phone) {
    try {
      // 注意：此接口参数名为 cellphone（不是 phone）
      const { params, encSecKey } = weapi({ cellphone: phone, ctcode: '86' });
      const resp = await axios.post(
        'https://music.163.com/weapi/sms/captcha/sent',
        new URLSearchParams({ params, encSecKey }).toString(),
        {
          headers: {
            'User-Agent': UA_BROWSER,
            'Referer': 'https://music.163.com/',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 15000,
          maxRedirects: 0,
        }
      );
      const d = resp.data || {};
      if (d.code === 200) return { success: true };
      return { success: false, message: d.message || d.msg || `发送失败 (code=${d.code})` };
    } catch (err) {
      console.warn('[Netease] 发送验证码异常:', err.message);
      return { success: false, message: err.message };
    }
  },

  /** 手机号登录（password 非空走密码登录，否则走验证码登录） */
  async loginPhone(phone, password, captcha) {
    try {
      const body = { phone, rememberLogin: true, countrycode: '86', csrf_token: '' };
      if (captcha) {
        body.captcha = captcha;
      } else {
        body.password = require('crypto').createHash('md5').update(password).digest('hex');
      }
      const { params, encSecKey } = weapi(body);
      const resp = await axios.post(
        'https://music.163.com/weapi/login/cellphone',
        new URLSearchParams({ params, encSecKey }).toString(),
        {
          headers: {
            'User-Agent': UA_BROWSER,
            'Referer': 'https://music.163.com/',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': 'os=pc; appver=2.9.7',
          },
          timeout: 15000,
          maxRedirects: 0,
        }
      );
      const d = resp.data || {};
      if (d.code === 200) {
        const setCookies = resp.headers['set-cookie'] || [];
        const cookieStr = setCookies
          .map((c) => c.split(';')[0])
          .filter((c) => c && (c.includes('MUSIC_U') || c.includes('__csrf') || c.includes('NMTID')))
          .join('; ');
        const a = loadAccounts();
        a.netease = {
          phone,
          nickname: (d.profile && d.profile.nickname) || phone,
          cookie: cookieStr,
          loginAt: Date.now(),
        };
        saveAccounts();
        return { success: true, nickname: a.netease.nickname };
      }
      return { success: false, message: d.message || d.msg || `登录失败 (code=${d.code})` };
    } catch (err) {
      console.warn('[Netease] 登录异常:', err.message);
      return { success: false, message: err.message };
    }
  },

  /**
   * 打开网易云官网登录窗口，用户手动登录（支持手机号/密码/短信/扫码）。
   * 登录成功后自动捕获 Cookie（含 HttpOnly 的 MUSIC_U）并保存。
   * 返回 Promise，登录成功 resolve(true)，窗口关闭 resolve(false)。
   */
  openLoginWindow() {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 1280,
        height: 920,
        title: '网易云音乐登录',
        parent: mainWindow,
        modal: false,
        resizable: true,
        minimizable: false,
        maximizable: true,
        webPreferences: {
          partition: 'netease-login',
        },
      });
      win.setMenuBarVisibility(false);
      win.loadURL('https://music.163.com/#/login');

      const sess = win.webContents.session;
      let done = false;
      const tryCapture = async () => {
        if (done) return;
        try {
          const cookies = await sess.cookies.get({ domain: '.music.163.com' });
          const musicU = cookies.find((c) => c.name === 'MUSIC_U');
          if (musicU && musicU.value) {
            done = true;
            const cookieStr = cookies
              .filter((c) => c.domain.includes('music.163.com'))
              .map((c) => `${c.name}=${c.value}`)
              .join('; ');
            const a = loadAccounts();
            a.netease = { cookie: cookieStr, loginAt: Date.now() };
            saveAccounts();
            try { win.close(); } catch (e) {}
            resolve(true);
          }
        } catch (e) {
          console.warn('[Netease] 捕获 Cookie 失败:', e.message);
        }
      };

      sess.cookies.on('changed', tryCapture);
      // 定时兜底检测（防止 changed 事件漏触发）
      const timer = setInterval(tryCapture, 1500);

      win.on('closed', () => {
        clearInterval(timer);
        sess.cookies.removeListener('changed', tryCapture);
        if (!done) resolve(false);
      });
    });
  },

  logout() {
    const a = loadAccounts();
    delete a.netease;
    saveAccounts();
  },

  status() {
    const a = loadAccounts();
    if (a.netease && a.netease.cookie) {
      return { loggedIn: true, nickname: a.netease.nickname, phone: a.netease.phone };
    }
    return { loggedIn: false };
  },
};

// ============================================================
// QQ音乐 API（搜索 / 二维码登录 / 播放地址）
// ============================================================
function getQQCookie() {
  const a = loadAccounts();
  return (a.qq && a.qq.cookie) || '';
}
// QQ 登录 ptqrtoken 计算
function qqHash33(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash += (hash << 5) + str.charCodeAt(i);
  }
  return hash & 0x7fffffff;
}

/** 手动跟随重定向链，合并每一跳的 Set-Cookie（同名 cookie 后跳覆盖前跳） */
async function followRedirectCookies(startUrl) {
  const jar = [];
  let current = startUrl;
  for (let i = 0; i < 8 && current; i++) {
    const r = await axios.get(current, {
      headers: { 'User-Agent': UA_BROWSER, Cookie: jar.join('; ') },
      maxRedirects: 0,
      validateStatus: (s) => s < 400,
      timeout: 15000,
    });
    (r.headers['set-cookie'] || []).forEach((c) => {
      const kv = c.split(';')[0];
      const name = kv.split('=')[0];
      const idx = jar.findIndex((j) => j.startsWith(name + '='));
      if (idx >= 0) jar[idx] = kv; else jar.push(kv);
    });
    const loc = r.headers.location;
    if (!loc || ![301, 302, 303, 307, 308].includes(r.status)) break;
    current = new URL(loc, current).href;
  }
  return jar.join('; ');
}

const QQAPI = {
  /** 生成登录二维码 */
  async getLoginQrcode() {
    try {
      const t = Date.now();
      const resp = await axios.get('https://ssl.ptlogin2.qq.com/ptqrshow', {
        params: { appid: 716027609, e: 2, l: 'M', s: 3, d: 72, v: 4, t },
        responseType: 'arraybuffer',
        headers: { 'User-Agent': UA_BROWSER },
        timeout: 15000,
      });
      const qrsig = (resp.headers['set-cookie'] || []).join(';').match(/qrsig=([^;]+)/);
      if (!qrsig) throw new Error('未获取到 qrsig');
      const img = Buffer.from(resp.data).toString('base64');
      return { qrsig: qrsig[1], img: `data:image/png;base64,${img}` };
    } catch (e) {
      console.warn('[QQ] 二维码获取失败:', e.message);
      return null;
    }
  },

  /** 轮询二维码登录状态 */
  async pollQrLogin(qrsig) {
    try {
      const ptqrtoken = qqHash33(qrsig);
      const t = Date.now();
      const resp = await axios.get('https://ssl.ptlogin2.qq.com/ptqrlogin', {
        params: {
          u1: 'https://y.qq.com/portal/profile.html',
          ptqrtoken, ptredirect: 0, h: 1, t: 1, g: 1, from_ui: 1,
          ptlang: 2052, action: `0-0-${t}`, js_ver: 24090913, js_type: 1,
          login_sig: '', pt_uistyle: 40, aid: 716027609, daid: 383, has_onekey: 1,
        },
        headers: {
          'User-Agent': UA_BROWSER,
          'Cookie': `qrsig=${qrsig}`,
          'Referer': 'https://xui.ptlogin2.qq.com/',
        },
        timeout: 15000,
      });
      // 返回格式: ptuiCB('66','0','','0','二维码未失效。', '0')
      const m = resp.data.match(/ptuiCB\('(\d+)','(\d*)','([^']*)','([^']*)','([^']*)'/);
      if (!m) return { code: -1, msg: '解析失败' };
      const code = m[1];
      if (code === '0') {
        // 登录成功，m[3] 是跳转 URL；手动跟随整条重定向链，
        // 合并每一跳 Set-Cookie（check_sig 链路会逐步下发 uin/skey/p_skey 等）
        const cookies = await followRedirectCookies(m[3]);
        return { code: 0, msg: '登录成功', cookie: cookies };
      }
      return { code: parseInt(code), msg: m[5] };
    } catch (e) {
      return { code: -1, msg: e.message };
    }
  },

  /** 保存登录态 */
  saveLogin(cookie) {
    const a = loadAccounts();
    a.qq = { cookie, loginAt: Date.now() };
    saveAccounts(a);
  },

  /** 打开 QQ 官方登录窗口（支持手机号验证码），用户手动完成滑块+短信后自动捕获 cookie */
  openSmsLoginWindow() {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 1280,
        height: 920,
        title: 'QQ音乐 登录',
        parent: mainWindow,
        modal: false,
        resizable: true,
        minimizable: false,
        maximizable: true,
        webPreferences: {
          partition: 'qq-login',
          preload: path.join(__dirname, 'login-preload.js'),
          contextIsolation: false,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      win.setMenuBarVisibility(false);
      // 允许滑块验证等弹窗
      win.webContents.setWindowOpenHandler(({ url }) => {
        return { action: 'allow', overrideBrowserWindowOptions: { parent: mainWindow } };
      });
      // 加载 QQ 音乐首页，用户在站内点击登录（在 y.qq.com 上下文中登录可绕过环境检测）
      win.loadURL('https://y.qq.com/');

      const sess = win.webContents.session;
      sess.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
      let done = false;
      const tryCapture = async () => {
        if (done) return;
        try {
          const cookies = await sess.cookies.get({ domain: '.qq.com' });
          // 登录成功后会有 p_skey / p_lskey / uin 等 cookie
          const pSkey = cookies.find((c) => c.name === 'p_skey');
          const uin = cookies.find((c) => c.name === 'uin' || c.name === 'p_uin');
          if ((pSkey && pSkey.value) || (uin && uin.value)) {
            done = true;
            const all = await sess.cookies.get({});
            const cookieStr = all
              .filter((c) => c.domain.includes('qq.com'))
              .map((c) => `${c.name}=${c.value}`)
              .join('; ');
            const a = loadAccounts();
            a.qq = { cookie: cookieStr, loginAt: Date.now() };
            saveAccounts(a);
            try { win.close(); } catch (e) {}
            resolve(true);
          }
        } catch (e) {
          console.warn('[QQ] 捕获 Cookie 失败:', e.message);
        }
      };

      sess.cookies.on('changed', tryCapture);
      win.webContents.on('did-navigate', (_e, u) => {
        if (u.includes('y.qq.com') && !u.includes('ptlogin')) tryCapture();
      });
      win.on('closed', () => {
        sess.cookies.removeListener('changed', tryCapture);
        if (!done) resolve(false);
      });
    });
  },

  logout() {
    const a = loadAccounts();
    delete a.qq;
    saveAccounts(a);
  },

  status() {
    const a = loadAccounts();
    return { loggedIn: !!(a.qq && a.qq.cookie) };
  },

  /** 搜索歌曲 */
  async search(keyword, limit = 30) {
    if (!keyword) return [];
    try {
      const resp = await axios.get('https://c.y.qq.com/soso/fcgi-bin/client_search_cp', {
        params: { w: keyword, format: 'json', p: 1, n: limit },
        headers: {
          'User-Agent': UA_BROWSER,
          'Referer': 'https://y.qq.com/',
        },
        timeout: 10000,
      });
      const list = resp.data && resp.data.data && resp.data.data.song && resp.data.data.song.list;
      if (!list) return [];
      return list.map((s) => ({
        songmid: s.songmid,
        songid: s.songid,
        name: s.songname,
        artist: (s.singer || []).map((x) => x.name).join('/'),
        album: s.albumname,
        duration: s.interval,
        cover: s.albummid ? `https://y.qq.com/music/photo_new/T002R300x300M000${s.albummid}.jpg` : null,
        // VIP 标识：payplay=1 需付费/VIP，isonly=1 仅 VIP
        vip: (s.pay && s.pay.payplay === 1) || s.isonly === 1,
        payplay: s.pay ? s.pay.payplay : 0,
      }));
    } catch (e) {
      console.warn('[QQ] 搜索失败:', e.message);
      return [];
    }
  },

  /** 获取歌曲播放地址 */
  async getSongUrl(songmid) {
    const cookie = getQQCookie();
    const uinMatch = cookie && cookie.match(/p_uin=o?(\d+)/);
    const uin = uinMatch ? uinMatch[1] : '0';
    try {
      const guid = String(Math.floor(Math.random() * 1e10));
      // 尝试多种音质格式：M500(128k mp3) → M800(320k) → C400(128k m4a)
      const formats = ['M500', 'M800', 'C400'];
      for (const prefix of formats) {
        const ext = prefix === 'C400' ? 'm4a' : 'mp3';
        const filename = `${prefix}${songmid}.${ext}`;
        const data = {
          req: { module: 'CDN.SrfCdnDispatchServer', method: 'GetCdnDispatch', param: { guid, calltype: 0, userip: '' } },
          req_0: {
            module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
            param: { filename: [filename], guid, songmid: [songmid], songtype: [0], uin, loginflag: 1, platform: '20' },
          },
        };
        const resp = await axios.get('https://u.y.qq.com/cgi-bin/musicu.fcg', {
          params: { data: JSON.stringify(data) },
          headers: {
            'User-Agent': UA_BROWSER,
            'Referer': 'https://y.qq.com/',
            'Cookie': cookie || '',
          },
          timeout: 10000,
        });
        const d = resp.data && resp.data.req_0 && resp.data.req_0.data;
        const info = d && d.midurlinfo && d.midurlinfo[0];
        const sip = (d && d.sip) || ['https://dl.stream.qqmusic.qq.com/'];
        if (info && info.purl) {
          let cdn = sip[0] || 'https://dl.stream.qqmusic.qq.com/';
          // http 转 https，避免混合内容
          cdn = cdn.replace(/^http:/, 'https:');
          return { url: cdn + info.purl };
        }
      }
      return null;
    } catch (e) {
      console.warn('[QQ] 获取播放地址失败:', e.message);
      return null;
    }
  },

  /** 获取歌词 */
  async getLyric(songmid) {
    try {
      const resp = await axios.get('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
        params: { songmid, format: 'json', nobase64: 1 },
        headers: {
          'User-Agent': UA_BROWSER,
          'Referer': 'https://y.qq.com/',
        },
        timeout: 10000,
      });
      return {
        lyric: resp.data.lyric || '',
        trans: resp.data.trans || '',
      };
    } catch (e) {
      console.warn('[QQ] 获取歌词失败:', e.message);
      return { lyric: '', trans: '' };
    }
  },
};

// ============================================================
// B站 API（搜索 MV / 获取播放地址 / 二维码登录）
// ============================================================
const BilibiliAPI = {
  /** 搜索视频（MV） */
  async search(keyword, limit = 15) {
    if (!keyword) return [];
    const cookie = getBilibiliCookie();
    try {
      const resp = await axios.get('https://api.bilibili.com/x/web-interface/search/type', {
        params: { search_type: 'video', keyword, page_size: limit, page: 1 },
        headers: {
          'User-Agent': UA_BROWSER,
          'Referer': 'https://www.bilibili.com/',
          'Cookie': cookie || '',
        },
        timeout: 10000,
      });
      const list = resp.data && resp.data.data && resp.data.data.result;
      if (!list || !list.length) return [];
      return list.slice(0, limit).map((v) => ({
        bvid: v.bvid,
        title: (v.title || '').replace(/<[^>]+>/g, ''),
        author: v.author,
        cover: v.pic ? (v.pic.startsWith('//') ? 'https:' + v.pic : v.pic) : null,
        duration: v.duration,
        play: v.play,
      }));
    } catch (err) {
      console.warn('[Bilibili] 搜索失败:', err.message);
      return [];
    }
  },

  /** 通过 bvid 获取视频直链（优先 1080P，progressive 不可用时走 DASH） */
  async getVideoUrl(bvid, qn = 80) {
    const cookie = getBilibiliCookie();
    try {
      const viewResp = await axios.get('https://api.bilibili.com/x/web-interface/view', {
        params: { bvid },
        headers: {
          'User-Agent': UA_BROWSER,
          'Referer': `https://www.bilibili.com/video/${bvid}`,
          'Cookie': cookie || '',
        },
        timeout: 10000,
      });
      const cid = viewResp.data && viewResp.data.data && viewResp.data.data.cid;
      if (!cid) return null;

      const fetchPlayurl = async (fnval) => {
        const r = await axios.get('https://api.bilibili.com/x/player/playurl', {
          params: { bvid, cid, qn, fnval, fnver: 0 },
          headers: {
            'User-Agent': UA_BROWSER,
            'Referer': `https://www.bilibili.com/video/${bvid}`,
            'Cookie': cookie || '',
          },
          timeout: 10000,
        });
        return r.data && r.data.data;
      };

      // 1. 先试 progressive (fnval=0)，若已达 1080P 直接用
      const prog = await fetchPlayurl(0);
      if (prog && prog.durl && prog.durl[0] && prog.durl[0].url && prog.quality >= qn) {
        return { url: prog.durl[0].url, cid, quality: prog.quality };
      }

      // 2. progressive 不够清晰，试 DASH (fnval=16) 拿 1080P
      const dashData = await fetchPlayurl(16);
      if (dashData && dashData.dash && dashData.dash.video && dashData.dash.video.length) {
        // 选最接近请求清晰度的视频流
        const v = dashData.dash.video.find((x) => x.id === qn) || dashData.dash.video[0];
        const a = dashData.dash.audio && dashData.dash.audio[0];
        if (v && v.baseUrl && a && a.baseUrl) {
          return {
            url: v.baseUrl,
            audioUrl: a.baseUrl,
            videoCodec: v.codecs || 'avc1.4d401f',
            audioCodec: a.codecs || 'mp4a.40.2',
            cid,
            quality: v.id || dashData.quality,
            dash: true,
          };
        }
      }

      // 3. 降级：用 progressive 的最高可用画质
      if (prog && prog.durl && prog.durl[0] && prog.durl[0].url) {
        return { url: prog.durl[0].url, cid, quality: prog.quality };
      }
      // 4. 再降级到 720P
      if (qn !== 64) {
        return await this.getVideoUrl(bvid, 64);
      }
      return null;
    } catch (err) {
      console.warn('[Bilibili] 获取视频地址失败:', err.message);
      return null;
    }
  },

  /** 生成登录二维码（返回可直接显示的图片 data URL，避免 iframe 被 X-Frame-Options 拦截） */
  async getLoginQrcode() {
    try {
      const QRCode = require('qrcode');
      const resp = await axios.get('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
        headers: { 'User-Agent': UA_BROWSER },
        timeout: 10000,
      });
      const d = resp.data && resp.data.data;
      if (!d) return null;
      // 将登录 URL 渲染为二维码图片 data URL
      const dataUrl = await QRCode.toDataURL(d.url, { width: 300, margin: 1, color: { dark: '#000', light: '#fff' } });
      return { qrcodeKey: d.qrcode_key, qrDataUrl: dataUrl, url: d.url };
    } catch (err) {
      console.warn('[Bilibili] 生成二维码失败:', err.message);
      return null;
    }
  },

  /** 轮询二维码扫码状态 */
  async pollQrcode(qrcodeKey) {
    try {
      const resp = await axios.get('https://passport.bilibili.com/x/passport-login/web/qrcode/poll', {
        params: { qrcode_key: qrcodeKey },
        headers: { 'User-Agent': UA_BROWSER },
        timeout: 10000,
        maxRedirects: 0,
      });
      const d = resp.data && resp.data.data;
      if (!d) return { code: -1, message: '未知错误' };
      // code: 0=登录成功, 86038=已失效, 86090=未扫描, 86101=已扫描未确认
      if (d.code === 0) {
        const setCookies = resp.headers['set-cookie'] || [];
        const cookieStr = setCookies
          .map((c) => c.split(';')[0])
          .filter(Boolean)
          .join('; ');
        const a = loadAccounts();
        a.bilibili = {
          cookie: cookieStr,
          loginAt: Date.now(),
        };
        saveAccounts();
        return { code: 0, message: '登录成功' };
      }
      return { code: d.code, message: d.message || '' };
    } catch (err) {
      return { code: -1, message: err.message };
    }
  },

  /**
   * 打开 B站 官方登录窗口进行短信/手机号登录。
   * B站 短信登录需要极验滑块验证，无法直接 API 调用，
   * 因此打开官方登录页让用户手动完成（滑块 + 短信验证码），
   * 登录成功后自动捕获 Cookie 并保存。
   * 返回 Promise，登录成功 resolve(true)，窗口关闭 resolve(false)。
   */
  openSmsLoginWindow() {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 1280,
        height: 920,
        title: 'B站 登录',
        parent: mainWindow,
        modal: false,
        resizable: true,
        minimizable: false,
        maximizable: true,
        webPreferences: {
          partition: 'bilibili-login',
        },
      });
      win.setMenuBarVisibility(false);
      win.loadURL('https://passport.bilibili.com/login');

      const sess = win.webContents.session;
      let done = false;
      const tryCapture = async () => {
        if (done) return;
        try {
          const cookies = await sess.cookies.get({ domain: '.bilibili.com' });
          const sessData = cookies.find((c) => c.name === 'SESSDATA');
          if (sessData && sessData.value) {
            done = true;
            const cookieStr = cookies
              .filter((c) => c.domain.includes('bilibili.com'))
              .map((c) => `${c.name}=${c.value}`)
              .join('; ');
            const a = loadAccounts();
            a.bilibili = { cookie: cookieStr, loginAt: Date.now() };
            saveAccounts();
            try { win.close(); } catch (e) {}
            resolve(true);
          }
        } catch (e) {
          console.warn('[Bilibili] 捕获 Cookie 失败:', e.message);
        }
      };

      // 监听 Cookie 变化
      sess.cookies.on('changed', tryCapture);

      // 监听导航：登录成功后可能跳转到 bilibili.com
      win.webContents.on('did-navigate', (_e, url) => {
        if (url.includes('bilibili.com') && !url.includes('passport.bilibili.com/login')) {
          tryCapture();
        }
      });

      win.on('closed', () => {
        sess.cookies.removeListener('changed', tryCapture);
        if (!done) resolve(false);
      });
    });
  },

  logout() {
    const a = loadAccounts();
    delete a.bilibili;
    saveAccounts();
  },

  status() {
    const a = loadAccounts();
    if (a.bilibili && a.bilibili.cookie) {
      return { loggedIn: true };
    }
    return { loggedIn: false };
  },
};

// ============================================================
// 元数据磁盘缓存（分片版）：避免每次启动都重新刮取
// 缓存 key = 文件路径；有效性 = 文件存在 + mtime + size 未变 + 目录 LRC 指纹未变
// 缓存目录位于 app.getPath('userData')/meta-cache/，按路径 hash 分 16 个分片文件
// ============================================================
const META_CACHE_VERSION = 3;
const META_SHARD_COUNT = 16;

/** 计算文件路径对应的分片 ID（charCode 求和 mod 16） */
function shardIdForPath(filePath) {
  let h = 0;
  for (let i = 0; i < filePath.length; i++) h = (h + filePath.charCodeAt(i)) & 0x7fffffff;
  return h % 16;
}

/** 分片缓存目录 */
function metaCacheDir() {
  return path.join(app.getPath('userData'), 'meta-cache');
}

/** 单个分片文件路径 */
function shardPath(shardId) {
  return path.join(metaCacheDir(), `shard-${String(shardId).padStart(2, '0')}.json`);
}

// 按需加载的分片内存缓存：Map<shardId, {entries, dirty}>
const metaShards = new Map();
// 每个分片独立的防抖定时器：Map<shardId, timer>
const metaShardTimers = new Map();

/** 旧版 metadata-cache.json 迁移到 16 个分片（首次运行时执行一次） */
let metaMigrationDone = false;
function migrateOldMetaCache() {
  if (metaMigrationDone) return;
  metaMigrationDone = true;
  const oldPath = path.join(app.getPath('userData'), 'metadata-cache.json');
  if (!fs.existsSync(oldPath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(oldPath, 'utf-8'));
    if (raw && raw.entries) {
      const count = Object.keys(raw.entries).length;
      console.log(`[meta-cache] 迁移旧版缓存: ${count} 条 → 16 分片`);
      fs.mkdirSync(metaCacheDir(), { recursive: true });
      const buckets = Array.from({ length: META_SHARD_COUNT }, () => ({}));
      for (const [fp, entry] of Object.entries(raw.entries)) {
        const sid = shardIdForPath(fp);
        buckets[sid][fp] = entry;
      }
      for (let i = 0; i < META_SHARD_COUNT; i++) {
        if (Object.keys(buckets[i]).length > 0) {
          fs.writeFileSync(shardPath(i), JSON.stringify({ version: META_CACHE_VERSION, entries: buckets[i] }));
        }
      }
      console.log('[meta-cache] 旧版缓存迁移完成');
    }
    // 删除旧文件
    fs.unlinkSync(oldPath);
    console.log('[meta-cache] 已删除旧版 metadata-cache.json');
  } catch (err) {
    console.warn(`[meta-cache] 旧版缓存迁移失败: ${err.message}`);
  }
}

/** 按需加载单个分片（首次访问时从磁盘读取，缓存在内存 Map 中） */
function loadMetaShard(shardId) {
  if (metaShards.has(shardId)) return metaShards.get(shardId);
  migrateOldMetaCache();
  const shard = { entries: {}, dirty: false };
  try {
    const p = shardPath(shardId);
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (raw && raw.version === META_CACHE_VERSION && raw.entries) {
        shard.entries = raw.entries;
        console.log(`[meta-cache] 已加载分片 ${shardId}: ${Object.keys(shard.entries).length} 条`);
      } else {
        console.log(`[meta-cache] 分片 ${shardId} 版本不兼容，重新建立`);
      }
    }
  } catch (err) {
    console.warn(`[meta-cache] 读取分片 ${shardId} 失败: ${err.message}`);
  }
  metaShards.set(shardId, shard);
  return shard;
}

// LRC 指纹按目录缓存：Map<dirPath, {fp, dirMtime}>
const lrcFingerprintCache = new Map();

/** 收集目录下所有 .lrc 文件的指纹（文件名:mtime），用于判断歌词是否变化。
 *  先检查目录 mtime 是否变化，未变则直接返回缓存的指纹。 */
function getLrcFingerprint(dir) {
  let dirMtime;
  try { dirMtime = fs.statSync(dir).mtimeMs; }
  catch (err) { return ''; }
  const cached = lrcFingerprintCache.get(dir);
  if (cached && cached.dirMtime === dirMtime) return cached.fp;
  // 目录 mtime 变化（或首次访问），重新扫描
  let fp = '';
  try {
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.lrc'));
    fp = files.map((f) => {
      try { return `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`; }
      catch (err) { return null; }
    }).filter(Boolean).sort().join('|');
  } catch (err) { fp = ''; }
  lrcFingerprintCache.set(dir, { fp, dirMtime });
  return fp;
}

/** 检查缓存是否有效（音频文件 mtime/size 未变 + 目录下所有 .lrc 文件未变） */
function getCachedMeta(filePath) {
  const shardId = shardIdForPath(filePath);
  const shard = loadMetaShard(shardId);
  const entry = shard.entries[filePath];
  if (!entry) return null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs !== entry.mtime || stat.size !== entry.size) return null;
  } catch (err) { /* 音频文件已删除，缓存失效 */ return null; }
  // 侧车 LRC 文件（含模糊匹配）：目录下任一 .lrc 增删改都失效
  const fp = getLrcFingerprint(path.dirname(filePath));
  if (fp !== (entry.lrcFingerprint || '')) return null;
  return entry.info;
}

/** 写入缓存并标记对应分片待持久化 */
function setCachedMeta(filePath, info) {
  const shardId = shardIdForPath(filePath);
  const shard = loadMetaShard(shardId);
  try {
    const stat = fs.statSync(filePath);
    shard.entries[filePath] = {
      mtime: stat.mtimeMs,
      size: stat.size,
      lrcFingerprint: getLrcFingerprint(path.dirname(filePath)),
      info,
    };
    shard.dirty = true;
    scheduleSaveShard(shardId);
  } catch (err) { /* 文件不存在，跳过缓存 */ }
}

/** 防抖持久化单个分片到磁盘（3 秒合并写入一次） */
function scheduleSaveShard(shardId) {
  if (metaShardTimers.has(shardId)) return;
  const timer = setTimeout(() => {
    metaShardTimers.delete(shardId);
    const shard = metaShards.get(shardId);
    if (!shard || !shard.dirty) return;
    try {
      fs.mkdirSync(metaCacheDir(), { recursive: true });
      fs.writeFileSync(shardPath(shardId), JSON.stringify({ version: META_CACHE_VERSION, entries: shard.entries }));
      shard.dirty = false;
      console.log(`[meta-cache] 已保存分片 ${shardId}: ${Object.keys(shard.entries).length} 条`);
    } catch (err) {
      console.warn(`[meta-cache] 保存分片 ${shardId} 失败: ${err.message}`);
    }
  }, 3000);
  metaShardTimers.set(shardId, timer);
}

// 退出前强制保存所有 dirty 分片
app.on('before-quit', () => {
  isQuiting = true; // 确保托盘模式下 quit 不被 close 拦截
  mpvEngine.quit();  // 关停 mpv 引擎，释放独占设备
  hwVolume.stop();   // 关闭硬件音量控制进程
  for (const [shardId, shard] of metaShards) {
    if (!shard.dirty) continue;
    try {
      fs.mkdirSync(metaCacheDir(), { recursive: true });
      fs.writeFileSync(shardPath(shardId), JSON.stringify({ version: META_CACHE_VERSION, entries: shard.entries }));
      shard.dirty = false;
    } catch (err) { /* 忽略 */ }
  }
});

// ============================================================
// 元数据队列处理（并发池，最多 3 个同时处理，在线源限流）
// 缓存命中不延迟，在线源完成后 sleep(300) 限流
// ============================================================
const metaConcurrency = 3;

async function processMetaQueue() {
  if (isProcessingMeta || metaQueue.length === 0) return;
  isProcessingMeta = true;
  let active = 0;

  return new Promise((resolve) => {
    function maybeDone() {
      if (active === 0 && metaQueue.length === 0) {
        isProcessingMeta = false;
        resolve();
      }
    }

    function schedule() {
      while (active < metaConcurrency && metaQueue.length > 0) {
        const { filePath, sender } = metaQueue.shift();
        active++;
        processOne(filePath, sender).then(() => {
          active--;
          schedule();
          maybeDone();
        });
      }
      maybeDone();
    }

    async function processOne(filePath, sender) {
      let wasCacheHit = false;
      try {
        // 先查磁盘缓存，命中则直接返回（不重新刮取）
        const cached = getCachedMeta(filePath);
        let info;
        if (cached) {
          wasCacheHit = true;
          info = cached;
          // 本地歌词永远是最高优先级：即使命中缓存也每次重新检查侧车 .lrc，
          // 有本地歌词就覆盖缓存里的在线歌词（用户后补 .lrc 也能立即生效）
          const localLrc = MusicMetaFetcher.readLocalLRC(filePath);
          if (localLrc) {
            if (!info.lyrics || info.lyrics.source !== 'local-lrc') {
              console.log(`[meta-cache] 命中且检测到本地歌词，覆盖为本地: ${path.basename(filePath)}`);
            }
            info.lyrics = localLrc;
          }
          console.log(`[meta-cache] 命中: ${path.basename(filePath)}`);
        } else {
          info = await MusicMetaFetcher.getFullSongInfo(filePath);
          setCachedMeta(filePath, info);
        }
        if (!sender.isDestroyed()) {
          sender.send('song-info-result', { success: true, info });
        }
      } catch (err) {
        console.error(`[processMetaQueue] 处理失败: ${filePath} — ${err.message}`);
        if (!sender.isDestroyed()) {
          sender.send('song-info-result', {
            success: false,
            filePath,
            error: err.message,
          });
        }
      }
      // 在线源需要限流（缓存命中不延迟，立即处理下一个）
      if (!wasCacheHit) await sleep(300);
    }

    schedule();
  });
}

function enqueueMetaRequest(filePath, sender) {
  metaQueue.push({ filePath, sender });
  processMetaQueue();
}

// ============================================================
// 窗口创建
// ============================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: IS_DEV ? 1200 : 1280,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'MSP Music',
    frame: false,
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'default_cover.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  // 移除默认菜单栏
  mainWindow.setMenu(null);

  mainWindow.loadFile('index.html');

  // 渲染进程诊断：控制台错误 / 崩溃 / 卡死 → 主进程日志
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer-gone]', JSON.stringify(details));
  });
  mainWindow.webContents.on('unresponsive', () => console.error('[renderer] unresponsive'));
  mainWindow.on('child-process-gone', (_e, details) => {
    console.error('[child-process-gone]', JSON.stringify(details));
  });

  // 诊断：--nav-test 启动后自动点击各视图，经 window error 事件捕获渲染进程 JS 报错
  if (process.argv.includes('--nav-test')) {
    setTimeout(async () => {
      try {
        const res = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            window.__navErrs = [];
            window.addEventListener('error', (e) => window.__navErrs.push((e.message || 'err') + ' @' + (e.filename || '') + ':' + e.lineno));
            const click = (id) => { const el = document.getElementById(id); if (!el) { window.__navErrs.push('missing #' + id); return; } el.click(); };
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const seq = ['nav-home', 'nav-playlist', 'nav-album', 'nav-favorites', 'nav-audio', 'nav-tune', 'nav-home', 'settings-btn', 'menu-dirs', 'menu-preview', 'menu-playback', 'menu-theme', 'menu-accounts', 'menu-about', 'menu-logs', 'nav-home'];
            for (const id of seq) { click(id); await wait(350); }
            // 信号路径面板开合测试
            let spResult = 'no-sp-btn';
            const sp = document.getElementById('sp-btn');
            if (sp) {
              sp.click(); await wait(300);
              const panel = document.getElementById('signal-panel');
              const opened = panel && panel.style.display !== 'none' && panel.innerHTML.length > 100;
              sp.click(); await wait(200);
              const closed = panel && panel.style.display === 'none';
              spResult = 'panel open=' + opened + ' closed=' + closed + (opened ? ' len=' + panel.innerHTML.length : '');
            }
            return (window.__navErrs.length ? window.__navErrs.join(' || ') : 'ALL OK') + ' / ' + spResult;
          })()
        `, true);
        console.log('[nav-test]', res);
      } catch (e) { console.error('[nav-test] execute failed:', e.message); }
    }, 7000);
  }

  // 最大化/还原状态变化 → 通知渲染进程切换图标
  const sendMaximizeState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('win-maximize-changed', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaximizeState);
  mainWindow.on('unmaximize', sendMaximizeState);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 关闭拦截：非真正退出时转发给渲染进程，弹出应用内确认模态
  mainWindow.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('close-requested');
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================================
// 系统托盘（关闭后可最小化到托盘，音乐继续播放）
// ============================================================
function trayPrefsPath() {
  return path.join(app.getPath('userData'), 'tray-prefs.json');
}
function loadTrayPrefs() {
  try {
    const p = trayPrefsPath();
    if (fs.existsSync(p)) trayPrefs = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) { /* 忽略损坏的偏好文件 */ }
}
function saveTrayPrefs() {
  try { fs.writeFileSync(trayPrefsPath(), JSON.stringify(trayPrefs)); } catch (e) { /* 忽略 */ }
}

function showMainWindow() {
  if (!mainWindow) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createTray() {
  let iconImg;
  try {
    iconImg = nativeImage.createFromPath(path.join(__dirname, 'default_cover.png'));
    if (!iconImg.isEmpty()) iconImg = iconImg.resize({ width: 16, height: 16 });
  } catch (e) {
    iconImg = nativeImage.createEmpty();
  }
  tray = new Tray(iconImg);
  tray.setToolTip('MSP Music');
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: '退出 MSP Music',
      click: () => { isQuiting = true; app.quit(); },
    },
  ]);
  tray.setContextMenu(contextMenu);
  // 单击托盘图标：恢复并聚焦窗口
  tray.on('click', () => showMainWindow());
}

// 自定义标题栏窗口控制
ipcMain.on('win-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.on('win-toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win-close', () => {
  if (mainWindow) mainWindow.close();
});
ipcMain.handle('win-is-maximized', () => (mainWindow ? mainWindow.isMaximized() : false));

// ── 系统托盘 / 关闭确认（应用内模态决策后调用） ──
// 隐藏到托盘：音乐继续播放，不触发 close 事件
ipcMain.on('win-hide-to-tray', () => {
  if (mainWindow) mainWindow.hide();
});
// 真正退出应用
ipcMain.on('win-quit-app', () => {
  isQuiting = true;
  app.quit();
});
// 同步「始终最小化到托盘」偏好到主进程并落盘
ipcMain.on('win-set-tray-pref', (_event, minimize) => {
  trayPrefs.minimizeToTray = !!minimize;
  saveTrayPrefs();
});
// 读取主进程已保存的托盘偏好（用于旧版本偏好迁移到渲染端）
ipcMain.handle('win-get-tray-pref', () => trayPrefs.minimizeToTray === true);

// 选择自定义背景图片或视频：复制到 userData/backgrounds（原文件被删/移动后背景仍在），返回 file:// URL
ipcMain.handle('pick-bg-image', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择背景图片或视频',
    properties: ['openFile'],
    filters: [
      { name: '图片/视频文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'mp4', 'webm', 'ogv', 'm4v', 'mov'] },
    ],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true };
  const src = res.filePaths[0];
  const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/#/g, '%23');
  try {
    const destDir = path.join(app.getPath('userData'), 'backgrounds');
    fs.mkdirSync(destDir, { recursive: true });
    // 清掉旧背景（扩展名可能不同）
    try {
      fs.readdirSync(destDir)
        .filter((f) => f.startsWith('custom-bg'))
        .forEach((f) => fs.unlinkSync(path.join(destDir, f)));
    } catch (e) { /* 忽略 */ }
    const ext = (path.extname(src) || '.png').toLowerCase();
    const dest = path.join(destDir, 'custom-bg' + ext);
    fs.copyFileSync(src, dest);
    return { canceled: false, url: toUrl(dest) };
  } catch (e) {
    console.log('[IPC] 背景复制失败，直接使用原路径:', e.message);
    return { canceled: false, url: toUrl(src) };
  }
});

// 读取当前自定义背景图为 dataURL（导出配置时把图片/视频一并内嵌进 .msp，不做体积限制）
ipcMain.handle('read-bg-dataurl', () => {
  try {
    const destDir = path.join(app.getPath('userData'), 'backgrounds');
    const files = fs.readdirSync(destDir).filter((f) => f.startsWith('custom-bg'));
    if (!files.length) return { ok: false };
    const fp = path.join(destDir, files[0]);
    const ext = (path.extname(fp) || '.png').slice(1).toLowerCase();
    const IMAGE_MIMES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };
    const VIDEO_MIMES = { mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', m4v: 'video/x-m4v', mov: 'video/quicktime' };
    const mime = IMAGE_MIMES[ext] || VIDEO_MIMES[ext];
    if (!mime) return { ok: false };
    return { ok: true, dataUrl: `data:${mime};base64,${fs.readFileSync(fp).toString('base64')}` };
  } catch (e) {
    return { ok: false };
  }
});

// 把导入配置/拖入文件中的背景 dataURL 落盘到 backgrounds 目录（图片+视频），返回 file:// URL
ipcMain.handle('write-bg-dataurl', (dataUrl) => {
  try {
    const m = /^data:((?:image\/(?:png|jpeg|webp|gif|bmp))|(?:video\/(?:mp4|webm|ogg|x-m4v|quicktime)));base64,(.+)$/.exec(dataUrl || '');
    if (!m) return { ok: false };
    const extMap = {
      'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp',
      'video/mp4': '.mp4', 'video/webm': '.webm', 'video/ogg': '.ogv', 'video/x-m4v': '.m4v', 'video/quicktime': '.mov',
    };
    const destDir = path.join(app.getPath('userData'), 'backgrounds');
    fs.mkdirSync(destDir, { recursive: true });
    try {
      fs.readdirSync(destDir).filter((f) => f.startsWith('custom-bg')).forEach((f) => fs.unlinkSync(path.join(destDir, f)));
    } catch (e) { /* 忽略 */ }
    const dest = path.join(destDir, 'custom-bg' + extMap[m[1]]);
    fs.writeFileSync(dest, Buffer.from(m[2], 'base64'));
    return { ok: true, url: 'file:///' + dest.replace(/\\/g, '/').replace(/#/g, '%23') };
  } catch (e) {
    console.log('[IPC] 背景落盘失败:', e.message);
    return { ok: false };
  }
});

// 导出配置：弹保存对话框写入 .msp 文件（内容为 JSON）
ipcMain.handle('save-config-file', async (_event, jsonStr) => {
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const defaultName = `MSPMusic配置-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}.msp`;
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出 MSP Music 配置',
    defaultPath: defaultName,
    filters: [{ name: 'MSP Music 配置', extensions: ['msp'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  fs.writeFileSync(res.filePath, jsonStr, 'utf8');
  return { canceled: false, path: res.filePath };
});

// 导入配置：弹打开对话框读取 .msp/.json 文件
ipcMain.handle('open-config-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '导入 MSP Music 配置',
    properties: ['openFile'],
    filters: [{ name: 'MSP Music 配置', extensions: ['msp', 'json'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true };
  try {
    return { canceled: false, content: fs.readFileSync(res.filePaths[0], 'utf8') };
  } catch (e) {
    return { canceled: false, error: e.message };
  }
});

// ============================================================
// IPC 处理
// ============================================================

/** 选择文件夹 → 扫描音频文件 → 返回文件列表 */
ipcMain.handle('select-folder', async () => {
  console.log('[IPC] 开始选择文件夹');
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择音乐文件夹',
  });
  console.log(`[IPC] 文件夹选择结果: ${result.canceled ? '取消' : '成功'}`);
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { canceled: true, files: [] };
  }
  const dirPath = result.filePaths[0];
  console.log(`[IPC] 扫描目录: ${dirPath}`);
  const files = await scanAudioFiles(dirPath);
  console.log(`[IPC] 扫描到 ${files.length} 个曲目（含 CUE 分轨）`);
  // 返回基础信息，普通曲目元数据后续逐个请求；CUE 虚拟轨已自带标题/艺术家/专辑
  return { canceled: false, dirPath, files };
});

/** 重新扫描已选择的音乐文件夹（不弹对话框），用于刷新音乐库、刮取新歌 */
ipcMain.handle('scan-folder', async (event, dirPath) => {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return { error: '文件夹不存在', files: [] };
  }
  try {
    console.log(`[IPC] 重新扫描目录: ${dirPath}`);
    const files = await scanAudioFiles(dirPath);
    console.log(`[IPC] 扫描到 ${files.length} 个曲目（含 CUE 分轨）`);
    // 大规模曲库：在返回前通知前端，便于显示进度提示
    if (files.length > 500 && event.sender && !event.sender.isDestroyed()) {
      event.sender.send('large-library-detected', { count: files.length, dirPath });
    }
    return { files, dirPath, count: files.length };
  } catch (err) {
    return { error: err.message, files: [] };
  }
});

/** 请求单首歌曲的完整元数据（加入队列串行处理） */
ipcMain.on('request-song-info', (event, filePath) => {
  console.log(`[IPC] 收到元数据请求: ${filePath}`);
  if (!filePath) return;
  enqueueMetaRequest(filePath, event.sender);
});

// ───────────────────────── 局域网互通 ─────────────────────────

function lanConfigPath() {
  return path.join(app.getPath('userData'), 'lan-config.json');
}
function lanPairedPath() {
  return path.join(app.getPath('userData'), 'lan-paired.json');
}
function lanServerHooks() {
  return {
    // 按需读内嵌封面（返回 {format, dataBase64}）
    readCover: async (filePath) => {
      const dataUrl = await MusicMetaFetcher.readCover(filePath);
      if (!dataUrl) return null;
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
      return m ? { format: m[1], dataBase64: m[2] } : null;
    },
    // 侧车歌词（带时间轴原文）
    readLrc: (filePath) => {
      const lrc = MusicMetaFetcher.readLocalLRC(filePath);
      return lrc ? lrc.syncedLyrics : null;
    },
  };
}
/** 启动参数（带持久化配对码与已配对设备表）；首次启动生成的 pin 回写配置 */
async function startLanWithConfig(cfg) {
  const r = await lanServer.start({
    name: cfg.name || undefined,
    pin: cfg.pin || undefined,
    pairedFile: lanPairedPath(),
    hooks: lanServerHooks(),
  });
  if (r.pin && r.pin !== cfg.pin) {
    cfg.pin = r.pin;
    writeLanConfig(cfg);
  }
  return r;
}
function readLanConfig() {
  try {
    return JSON.parse(fs.readFileSync(lanConfigPath(), 'utf-8'));
  } catch (e) { return { enabled: false, name: '' }; }
}
function writeLanConfig(cfg) {
  try { fs.writeFileSync(lanConfigPath(), JSON.stringify(cfg, null, 2), 'utf-8'); }
  catch (e) { console.warn('[LAN] 配置写入失败:', e.message); }
}

ipcMain.handle('lan:get-status', () => lanServer.getStatus(readLanConfig()));

/** 开关局域网服务：{ enabled:boolean, name?:string } */
ipcMain.handle('lan:set', async (_event, opts) => {
  const cfg = readLanConfig();
  if (typeof opts.name === 'string') cfg.name = opts.name.trim().slice(0, 40);
  if (typeof opts.enabled === 'boolean') cfg.enabled = opts.enabled;
  writeLanConfig(cfg);
  try {
    if (cfg.enabled && !lanServer.isRunning()) {
      const r = await startLanWithConfig(cfg);
      return { ok: true, ...r };
    }
    if (!cfg.enabled && lanServer.isRunning()) lanServer.stop();
    if (cfg.enabled && cfg.name) lanServer.setName(cfg.name);
    return { ok: true, ...lanServer.getStatus(cfg) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** 更换配对码（不影响已配对设备） */
ipcMain.handle('lan:regen-pin', () => {
  const pin = lanServer.regenPin();
  if (pin) {
    const cfg = readLanConfig();
    cfg.pin = pin;
    writeLanConfig(cfg);
  }
  return pin;
});

/** 解除已配对设备（id 为 token 前 8 位） */
ipcMain.handle('lan:unpair', (_e, id) => lanServer.unpair(String(id || '')));

/** 附近的手机共享端（需本机共享已开启，UDP 发现套接字才在监听） */
ipcMain.handle('lan:get-peers', () => lanServer.getPeers());

/**
 * 代渲染端请求手机共享端（规避渲染端 CSP/CORS；音频流与封面仍由标签直连）
 * {base, method?, path, body?, token?} → {status, data}
 */
ipcMain.handle('lan:peer-request', async (_e, req) => {
  try {
    if (!req || !req.base || !req.path) return { status: 0, error: 'bad args' };
    const url = req.base.replace(/\/+$/, '') + req.path;
    const headers = { Accept: 'application/json, text/plain, */*' };
    if (req.token) headers['X-MSP-Token'] = req.token;
    const resp = await axios({
      url,
      method: req.method || 'GET',
      headers,
      data: req.body || undefined,
      timeout: 8000,
      validateStatus: () => true,
    });
    return { status: resp.status, data: resp.data };
  } catch (e) {
    return { status: 0, error: e.message };
  }
});

/** 渲染端全量同步本地曲库（仅物理文件，CUE 虚拟轨请过滤） */
ipcMain.on('lan:sync-library', (_event, tracks) => {
  if (lanServer.isRunning()) lanServer.setLibrary(tracks);
});

/** 获取文件夹内音频文件预览（用于侧边栏显示）
 *  注意：ipcMain.handle 回调第一个参数是 event，目录路径在第二个参数 */
ipcMain.handle('preview-folder', async (event, dirPath) => {
  if (!dirPath || !fs.existsSync(dirPath)) return { files: [], total: 0, hasMore: false, error: '文件夹不存在' };
  try {
    const files = await scanAudioFiles(dirPath);
    const preview = files.slice(0, 10);
    return { files: preview, total: files.length, hasMore: files.length > 10 };
  } catch (err) {
    return { files: [], total: 0, hasMore: false, error: err.message };
  }
});

/** 设置窗口全屏 */
ipcMain.handle('toggle-fullscreen', () => {
  if (!mainWindow) return false;
  const isFull = mainWindow.isFullScreen();
  mainWindow.setFullScreen(!isFull);
  return !isFull;
});

/** 获取应用路径（用于定位 default_cover.png） */
ipcMain.handle('get-app-path', () => {
  return __dirname;
});

// ============================================================
// Bit-perfect 音频引擎（mpv / WASAPI 独占 / DSD DoP / DSP）
// ============================================================
function engineBroadcast(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('engine:event', payload);
  }
}
mpvEngine.on('progress', (p) => engineBroadcast({ type: 'progress', ...p }));
mpvEngine.on('params', (p) => engineBroadcast({ type: 'params', ...p }));
mpvEngine.on('ended', () => engineBroadcast({ type: 'ended' }));
mpvEngine.on('start-file', () => engineBroadcast({ type: 'start-file' }));
mpvEngine.on('track-change', (p) => engineBroadcast({ type: 'track-change', path: p && p.path }));
mpvEngine.on('file-error', (msg) => engineBroadcast({ type: 'file-error', message: msg }));
mpvEngine.on('log', (line) => console.log('[mpv]', line));
mpvEngine.on('exit', () => engineBroadcast({ type: 'engine-exit' }));

ipcMain.handle('engine:status', () => mpvEngine.status());
ipcMain.handle('engine:devices', () => mpvEngine.listDevices());
ipcMain.handle('engine:play', async (_e, opts) => {
  try {
    const { path: file, exclusive = true, softvol, device, start, end } = opts || {};
    if (device) await mpvEngine.useDevice(device);
    if (typeof softvol === 'boolean') await mpvEngine.start({ softvol });
    await mpvEngine.load(file, { exclusive, start, end });
    return { ok: true };
  } catch (err) {
    console.error('[engine:play]', err.message);
    return { ok: false, error: err.message };
  }
});
/** 把下一首本地曲目追加进 mpv 内部播放列表（真 Gapless 预载） */
ipcMain.handle('engine:append', async (_e, opts) => {
  try {
    const { path: file, start, end } = opts || {};
    if (!file) return { ok: false, error: '缺少文件路径' };
    const appended = await mpvEngine.append(file, { start, end });
    return appended ? { ok: true } : { ok: false, error: '引擎未运行' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('engine:pause', (_e, p) => mpvEngine.setPaused(!!p));
ipcMain.handle('engine:seek', (_e, t) => mpvEngine.seek(t));
ipcMain.handle('engine:stop', () => mpvEngine.stop());
ipcMain.handle('engine:volume', (_e, v) => mpvEngine.setVolume(v));
ipcMain.handle('engine:mute', (_e, m) => mpvEngine.setMuted(m));
ipcMain.handle('engine:dsp', async (_e, cfg) => {
  try { const af = await mpvEngine.setDsp(cfg); return { ok: true, af }; }
  catch (err) { return { ok: false, error: err.message }; }
});

/** 选择 FIR 卷积脉冲响应文件（wav/irs） */
ipcMain.handle('pick-ir-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择 FIR 脉冲响应文件',
    filters: [{ name: '脉冲响应', extensions: ['wav', 'wv', 'irs'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// ============================================================
// 硬件音量：通过常驻 PowerShell 进程调用 Windows Core Audio
// (IAudioEndpointVolume) 控制默认渲染设备的系统主音量。
// WASAPI 独占期间 DAC 不接收系统衰减，此开关仅在共享输出 / 常规通路时有效。
// ============================================================
const HW_VOL_PS = `
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(uint flow, uint stateMask, out IntPtr collection);
  int GetDefaultAudioEndpoint(uint flow, uint role, out IMMDevice endpoint);
  int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  int RegisterEndpointNotificationCallback(IntPtr client);
  int UnregisterEndpointNotificationCallback(IntPtr client);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  int Activate(ref Guid iid, uint ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(uint access, out IntPtr store);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out uint state);
}
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr notify);
  int UnregisterControlChangeNotify(IntPtr notify);
  int GetChannelCount(out uint count);
  int SetMasterVolumeLevel(float levelDB, Guid ctx);
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int GetMasterVolumeLevel(out float levelDB);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint ch, float levelDB, Guid ctx);
  int SetChannelVolumeLevelScalar(uint ch, float level, Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float levelDB);
  int GetChannelVolumeLevelScalar(uint ch, out float level);
  int SetMute(int mute, Guid ctx);
  int GetMute(out int mute);
  int GetVolumeStepInfo(out uint step, out uint count);
  int VolumeStepUp(Guid ctx);
  int VolumeStepDown(Guid ctx);
  int QueryHardwareSupport(out uint mask);
  int GetVolumeRange(out float minDB, out float maxDB, out float increment);
}
public static class HwVol {
  static IAudioEndpointVolume ep;
  public static void Init() {
    IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev;
    en.GetDefaultAudioEndpoint(0, 0, out dev);
    Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    object o;
    dev.Activate(ref iid, 23, IntPtr.Zero, out o);
    ep = (IAudioEndpointVolume)o;
  }
  public static void SetVol(double x) { ep.SetMasterVolumeLevelScalar((float)x, Guid.Empty); }
  public static double GetVol() { float f; ep.GetMasterVolumeLevelScalar(out f); return Math.Round((double)f, 3); }
  public static void DoMute(int m) { ep.SetMute(m, Guid.Empty); }
  public static int GetMute() { int m; ep.GetMute(out m); return m; }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
[HwVol]::Init()
Write-Output 'READY'
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $p = $line.Split(' ')
    switch ($p[0]) {
      'set'  { [HwVol]::SetVol([double]$p[1]) }
      'get'  { Write-Output ('VOL ' + [HwVol]::GetVol()) }
      'mute' { [HwVol]::DoMute([int]$p[1]) }
      'mget' { Write-Output ('MUTE ' + [HwVol]::GetMute()) }
    }
  } catch {
    Write-Output ('ERR ' + $_.Exception.Message)
  }
}
`;

const hwVolume = {
  proc: null,
  ready: false,
  lastVolume: null,
  lastMute: null,
  startPromise: null,
  scriptPath: null,
  start() {
    if (this.ready) return Promise.resolve({ ok: true, volume: this.lastVolume, muted: !!this.lastMute });
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve) => {
      let proc = null;
      try {
        // PowerShell 交互 stdin 模式无法可靠执行 here-string，改为落临时脚本用 -File 启动
        if (!this.scriptPath) {
          this.scriptPath = path.join(os.tmpdir(), 'mspmusic-hwvol.ps1');
          fs.writeFileSync(this.scriptPath, HW_VOL_PS, 'utf8');
        }
        proc = spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        this.proc = proc;
        let buf = '';
        let settled = false;
        const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
        const timer = setTimeout(() => {
          if (!this.ready) {
            try { proc.kill(); } catch { /* ignore */ }
            finish({ ok: false, error: '音量控制启动超时' });
          }
        }, 20000);
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (d) => {
          buf += d;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line === 'READY') {
              clearTimeout(timer);
              this.ready = true;
              proc.stdin.write('get\nmget\n');
              // 数值在随后的 VOL/MUTE 行返回
              setTimeout(() => finish({ ok: true, volume: this.lastVolume, muted: !!this.lastMute }), 300);
            } else if (line.startsWith('VOL ')) {
              this.lastVolume = parseFloat(line.slice(4));
            } else if (line.startsWith('MUTE ')) {
              this.lastMute = line.slice(5).trim() === '1';
            } else if (line.startsWith('ERR')) {
              console.warn('[hwvol]', line);
            }
          }
        });
        proc.on('exit', () => { this.ready = false; this.proc = null; this.startPromise = null; });
        proc.on('error', (e) => finish({ ok: false, error: e.message }));
      } catch (err) {
        if (proc) { try { proc.kill(); } catch { /* ignore */ } }
        resolve({ ok: false, error: err.message });
      }
    });
    return this.startPromise;
  },
  _send(s) { if (this.ready && this.proc && !this.proc.killed) { try { this.proc.stdin.write(s + '\n'); } catch { /* ignore */ } } },
  set(v) { this.lastVolume = v; this._send('set ' + Math.max(0, Math.min(1, Number(v) || 0))); },
  mute(m) { this.lastMute = !!m; this._send('mute ' + (m ? 1 : 0)); },
  stop() {
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } }
    this.proc = null; this.ready = false; this.startPromise = null;
  },
};

ipcMain.handle('hwvol:start', async () => {
  const r = await hwVolume.start();
  return r;
});
ipcMain.handle('hwvol:set', (_e, v) => { hwVolume.set(v); return true; });
ipcMain.handle('hwvol:mute', (_e, m) => { hwVolume.mute(!!m); return true; });

// ============================================================
// 网易云音乐 IPC
// ============================================================
ipcMain.handle('netease-search', async (_e, keyword) => {
  return await NeteaseAPI.search(keyword, 30);
});
ipcMain.handle('netease-song-url', async (_e, id) => {
  return await NeteaseAPI.getSongUrl(id, 320000);
});
ipcMain.handle('netease-lyric', async (_e, id) => {
  return await NeteaseAPI.getLyric(id);
});
ipcMain.handle('netease-login', async (_e, phone, password, captcha) => {
  return await NeteaseAPI.loginPhone(phone, password, captcha);
});
ipcMain.handle('netease-send-captcha', async (_e, phone) => {
  return await NeteaseAPI.sendCaptcha(phone);
});
ipcMain.handle('netease-logout', () => {
  NeteaseAPI.logout();
  return true;
});
ipcMain.handle('netease-status', () => NeteaseAPI.status());
ipcMain.handle('netease-web-login', async () => {
  return await NeteaseAPI.openLoginWindow();
});

// ============================================================
// B站 IPC
// ============================================================
ipcMain.handle('bilibili-search', async (_e, keyword) => {
  return await BilibiliAPI.search(keyword, 15);
});
ipcMain.handle('bilibili-video-url', async (_e, bvid) => {
  return await BilibiliAPI.getVideoUrl(bvid, 64);
});
ipcMain.handle('bilibili-qrcode', async () => {
  return await BilibiliAPI.getLoginQrcode();
});
ipcMain.handle('bilibili-poll-qrcode', async (_e, qrcodeKey) => {
  return await BilibiliAPI.pollQrcode(qrcodeKey);
});
ipcMain.handle('bilibili-logout', () => {
  BilibiliAPI.logout();
  return true;
});
ipcMain.handle('bilibili-status', () => BilibiliAPI.status());
ipcMain.handle('bilibili-sms-login', async () => {
  return await BilibiliAPI.openSmsLoginWindow();
});

// ── QQ音乐 IPC ──
ipcMain.handle('qq-search', async (_e, keyword) => QQAPI.search(keyword));
ipcMain.handle('qq-song-url', async (_e, songmid) => QQAPI.getSongUrl(songmid));
ipcMain.handle('qq-lyric', async (_e, songmid) => QQAPI.getLyric(songmid));
ipcMain.handle('qq-qrcode', async () => QQAPI.getLoginQrcode());
ipcMain.handle('qq-poll-qrcode', async (_e, qrsig) => QQAPI.pollQrLogin(qrsig));
ipcMain.handle('qq-login-save', (_e, cookie) => { QQAPI.saveLogin(cookie); return true; });
ipcMain.handle('qq-logout', () => { QQAPI.logout(); return true; });
ipcMain.handle('qq-status', () => QQAPI.status());
ipcMain.handle('qq-sms-login', async () => QQAPI.openSmsLoginWindow());

// ============================================================
// 文件管理 IPC（设置页：新建文件夹 / 重命名 / 删除）
// ============================================================

/** Windows 非法文件名/文件夹名校验 */
function invalidFsName(name) {
  if (!name || typeof name !== 'string') return true;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120) return true;
  if (/[\\/:*?"<>|]/.test(trimmed)) return true;
  if (/\.$/.test(trimmed) || /\s$/.test(trimmed)) return true;
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  return reserved.test(trimmed.replace(/\..*$/, ''));
}

/** 列出音乐文件夹的一级子文件夹 + 全部音频文件（音频递归扫描，含相对路径） */
ipcMain.handle('fs-list', async (event, dirPath) => {
  if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return { error: '文件夹不存在', folders: [], files: [] };
  }
  try {
    const folders = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        folders.push({ name: entry.name, path: path.join(dirPath, entry.name) });
      }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const all = await scanAudioFiles(dirPath);
    const files = all.map((fp) => ({
      name: path.basename(fp),
      relPath: path.relative(dirPath, fp),
      path: fp,
      ext: path.extname(fp).toLowerCase(),
    }));
    return { folders, files };
  } catch (err) {
    return { error: err.message, folders: [], files: [] };
  }
});

/** 新建文件夹 */
ipcMain.handle('fs-mkdir', async (event, dirPath, name) => {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) return { error: '音乐文件夹不存在' };
    if (invalidFsName(name)) return { error: '名称无效（不能含 \\ / : * ? " < > | 等字符）' };
    const target = path.join(dirPath, name.trim());
    if (fs.existsSync(target)) return { error: '同名文件夹已存在' };
    fs.mkdirSync(target);
    return {};
  } catch (err) {
    return { error: err.message };
  }
});

/** 重命名文件或文件夹（newName 不含路径，仅名称；文件保留原扩展名由渲染进程拼好） */
ipcMain.handle('fs-rename', async (event, targetPath, newName) => {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return { error: '目标不存在' };
    if (invalidFsName(newName)) return { error: '名称无效（不能含 \\ / : * ? " < > | 等字符）' };
    const parent = path.dirname(targetPath);
    const target = path.join(parent, newName.trim());
    if (fs.existsSync(target)) return { error: '同名文件/文件夹已存在' };
    fs.renameSync(targetPath, target);
    return {};
  } catch (err) {
    // Windows 上重命名正在播放的文件会报 EBUSY/EPERM
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      return { error: '文件被占用（可能正在播放），请先切换到其他歌曲' };
    }
    return { error: err.message };
  }
});

/** 删除文件或文件夹（移入回收站，可恢复） */
ipcMain.handle('fs-delete', async (event, targetPath) => {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return { error: '目标不存在' };
    // 正在播放的文件会被占用，trashItem 失败时给出友好提示
    await shell.trashItem(targetPath);
    return {};
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      return { error: '文件被占用（可能正在播放），请先切换到其他歌曲' };
    }
    return { error: '删除失败：' + err.message };
  }
});

// ============================================================
// 应用生命周期
// ============================================================
// 单实例锁：已最小化到托盘时再次启动/点击图标，聚焦恢复已有窗口而非开第二个
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    loadTrayPrefs();

    // 旧版 metadata-cache.json → 16 分片迁移（首次运行时执行）
    migrateOldMetaCache();

    // 局域网互通：若上次开启则自动启动（手机端无需等待界面操作即可发现电脑）
    const lanCfg = readLanConfig();
    if (lanCfg.enabled) {
      startLanWithConfig(lanCfg).catch((e) => console.warn('[LAN] 自启动失败:', e.message));
    }

    // 给 B站 CDN、网易云音频、QQ音乐 CDN 的媒体请求注入 Referer
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const u = details.url;
      const isBili = /bilivideo\.com|mountaintoys\.cn|acgvideo\.com|hdslb\.com|bilivideo\.cn|upos-/i.test(u);
      const isNetease = /music\.126\.net/i.test(u);
      const isQq = /qqmusic\.qq\.com|tc\.qq\.com|stream\.qqmusic/i.test(u);
      if (isBili || isNetease || isQq) {
        const h = details.requestHeaders;
        for (const k of Object.keys(h)) {
          if (k.toLowerCase() === 'referer') delete h[k];
        }
        h['Referer'] = isBili ? 'https://www.bilibili.com/' : (isNetease ? 'https://music.163.com/' : 'https://y.qq.com/');
        h['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
      }
      callback({ requestHeaders: details.requestHeaders });
    });

    createWindow();
    createTray();
    // bilistream 协议：带 Referer 拉取 B站视频流，并转发 Range 等请求头以支持拖动
    protocol.handle('bilistream', async (request) => {
      try {
        const u = new URL(request.url);
        const target = u.searchParams.get('url');
        if (!target) return new Response('missing url', { status: 400 });
        // 转发原始请求的关键头（Range 决定能否拖动）
        const fwdHeaders = new Headers();
        fwdHeaders.set('Referer', 'https://www.bilibili.com/');
        fwdHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36');
        const range = request.headers.get('Range');
        if (range) fwdHeaders.set('Range', range);
        const resp = await net.fetch(target, { headers: fwdHeaders });
        return resp;
      } catch (e) {
        return new Response(String(e), { status: 502 });
      }
    });

    // audiostream 协议：在线音频（网易云/QQ）代理。
    // 作用：① 注入平台 Referer 防盗链；② 转发 Range 支持拖动；
    //       ③ 补 Access-Control-Allow-Origin，使渲染层 Web Audio 节点图可以处理跨域音频（否则 MediaElementSource 输出静音）。
    // 上游 Referer 按域名判断，默认网易云。
    protocol.handle('audiostream', async (request) => {
      try {
        const u = new URL(request.url);
        // 网易云直链常为 http://，Electron net 会以 ERR_BLOCKED_BY_CLIENT 拦截明文音频；
        // 主流音频 CDN 均支持 https，统一升级（QQ 直链本身已是 https）
        const target = (u.searchParams.get('url') || '').replace(/^http:\/\//i, 'https://');
        if (!target) return new Response('missing url', { status: 400 });
        const fwdHeaders = new Headers();
        const isQq = /qqmusic\.qq\.com|tc\.qq\.com|stream\.qqmusic/i.test(target);
        fwdHeaders.set('Referer', isQq ? 'https://y.qq.com/' : 'https://music.163.com/');
        fwdHeaders.set('User-Agent', UA_BROWSER);
        const range = request.headers.get('Range');
        if (range) fwdHeaders.set('Range', range);
        const resp = await net.fetch(target, { headers: fwdHeaders, redirect: 'follow' });
        // 拷贝响应头（net.fetch 的 Response 头只读，需重建 Response 以注入 CORS）
        const outHeaders = new Headers();
        const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
        for (const name of passthrough) {
          const v = resp.headers.get(name);
          if (v != null) outHeaders.set(name, v);
        }
        outHeaders.set('Access-Control-Allow-Origin', '*');
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: outHeaders,
        });
      } catch (e) {
        return new Response(String(e), { status: 502 });
      }
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});