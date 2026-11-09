/**
 * lan-server.js —— MSP Music 局域网互通服务（PC 作为曲库主机）
 *
 * 设备发现：UDP 15749
 *   - 手机广播 "MSPMUSIC_QUERY" → 本服务单播回应 ANNOUNCE(JSON)
 *   - 本服务每 3 秒向 255.255.255.255 广播一次 ANNOUNCE
 *   - 同时被动收集其他 MSP 主机（手机共享端）的 ANNOUNCE，供"双向互通"浏览
 * 音频服务：HTTP（默认 15748）
 *   GET  /api/info            设备与曲目数（开放，含 auth 标志）
 *   POST /api/pair            6 位配对码换 token（{pin,device} → {token}）
 *   GET  /api/tracks          曲库摘要 [{id,title,artist,album,duration,ext}]（需 token）
 *   GET  /api/stream/:id      音频（完整 Range/206 支持，ExoPlayer 可拖动）（需 token）
 *   GET  /api/download/:id    附件下载（Content-Disposition）（需 token）
 *   GET  /api/cover/:id       内嵌封面（按需读取，LRU 缓存）（需 token）
 *   GET  /api/lrc/:id         侧车歌词（同名/模糊匹配，UTF-8/GB18030）（需 token）
 *
 * 鉴权：除 /api/info、/api/pair、OPTIONS 外全部需要 token，
 *       支持 ?t=TOKEN（媒体/图片标签用）或 X-MSP-Token 头。
 */

const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DISCOVERY_PORT = 15749;
const DEFAULT_HTTP_PORT = 15748;
const PROTOCOL_VERSION = 2;
const MAGIC_QUERY = 'MSPMUSIC_QUERY';
const ANNOUNCE_INTERVAL_MS = 3000;
const PEER_TTL_MS = 12000;
const COVER_CACHE_MAX = 48;
const PAIR_FAIL_LIMIT = 5;        // 同一 IP 连续 5 次错码
const PAIR_LOCK_MS = 60 * 1000;   // 锁定 60 秒

const AUDIO_MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.m4b': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma', '.ape': 'audio/ape', '.tak': 'audio/x-tak',
  '.dsf': 'audio/dsf', '.dff': 'audio/dff', '.wv': 'audio/x-wavpack',
  '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
};

let state = null;
// state = { name, httpPort, http, udp, timer, tracks, hooks, coverCache:Map }

/** 列出本机可用于局域网的 IPv4 地址 */
function lanIPv4List() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function preferredIP() {
  const list = lanIPv4List();
  // 优先常见家用网段
  return list.find((ip) => /^192\.168\./.test(ip))
    || list.find((ip) => /^10\./.test(ip))
    || list.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip))
    || list[0]
    || '';
}

function defaultName() {
  const ip = preferredIP();
  const tail = ip ? ip.split('.').pop() : os.hostname().slice(0, 8);
  return `MSP-${tail}`;
}

function buildAnnounce() {
  return JSON.stringify({
    app: 'mspmusic',
    v: PROTOCOL_VERSION,
    kind: 'pc',
    name: state.name,
    port: state.httpPort,
    count: state.tracks.length,
    auth: 1,
  });
}

/** 生成 6 位数字配对码（去掉易混字符无意义——纯数字，允许前导零） */
function generatePin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function loadPaired(file) {
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (raw && Array.isArray(raw.devices)) {
      for (const d of raw.devices) {
        if (d && d.token) map.set(d.token, { name: d.name || '设备', created: d.created || Date.now() });
      }
    }
  } catch (e) { /* 首次使用无文件 */ }
  return map;
}

function savePaired() {
  if (!state.pairedFile) return;
  try {
    const devices = [];
    for (const [token, d] of state.clients) devices.push({ token, name: d.name, created: d.created });
    fs.writeFileSync(state.pairedFile, JSON.stringify({ devices }, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[LAN] 配对设备持久化失败:', e.message);
  }
}

function sendUdp(message, address, port) {
  if (!state) return;
  const buf = Buffer.from(message);
  state.udp.send(buf, 0, buf.length, port, address, () => {});
}

function startUdp() {
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (msg, rinfo) => {
    const text = msg.toString().trim();
    if (text === MAGIC_QUERY) {
      // 单播回应查询者（模拟器 NAT / AP 隔离环境也能收到）
      sendUdp(buildAnnounce(), rinfo.address, rinfo.port);
      return;
    }
    // 其他 MSP 主机（手机共享端）的周期广播 → 收集为对端（双向互通）
    try {
      const o = JSON.parse(text);
      if (o.app !== 'mspmusic' || !o.port) return;
      if (o.name === state.name && o.port === state.httpPort) return; // 自己的回环广播
      const ip = rinfo.address;
      if (!ip || ip.indexOf(':') >= 0) return;
      state.peers.set(`${ip}:${o.port}`, {
        name: o.name || 'MSP 设备', kind: o.kind === 'mobile' ? 'mobile' : 'pc',
        ip, port: o.port, count: o.count || 0, auth: o.auth ? 1 : 0, seen: Date.now(),
      });
    } catch (e) { /* 非本协议包 */ }
  });
  udp.on('error', (err) => {
    console.warn('[LAN] UDP 发现套接字错误:', err.message);
  });
  udp.bind(DISCOVERY_PORT, '0.0.0.0', () => {
    try { udp.setBroadcast(true); } catch (e) { /* 部分环境不支持 */ }
    console.log(`[LAN] 设备发现已监听 UDP ${DISCOVERY_PORT}`);
  });
  return udp;
}

/** 在首选端口及后续端口上尝试监听 */
function listenHttp(server, preferred) {
  return new Promise((resolve, reject) => {
    let port = preferred;
    const tryListen = () => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && port < preferred + 10) {
          port += 1;
          server.listen(port, '0.0.0.0');
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    };
    tryListen();
  });
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/** token 来源：?t= 查询参数（img/audio 标签）或 X-MSP-Token 头 */
function extractToken(req, u) {
  const t = u.searchParams.get('t');
  if (t) return t;
  return req.headers['x-msp-token'] || '';
}

/** 受保护接口鉴权；通过返回 true，失败已回 401 */
function requireAuth(req, res, u) {
  const token = extractToken(req, u);
  const client = token && state.clients.get(token);
  if (!client) {
    sendJson(res, 401, { error: 'unpaired' });
    return false;
  }
  client.lastSeen = Date.now();
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function handlePair(req, res) {
  const ip = req.socket.remoteAddress || '?';
  const now = Date.now();
  const lock = state.pairLocks.get(ip);
  if (lock && lock.until > now && lock.fails >= PAIR_FAIL_LIMIT) {
    sendJson(res, 429, { error: 'locked', retry: Math.ceil((lock.until - now) / 1000) });
    return;
  }
  const body = await readJsonBody(req);
  const pin = String(body.pin || '').trim();
  if (!/^\d{6}$/.test(pin) || pin !== state.pin) {
    const rec = lock || { fails: 0, until: 0 };
    rec.fails += 1;
    if (rec.fails >= PAIR_FAIL_LIMIT) rec.until = now + PAIR_LOCK_MS;
    state.pairLocks.set(ip, rec);
    sendJson(res, 403, { error: 'bad_pin', fails: rec.fails });
    return;
  }
  state.pairLocks.delete(ip);
  const token = newToken();
  state.clients.set(token, {
    name: String(body.device || '未知设备').slice(0, 40) || '未知设备',
    created: now, lastSeen: now,
  });
  savePaired();
  console.log(`[LAN] 新设备配对成功: ${state.clients.get(token).name} @${ip}`);
  sendJson(res, 200, { token, name: state.name });
}

function getTrack(idStr) {
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id) || id < 0 || id >= state.tracks.length) return null;
  return state.tracks[id];
}

/** 统一音频/下载响应：200 全量或 206 Range */
function serveFile(req, res, filePath, mime, downloadName) {
  let stat;
  try { stat = fs.statSync(filePath); }
  catch (e) { sendJson(res, 404, { error: '文件不存在' }); return; }

  const total = stat.size;
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, max-age=3600',
  };
  if (downloadName) {
    const encoded = encodeURIComponent(downloadName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
    headers['Content-Disposition'] = `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`;
  }

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = 0, end = total - 1;
    if (m) {
      if (m[1]) start = parseInt(m[1], 10);
      if (m[2]) end = parseInt(m[2], 10);
      if (!m[1] && m[2]) { start = Math.max(0, total - parseInt(m[2], 10)); end = total - 1; }
    }
    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    end = Math.min(end, total - 1);
    res.writeHead(206, Object.assign(headers, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
    }));
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => { try { res.destroy(); } catch (e) {} });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }

  res.writeHead(200, Object.assign(headers, { 'Content-Length': total }));
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => { try { res.destroy(); } catch (e) {} });
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function serveCover(res, filePath) {
  let item = state.coverCache.get(filePath);
  if (!item) {
    if (!state.hooks || !state.hooks.readCover) { sendJson(res, 404, { error: 'no cover' }); return; }
    try {
      const info = await state.hooks.readCover(filePath);
      if (!info || !info.dataBase64) { sendJson(res, 404, { error: 'no cover' }); return; }
      item = { mime: info.format && info.format.includes('/') ? info.format : `image/${info.format || 'jpeg'}`, base64: info.dataBase64 };
      state.coverCache.set(filePath, item);
      if (state.coverCache.size > COVER_CACHE_MAX) {
        const firstKey = state.coverCache.keys().next().value;
        state.coverCache.delete(firstKey);
      }
    } catch (e) {
      sendJson(res, 404, { error: 'cover error' });
      return;
    }
  }
  const body = Buffer.from(item.base64, 'base64');
  res.writeHead(200, {
    'Content-Type': item.mime,
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, max-age=86400',
  });
  res.end(body);
}

function serveLrc(res, filePath) {
  if (!state.hooks || !state.hooks.readLrc) { sendJson(res, 404, { error: 'no lrc' }); return; }
  let text = state.hooks.readLrc(filePath);
  if (!text) { sendJson(res, 404, { error: 'no lrc' }); return; }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 剥 UTF-8 BOM
  const body = Buffer.from(text, 'utf-8');
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, max-age=3600',
  });
  res.end(body);
}

function handleRequest(req, res) {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    if (p === '/api/info' && req.method === 'GET') {
      sendJson(res, 200, {
        app: 'mspmusic', v: PROTOCOL_VERSION, kind: 'pc',
        name: state.name, count: state.tracks.length, auth: 1,
        ips: lanIPv4List(),
      });
      return;
    }
    if (p === '/api/pair' && req.method === 'POST') {
      handlePair(req, res);
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type, X-MSP-Token',
      });
      res.end();
      return;
    }
    // 以下全部需要配对 token
    if (!requireAuth(req, res, u)) return;

    if (p === '/api/tracks' && req.method === 'GET') {
      // 对外只暴露摘要字段，path 等内部信息不泄漏给手机端
      // id 一律以数组下标为准（getTrack 按下标取），渲染端推送的数据本身不带 id
      const safe = state.tracks.map((t, i) => ({
        id: i, title: t.title, artist: t.artist, album: t.album,
        duration: t.duration, ext: t.ext,
      }));
      sendJson(res, 200, { tracks: safe });
      return;
    }
    let m;
    if ((m = /^\/api\/(stream|download)\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const t = getTrack(m[2]);
      if (!t || !t.path) { sendJson(res, 404, { error: '曲目不存在' }); return; }
      const mime = AUDIO_MIME[t.ext] || 'application/octet-stream';
      const dlName = m[1] === 'download'
        ? `${t.title || path.basename(t.path)}${t.ext || ''}` : null;
      serveFile(req, res, t.path, mime, dlName);
      return;
    }
    if ((m = /^\/api\/cover\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const t = getTrack(m[1]);
      if (!t) { sendJson(res, 404, { error: '曲目不存在' }); return; }
      serveCover(res, t.path);
      return;
    }
    if ((m = /^\/api\/lrc\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const t = getTrack(m[1]);
      if (!t) { sendJson(res, 404, { error: '曲目不存在' }); return; }
      serveLrc(res, t.path);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.warn('[LAN] 请求处理异常:', err.message);
    try { sendJson(res, 500, { error: 'server error' }); } catch (e) {}
  }
}

// ───────────────────────── 对外接口 ─────────────────────────

async function start(opts) {
  opts = opts || {};
  if (state) return { ok: true, port: state.httpPort, reused: true };

  const httpServer = http.createServer(handleRequest);
  let port;
  try {
    port = await listenHttp(httpServer, opts.port || DEFAULT_HTTP_PORT);
  } catch (e) {
    console.warn('[LAN] HTTP 服务启动失败:', e.message);
    throw e;
  }

  state = {
    name: opts.name || defaultName(),
    httpPort: port,
    http: httpServer,
    udp: null,
    timer: null,
    tracks: [],
    hooks: opts.hooks || null,
    coverCache: new Map(),
    pin: opts.pin || generatePin(),
    pairedFile: opts.pairedFile || null,
    clients: opts.pairedFile ? loadPaired(opts.pairedFile) : new Map(),
    peers: new Map(),
    pairLocks: new Map(),
  };
  state.udp = startUdp();
  state.timer = setInterval(() => {
    sendUdp(buildAnnounce(), '255.255.255.255', DISCOVERY_PORT);
    prunePeers();
  }, ANNOUNCE_INTERVAL_MS);

  console.log(`[LAN] 局域网服务已启动: 名称="${state.name}" HTTP=${port} 配对码=${state.pin} 曲目=0`);
  return { ok: true, port, name: state.name, pin: state.pin, ips: lanIPv4List() };
}

function stop() {
  if (!state) return;
  clearInterval(state.timer);
  try { state.udp.close(); } catch (e) {}
  try { state.http.close(); } catch (e) {}
  console.log('[LAN] 局域网服务已停止');
  state = null;
}

function isRunning() { return !!state; }

function setName(name) {
  if (state && name) state.name = String(name).slice(0, 40);
}

/** 渲染端推送曲库（全量替换；仅本地物理文件，CUE 虚拟轨由调用方过滤） */
function setLibrary(tracks) {
  if (!state) return false;
  state.tracks = Array.isArray(tracks) ? tracks.filter((t) => t && t.path) : [];
  state.coverCache.clear();
  console.log(`[LAN] 曲库已同步: ${state.tracks.length} 首`);
  return true;
}

function getPin() { return state ? state.pin : ''; }

function regenPin() {
  if (!state) return '';
  state.pin = generatePin();
  // 换码不影响已配对设备（token 仍有效），仅阻止新配对
  console.log(`[LAN] 配对码已更换: ${state.pin}`);
  return state.pin;
}

/** 已配对设备列表（token 脱敏后给 UI） */
function listClients() {
  if (!state) return [];
  const out = [];
  for (const [token, d] of state.clients) {
    out.push({ id: token.slice(0, 8), name: d.name, created: d.created, lastSeen: d.lastSeen || d.created });
  }
  return out;
}

function unpair(idPrefix) {
  if (!state) return false;
  for (const token of state.clients.keys()) {
    if (token.startsWith(idPrefix)) {
      state.clients.delete(token);
      savePaired();
      return true;
    }
  }
  return false;
}

function prunePeers() {
  const now = Date.now();
  for (const [k, p] of state.peers) {
    if (now - p.seen > PEER_TTL_MS) state.peers.delete(k);
  }
}

/** 附近的其他 MSP 主机（手机共享端），供电脑端浏览 */
function getPeers() {
  if (!state) return [];
  prunePeers();
  return Array.from(state.peers.values());
}

function getStatus(fallback) {
  return {
    running: !!state,
    port: state ? state.httpPort : (fallback && fallback.port) || DEFAULT_HTTP_PORT,
    name: state ? state.name : (fallback && fallback.name) || defaultName(),
    pin: state ? state.pin : (fallback && fallback.pin) || '',
    clients: state ? listClients() : [],
    peers: state ? getPeers() : [],
    ips: lanIPv4List(),
    preferredIP: preferredIP(),
    count: state ? state.tracks.length : 0,
    discoveryPort: DISCOVERY_PORT,
  };
}

module.exports = {
  start, stop, isRunning, setName, setLibrary, getStatus,
  getPin, regenPin, listClients, unpair, getPeers,
  DEFAULT_HTTP_PORT, DISCOVERY_PORT,
};
