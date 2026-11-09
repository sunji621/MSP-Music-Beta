/**
 * ─── mpv-engine.js ───
 * Bit-perfect 音频引擎：内嵌 mpv（FFmpeg 解码核心）通过 JSON IPC 桥接。
 * 能力：
 *   - WASAPI 独占输出（audio-exclusive）：绕过系统混音器，采样原封不动送 DAC
 *   - DSD 播放：DSF/DFF 按文件本身通路输出（新引擎支持 DoP 直通；旧版解码为高解析 PCM）
 *   - 顶级解码：FLAC/WAV/MP3/AAC/ALAC/opus/wv/DSF/DFF/AIFF…（FFmpeg 全量解码器）
 *   - DSP：firequalizer 参数均衡 / afir 卷积（耳机补偿）
 * 引擎二进制位于 bin/mpv/mpv.exe（开发目录）或 resources/bin/mpv/mpv.exe（打包后）。
 * 注意：mpv 0.36+ 已移除 --softvol 选项，软件音量统一走 volume 属性；
 *       纯 Bit-perfect（软音量关闭）时前端不下发 volume，保持 100 零改动。
 *       IPC `set` 命令的值必须为字符串（'20'/'yes'/'no'），原生数字/布尔会被新版 mpv 拒绝。
 */

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

class MpvEngine extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.ready = false;
    this.lastError = null;
    this.softvol = true;
    this.buf = '';
    this.props = {};
    this._pending = new Map();
    this._reqId = 0;
    this.pipeName = `mspmusic-mpv-${process.pid}`;
    /** @type {string|null} 当前曲目路径 */
    this.currentFile = null;
    /** @type {string|null} 用户选择的 WASAPI 设备 id（null=自动） */
    this.device = null;
    /** 当前 mpv 内部播放列表位置（观察属性），用于 Gapless 推进判断 */
    this._playingPos = -1;
  }

  /** 定位引擎可执行文件（打包后 extraResources 与开发目录双路径） */
  findMpv() {
    const candidates = [
      process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'mpv', 'mpv.exe') : null,
      path.join(__dirname, 'bin', 'mpv', 'mpv.exe'),
    ].filter(Boolean);
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
    return null;
  }

  available() { return !!this.findMpv(); }

  /**
   * 启动引擎（幂等）。
   * @param {{softvol?: boolean}} opts softvol 仅保留在前端语义（true=允许下发 volume），不再影响启动参数
   */
  async start(opts = {}) {
    if (this.ready) return true;
    if (typeof opts.softvol === 'boolean') this.softvol = opts.softvol;
    this.lastError = null;
    const exe = this.findMpv();
    if (!exe) {
      this.lastError = '未找到 mpv 引擎（bin/mpv/mpv.exe）';
      return false;
    }
    const args = [
      '--idle=yes',
      '--no-terminal',
      '--no-video',                 // 纯音频通路（不含内嵌封面轨）
      '--audio-display=no',         // 禁止解析/渲染内嵌封面图，减少解码与内存开销
      '--ao=wasapi',
      '--audio-exclusive=yes',      // WASAPI 独占
      '--audio-channels=auto',      // 按 DAC 支持的最大声道布局打开：5.1/7.1 原生直通（auto-safe 会保守限制到立体声）
      '--gapless-audio=weak',
      '--replaygain=no',
      '--audio-normalize-downmix=no',
      '--keep-open=no',
      '--force-window=no',
      '--volume=100',
      '--cache=yes',                // 启用磁盘缓存，避免大文件反复读盘
      '--cache-secs=30',            // 缓存 30 秒，平衡内存与读取
    ];
    // 用户指定输出设备（默认自动选择系统默认渲染端点）
    if (this.device) args.push(`--audio-device=${this.device}`);
    args.push(`--input-ipc-server=\\\\.\\pipe\\${this.pipeName}`);

    this.proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) this.emit('log', s);
    });
    this.proc.on('exit', () => {
      this.ready = false;
      if (this.sock) { try { this.sock.destroy(); } catch { /* ignore */ } this.sock = null; }
      this.emit('exit');
    });
    try {
      await this._connectPipe(10000);
    } catch (e) {
      this.lastError = 'mpv IPC 连接失败: ' + e.message;
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
      return false;
    }
    // 观察关键属性 → 事件
    ['playback-time', 'duration', 'pause', 'audio-params', 'audio-out-params', 'audio-codec', 'metadata',
     'path', 'playlist-playing-pos', 'playlist-count', 'volume', 'mute']
      .forEach((n) => this._observe(n));
    this.ready = true;
    this.emit('ready');
    return true;
  }

  /** 轮询连接命名管道（mpv 启动后管道建立有延迟） */
  _connectPipe(timeoutMs) {
    return new Promise((resolve, reject) => {
      const attempts = Math.max(1, Math.round(timeoutMs / 200));
      const tryConn = (left) => {
        const s = net.connect(`\\\\.\\pipe\\${this.pipeName}`);
        s.once('connect', () => {
          this.sock = s;
          s.setNoDelay(true);
          s.on('data', (d) => this._onData(d));
          s.on('error', () => { /* 断线由 exit 事件处理 */ });
          resolve(true);
        });
        s.once('error', () => {
          s.destroy();
          if (left <= 0) reject(new Error('管道连接超时'));
          else setTimeout(() => tryConn(left - 1), 200);
        });
      };
      tryConn(attempts);
    });
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.event === 'property-change') {
        this.props[msg.name] = msg.data;
        if (['playback-time', 'duration', 'pause'].includes(msg.name)) {
          this.emit('progress', {
            time: this.props['playback-time'] || 0,
            duration: this.props['duration'] || 0,
            paused: !!this.props['pause'],
          });
        }
        if (['audio-params', 'audio-out-params', 'audio-codec'].includes(msg.name)) {
          this.emit('params', {
            audioParams: this.props['audio-params'] || null,
            outParams: this.props['audio-out-params'] || null,
            codec: this.props['audio-codec'] || null,
          });
        }
        // Gapless 自动推进：内部播放列表位置变化时通知渲染层同步 UI。
        // 注意换轨瞬间 mpv 会发出 -1 过渡值，只比较最近的非负位置。
        if (msg.name === 'playlist-playing-pos' && typeof msg.data === 'number' && msg.data >= 0) {
          const prev = this._playingPos;
          this._playingPos = msg.data;
          if (msg.data > prev && prev >= 0) {
            if (this._eofTimer) { clearTimeout(this._eofTimer); this._eofTimer = null; }
            this.emit('track-change', { pos: msg.data, path: this.props.path || null });
          }
        }
      } else if (msg.event === 'end-file') {
        if (msg.reason === 'eof') {
          // Gapless 推进时 eof 后会立刻收到下一曲的 start-file（在其回调里取消该定时器）；
          // 300ms 内没有新曲目启动才是播放列表真正结束。
          clearTimeout(this._eofTimer);
          this._eofTimer = setTimeout(() => { this._eofTimer = null; this.emit('ended'); }, 300);
        } else if (msg.reason === 'error') {
          this.emit('file-error', msg.file_error || '解码失败');
        }
      } else if (msg.event === 'start-file') {
        if (this._eofTimer) { clearTimeout(this._eofTimer); this._eofTimer = null; }
        this.emit('start-file');
      }

      if (msg.request_id && this._pending.has(msg.request_id)) {
        const { resolve } = this._pending.get(msg.request_id);
        this._pending.delete(msg.request_id);
        if (msg.error && msg.error !== 'success') resolve({ error: msg.error });
        else resolve({ data: msg.data });
      }
    }
  }

  /** 发送 mpv 命令（JSON IPC） */
  command(cmd) {
    return new Promise((resolve) => {
      if (!this.sock) { resolve({ error: 'no-connection' }); return; }
      const id = ++this._reqId;
      this._pending.set(id, { resolve });
      try {
        this.sock.write(JSON.stringify({ command: cmd, request_id: id }) + '\n');
      } catch (e) {
        this._pending.delete(id);
        resolve({ error: e.message });
      }
    });
  }

  _observe(name) {
    if (!this.sock) return;
    try { this.sock.write(JSON.stringify({ command: ['observe_property', 0, name] }) + '\n'); } catch { /* ignore */ }
  }

  /**
   * 播放本地文件（WASAPI 独占）。DSD 由 mpv 按文件通路处理（新引擎 DoP 直通，旧版转高解析 PCM）。
   * @param {string} filePath
   * @param {{exclusive?:boolean, start?:number, end?:number|null}} opts start/end 为 CUE 虚拟轨边界（秒，文件绝对时间）
   */
  async load(filePath, { exclusive = true, start, end } = {}) {
    const ok = await this.start();
    if (!ok || !this.ready) throw new Error(this.lastError || '引擎不可用');
    await this.command(['set', 'audio-exclusive', exclusive ? 'yes' : 'no']);
    this.currentFile = filePath;
    this._playingPos = -1; // 新 replace 后首次 playlist-pos 0→? 均视为推进前的初值
    // mpv 0.41 的 loadfile 签名为 url/flags/index/options：index 用 -1，options 为「键→字符串值」对象
    const fileOpts = {};
    if (Number.isFinite(start)) fileOpts.start = String(start);
    if (Number.isFinite(end)) fileOpts.end = String(end);
    const r = await this.command(['loadfile', filePath, 'replace', -1, fileOpts]);
    if (r && r.error) throw new Error('loadfile: ' + r.error);
    // 回读真实列表位置（replace 后位置恒为 0，且属性变化事件不一定触发）
    const pr = await this.command(['get_property', 'playlist-playing-pos']);
    this._playingPos = (pr && typeof pr.data === 'number') ? pr.data : 0;
    await this.command(['set', 'pause', 'no']);
    this.emit('loaded', filePath);
  }

  /**
   * 把下一首追加进 mpv 内部播放列表（真 Gapless：设备不关闭、解码预接）。
   * 返回 false 表示引擎未运行（由调用方回退为普通 load）。
   */
  async append(filePath, { start, end } = {}) {
    if (!this.ready || !this.sock) return false;
    const fileOpts = {};
    if (Number.isFinite(start)) fileOpts.start = String(start);
    if (Number.isFinite(end)) fileOpts.end = String(end);
    const r = await this.command(['loadfile', filePath, 'append', -1, fileOpts]);
    return !(r && r.error);
  }

  /** 切换输出设备：设备变化时若引擎在运行则先停止，下一次 load 用新设备启动 */
  async useDevice(deviceId) {
    const d = deviceId && deviceId !== 'auto' ? deviceId : null;
    if (d === this.device) return;
    this.device = d;
    if (this.ready) await this.quit();
  }

  /** 枚举 WASAPI 输出设备（解析 `--audio-device=help` 文本） */
  listDevices() {
    const exe = this.findMpv();
    if (!exe) return [];
    try {
      const r = spawnSync(exe, ['--no-config', '--ao=wasapi', '--audio-device=help'],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const devs = [];
      out.split(/\r?\n/).forEach((line) => {
        const m = line.match(/'([^']+)' \((.+)\)/);
        if (m && (m[1] === 'auto' || m[1].startsWith('wasapi/'))) devs.push({ id: m[1], name: m[2] });
      });
      if (!devs.some((d) => d.id === 'auto')) devs.unshift({ id: 'auto', name: '自动选择（系统默认设备）' });
      return devs;
    } catch (e) {
      return [{ id: 'auto', name: '自动选择（系统默认设备）' }];
    }
  }

  // 注意：mpv 0.4x 的 IPC `set` 命令值必须传字符串（原生 JSON 数字/布尔会报 invalid parameter）
  async setPaused(p) { return await this.command(['set', 'pause', p ? 'yes' : 'no']); }
  async seek(t) { await this.command(['seek', Number(t), 'absolute']); }
  async stop() {
    clearTimeout(this._eofTimer);
    this._eofTimer = null;
    this.currentFile = null;
    this._playingPos = -1;
    await this.command(['stop']);
  }
  async setVolume(v) { return await this.command(['set', 'volume', String(Math.max(0, Math.min(130, Number(v) || 0)))]); }

  /** 静音（mpv mute 属性，独占输出下同样生效；不改变音量值本身） */
  async setMuted(m) { return await this.command(['set', 'mute', m ? 'yes' : 'no']); }

  /**
   * 应用 DSP 链。
   * cfg 字段：eqOn/gains[10]/preamp（EQ+前置）、pan(-100..100)/width(0..200)、
   *          mono/swap/invL/invR（声道工具）、crossfeedOn/cfStrength/cfRange、
   *          compOn+阈值/比率/启动/释放/补偿、limOn+limCeiling(dB)、
   *          delayL/delayR(ms 延迟校正)、srcRate(off|Hz)、dither(off|算法名)、irPath(FIR)
   * 链序：firequalizer(EQ+前置) → [SRC/dither → crossfeed → 声道矩阵 → 压缩 → 限幅 → 延迟] → afir(FIR)
   * 全关时 af 为空字符串 = 纯直通，保证 Bit-perfect。
   */
  async setDsp(cfg) {
    const c = cfg || {};
    const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const r4 = (x) => { const v = Math.round(x * 10000) / 10000; if (!v) return '0'; return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''); };
    const r3 = (x) => { const v = Math.round(x * 1000) / 1000; if (!v) return '0'; return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); };

    const filters = [];
    // 1) 参量均衡 + 前置增益（firequalizer）
    const preamp = num(c.preamp, 0);
    const eqActive = !!c.eqOn && Array.isArray(c.gains) &&
      (c.gains.some((g) => Number(g) !== 0) || preamp !== 0);
    if (eqActive) {
      const freqs = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
      const entries = freqs.map((f, i) => `entry(${f},${num(c.gains[i])})`).join(';');
      const gain = preamp !== 0 ? `gain=${preamp}:` : '';
      filters.push(`lavfi=[firequalizer=${gain}gain_entry='${entries}']`);
    }

    // 2) 组合 lavfi 图
    const chain = [];

    // 2.1 重采样（强制输出采样率）与抖动算法 —— 默认不插入，保持 Bit-perfect
    const rate = c.srcRate && c.srcRate !== 'off' ? parseInt(c.srcRate, 10) : 0;
    const dm = c.dither && c.dither !== 'off' ? String(c.dither) : null;
    if (rate || dm) {
      const opts = ['resampler=swr'];
      if (dm) opts.push('dither_method=' + dm);
      chain.push('aresample=' + (rate ? rate + ':' : '') + opts.join(':'));
    }

    // 2.2 耳机交叉馈送（Bauer 风格：对侧低频混合；UI 传百分比 0..100）
    if (c.crossfeedOn) {
      const st = r3(clamp(num(c.cfStrength, 20) / 100, 0.01, 1));
      const rg = r3(clamp(num(c.cfRange, 50) / 100, 0, 1));
      chain.push(`crossfeed=strength=${st}:range=${rg}`);
    }

    // 2.3 声道矩阵：立体声宽度 / 单声道 / 左右交换 / 相位反转 / 平衡
    const pan = Number.isFinite(+c.pan) ? clamp(+c.pan, -100, 100) / 100 : 0;
    const w = Number.isFinite(+c.width) ? clamp(+c.width / 100, 0, 2) : 1;
    if (c.mono || c.swap || c.invL || c.invR || pan !== 0 || w !== 1) {
      let a = (1 + w) / 2, b = (1 - w) / 2;   // L'=aL+bR, R'=bL+aR
      if (c.mono) a = b = 0.5;                 // 单声道：等比混合
      let cLL = a, cLR = b, cRL = b, cRR = a;
      if (c.swap) { const t1 = cLL, t2 = cLR; cLL = cRL; cLR = cRR; cRL = t1; cRR = t2; }
      const gl = pan >= 0 ? 1 - pan : 1;        // 右偏压左
      const gr = pan <= 0 ? 1 + pan : 1;        // 左偏压右
      cLL *= gl; cLR *= gl; cRL *= gr; cRR *= gr;
      if (c.invL) { cLL = -cLL; cLR = -cLR; }
      if (c.invR) { cRL = -cRL; cRR = -cRR; }
      const term = (coef, inp) => { const s = r4(coef); return s === '0' ? '' : `${s}*${inp}`; };
      const t0 = [term(cLL, 'c0'), term(cLR, 'c1')].filter(Boolean).join('+') || '0*c0';
      const t1 = [term(cRL, 'c0'), term(cRR, 'c1')].filter(Boolean).join('+') || '0*c0';
      chain.push(`pan=stereo|c0=${t0}|c1=${t1}`);
    }

    // 2.4 压缩器（threshold/makeup 用 dB 后缀；attack/release 单位 ms）
    if (c.compOn) {
      const th = r3(clamp(num(c.compThresh, -18), -60, 0));
      const ratio = r3(clamp(num(c.compRatio, 3), 1, 30));
      const atk = r3(clamp(num(c.compAttack, 20), 0.01, 2000));
      const rel = r3(clamp(num(c.compRelease, 250), 0.01, 9000));
      const mk = r3(clamp(num(c.compMakeup, 0), 0, 24));
      chain.push(`acompressor=threshold=${th}dB:ratio=${ratio}:attack=${atk}:release=${rel}:makeup=${mk}dB:knee=3dB:detection=rms`);
    }

    // 2.5 峰值限幅器（ceiling dB → 线性幅度）
    if (c.limOn) {
      const lin = Math.pow(10, clamp(num(c.limCeiling, -1), -30, 0) / 20);
      chain.push(`alimiter=limit=${r4(lin)}:attack=5:release=50`);
    }

    // 2.6 左右声道延迟校正（音箱距离差补偿，ms）
    const dl = Math.max(0, Math.round(num(c.delayL, 0)));
    const dr = Math.max(0, Math.round(num(c.delayR, 0)));
    if (dl > 0 || dr > 0) chain.push(`adelay=${dl}|${dr}:all=0`);

    if (chain.length) filters.push('lavfi=[' + chain.join(',') + ']');

    // 3) FIR 卷积（耳机校正/房间补偿）
    if (c.irPath && fs.existsSync(c.irPath)) {
      const ir = String(c.irPath).replace(/\\/g, '/');
      filters.push(`lavfi=[afir=ir=${ir}:dry=10:wet=10:gtype=gn]`);
    }

    const af = filters.join(',');
    this.emit('log', 'DSP: ' + (af || '直通（无滤波）'));
    const r = await this.command(['set', 'af', af]);
    if (r && r.error) throw new Error('DSP 应用失败: ' + r.error);
    return af;
  }

  async quit() {
    clearTimeout(this._eofTimer);
    this._eofTimer = null;
    this._playingPos = -1;
    if (this.sock) {
      try { await this.command(['quit']); } catch { /* ignore */ }
      try { this.sock.destroy(); } catch { /* ignore */ }
      this.sock = null;
    }
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
    this.ready = false;
    this._pending.clear();
  }

  status() {
    return {
      available: this.available(),
      ready: this.ready,
      softvol: this.softvol,
      error: this.lastError,
      props: this.props,
    };
  }
}

module.exports = new MpvEngine();
