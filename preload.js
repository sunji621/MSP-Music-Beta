/**
 * ─── preload.js ───
 * 通过 contextBridge 安全地将主进程能力暴露给渲染进程。
 * 渲染进程无法直接访问 Node.js API 或 Electron 内部模块。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /** 打开文件夹选择对话框，返回音频文件列表 */
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  /** 获取文件夹内音频文件预览（用于侧边栏显示） */
  previewFolder: (dirPath) => ipcRenderer.invoke('preview-folder', dirPath),

  /** 重新扫描已选择的音乐文件夹（刷新音乐库，不弹对话框） */
  scanFolder: (dirPath) => ipcRenderer.invoke('scan-folder', dirPath),

  /** 请求单首歌曲的元数据（结果通过 onSongInfoResult 回调接收） */
  requestSongInfo: (filePath) => {
    ipcRenderer.send('request-song-info', filePath);
  },

  /** 监听元数据结果回调 */
  onSongInfoResult: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('song-info-result', handler);
    // 返回取消监听的函数
    return () => ipcRenderer.removeListener('song-info-result', handler);
  },

  /** 监听大曲库检测事件（扫描到超过阈值歌曲数时触发） */
  onLargeLibraryDetected: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('large-library-detected', handler);
    return () => ipcRenderer.removeListener('large-library-detected', handler);
  },

  /** 监听扫描进度事件 */
  onScanProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('scan-progress', handler);
    return () => ipcRenderer.removeListener('scan-progress', handler);
  },

  /** 切换全屏 */
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),

  /** ── Bit-perfect 音频引擎（mpv / WASAPI 独占）── */

  /** 播放本地文件：{ path, dop, exclusive, softvol, device, start, end } */
  enginePlay: (opts) => ipcRenderer.invoke('engine:play', opts),
  /** Gapless 预载下一首：{ path, start, end } */
  engineAppend: (opts) => ipcRenderer.invoke('engine:append', opts),
  /** 枚举 WASAPI 输出设备 [{id,name}] */
  engineDevices: () => ipcRenderer.invoke('engine:devices'),
  /** 暂停/恢复 */
  enginePause: (paused) => ipcRenderer.invoke('engine:pause', paused),
  /** 绝对定位（秒，文件绝对时间） */
  engineSeek: (t) => ipcRenderer.invoke('engine:seek', t),
  /** 停止播放 */
  engineStop: () => ipcRenderer.invoke('engine:stop'),
  /** 软件音量（仅 softvol 开启时生效）0-130 */
  engineVolume: (v) => ipcRenderer.invoke('engine:volume', v),
  /** 引擎静音/取消静音（mpv mute 属性，独占输出下同样生效） */
  engineMute: (m) => ipcRenderer.invoke('engine:mute', m),
  /** 应用 DSP（EQ/声场/Crossfeed/压缩限幅/延迟/SRC/FIR） */
  engineSetDsp: (cfg) => ipcRenderer.invoke('engine:dsp', cfg),
  /** 引擎状态 { available, ready, softvol, error, props } */
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  /** 选择 FIR 卷积脉冲响应文件，返回路径或 null */
  pickIrFile: () => ipcRenderer.invoke('pick-ir-file'),

  /** ── 硬件系统音量（Windows Core Audio / IAudioEndpointVolume）── */
  /** 启动音量控制并读取当前值：{ ok, volume(0..1), muted } */
  hwVolStart: () => ipcRenderer.invoke('hwvol:start'),
  /** 设置系统主音量 0..1 */
  hwVolSet: (v) => ipcRenderer.invoke('hwvol:set', v),
  /** 系统静音/取消静音 */
  hwVolMute: (m) => ipcRenderer.invoke('hwvol:mute', m),
  /** 引擎事件：progress / params / ended / start-file / file-error / engine-exit */
  onEngineEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('engine:event', handler);
    return () => ipcRenderer.removeListener('engine:event', handler);
  },

  /** 获取应用目录路径 */
  getAppPath: () => ipcRenderer.invoke('get-app-path'),

  /** ── 文件管理（设置页）── */

  /** 列出音乐文件夹的一级子文件夹 + 全部音频文件（递归） */
  fsList: (dirPath) => ipcRenderer.invoke('fs-list', dirPath),

  /** 在音乐文件夹下新建子文件夹 */
  fsMkdir: (dirPath, name) => ipcRenderer.invoke('fs-mkdir', dirPath, name),

  /** 重命名文件或文件夹（newName 仅名称，不含路径） */
  fsRename: (targetPath, newName) => ipcRenderer.invoke('fs-rename', targetPath, newName),

  /** 删除文件或文件夹（移入回收站） */
  fsDelete: (targetPath) => ipcRenderer.invoke('fs-delete', targetPath),

  /** ── 日志系统（设置页日志查看器）── */

  /** 订阅主进程日志推送，返回已有日志快照，并在有新日志时回调 */
  logSubscribe: (callback) => {
    const handler = (_event, entry) => callback(entry);
    ipcRenderer.on('log-push', handler);
    // 返回取消订阅的函数
    return () => ipcRenderer.removeListener('log-push', handler);
  },
  /** 获取已有日志快照（初始化时拉取） */
  logGetAll: () => ipcRenderer.invoke('log-subscribe'),
  /** 清空日志 */
  logClear: () => ipcRenderer.invoke('log-clear'),

  /** ── 自定义标题栏窗口控制 ── */
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winToggleMaximize: () => ipcRenderer.send('win-toggle-maximize'),
  winClose: () => ipcRenderer.send('win-close'),
  winIsMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  /** 监听最大化/还原状态变化，返回取消监听函数 */
  onWinMaximizeChange: (callback) => {
    const handler = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on('win-maximize-changed', handler);
    return () => ipcRenderer.removeListener('win-maximize-changed', handler);
  },

  /** ── 系统托盘 / 关闭确认 ── */
  /** 隐藏窗口到系统托盘（音乐继续播放） */
  winHideToTray: () => ipcRenderer.send('win-hide-to-tray'),
  /** 真正退出应用 */
  winQuitApp: () => ipcRenderer.send('win-quit-app'),
  /** 记住"始终最小化到托盘"偏好（同步给主进程落盘） */
  winSetTrayPref: (minimize) => ipcRenderer.send('win-set-tray-pref', minimize),
  /** 读取主进程已保存的托盘偏好（旧版本偏好迁移） */
  winGetTrayPref: () => ipcRenderer.invoke('win-get-tray-pref'),
  /** 选择自定义背景图片（主进程复制到 userData 后返回 file:// URL） */
  pickBgImage: () => ipcRenderer.invoke('pick-bg-image'),
  /** 读取当前背景图为 dataURL（导出配置时内嵌） */
  readBgDataUrl: () => ipcRenderer.invoke('read-bg-dataurl'),
  /** 把内嵌背景 dataURL 落盘，返回 file:// URL（导入配置时） */
  writeBgDataUrl: (dataUrl) => ipcRenderer.invoke('write-bg-dataurl', dataUrl),
  /** 导出配置到 .msp 文件（传入 JSON 字符串） */
  saveConfigFile: (jsonStr) => ipcRenderer.invoke('save-config-file', jsonStr),
  /** 打开 .msp/.json 配置文件并返回内容 */
  openConfigFile: () => ipcRenderer.invoke('open-config-file'),

  /** 监听主进程转发的关闭请求（Alt+F4 / 任务栏关闭），返回取消监听函数 */
  onCloseRequested: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('close-requested', handler);
    return () => ipcRenderer.removeListener('close-requested', handler);
  },

  /** ── 网易云音乐 ── */
  neteaseSearch: (keyword) => ipcRenderer.invoke('netease-search', keyword),
  neteaseSongUrl: (id) => ipcRenderer.invoke('netease-song-url', id),
  neteaseLyric: (id) => ipcRenderer.invoke('netease-lyric', id),
  neteaseLogin: (phone, password, captcha) => ipcRenderer.invoke('netease-login', phone, password, captcha),
  neteaseSendCaptcha: (phone) => ipcRenderer.invoke('netease-send-captcha', phone),
  neteaseLogout: () => ipcRenderer.invoke('netease-logout'),
  neteaseStatus: () => ipcRenderer.invoke('netease-status'),
  neteaseWebLogin: () => ipcRenderer.invoke('netease-web-login'),

  /** ── B站 ── */
  bilibiliSearch: (keyword) => ipcRenderer.invoke('bilibili-search', keyword),
  bilibiliVideoUrl: (bvid) => ipcRenderer.invoke('bilibili-video-url', bvid),
  bilibiliQrcode: () => ipcRenderer.invoke('bilibili-qrcode'),
  bilibiliPollQrcode: (qrcodeKey) => ipcRenderer.invoke('bilibili-poll-qrcode', qrcodeKey),
  bilibiliLogout: () => ipcRenderer.invoke('bilibili-logout'),
  bilibiliStatus: () => ipcRenderer.invoke('bilibili-status'),
  bilibiliSmsLogin: () => ipcRenderer.invoke('bilibili-sms-login'),
  // QQ音乐
  qqSearch: (keyword) => ipcRenderer.invoke('qq-search', keyword),
  qqSongUrl: (songmid) => ipcRenderer.invoke('qq-song-url', songmid),
  qqLyric: (songmid) => ipcRenderer.invoke('qq-lyric', songmid),
  qqQrcode: () => ipcRenderer.invoke('qq-qrcode'),
  qqPollQrcode: (qrsig) => ipcRenderer.invoke('qq-poll-qrcode', qrsig),
  qqLoginSave: (cookie) => ipcRenderer.invoke('qq-login-save', cookie),
  qqLogout: () => ipcRenderer.invoke('qq-logout'),
  qqStatus: () => ipcRenderer.invoke('qq-status'),
  qqSmsLogin: () => ipcRenderer.invoke('qq-sms-login'),

  /** ── 局域网互通（手机端浏览/播放/下载本机曲库）── */
  /** 状态：{running, port, name, ips, preferredIP, count} */
  lanGetStatus: () => ipcRenderer.invoke('lan:get-status'),
  /** 开关/改名：{ enabled?:boolean, name?:string } */
  lanSet: (opts) => ipcRenderer.invoke('lan:set', opts),
  /** 全量同步本地曲库：[{id,title,artist,album,duration,ext,path}] */
  lanSyncLibrary: (tracks) => ipcRenderer.send('lan:sync-library', tracks),
  /** 更换 6 位配对码，返回新码 */
  lanRegenPin: () => ipcRenderer.invoke('lan:regen-pin'),
  /** 解除已配对设备（id 为 token 前 8 位） */
  lanUnpair: (id) => ipcRenderer.invoke('lan:unpair', id),
  /** 附近的手机共享端列表 */
  lanGetPeers: () => ipcRenderer.invoke('lan:get-peers'),
  /** 代请求手机端 API（配对/取曲库），音频与封面由标签直连 */
  lanPeerRequest: (req) => ipcRenderer.invoke('lan:peer-request', req),
});