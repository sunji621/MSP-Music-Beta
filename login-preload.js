// 登录窗口反检测 preload：伪装成真实 Chrome 浏览器
// contextIsolation: false，直接修改页面上下文

(() => {
  // 1. 移除 webdriver 标记
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

  // 2. 伪造 window.chrome 对象
  if (!window.chrome) {
    window.chrome = {};
  }
  window.chrome.runtime = window.chrome.runtime || {
    OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
    OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
    PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
    PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
    RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
  };

  // 3. 伪造 languages
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true });

  // 4. 伪造 plugins（Chrome 默认有几个内置插件）
  const fakePlugins = [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
  ];
  Object.defineProperty(navigator, 'plugins', {
    get: () => fakePlugins,
    configurable: true,
  });

  // 5. 伪造 platform
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });

  // 6. Notification.permission
  try {
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
  } catch (e) {}

  // 7. WebGL 渲染器信息伪装
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
      return getParameter.apply(this, arguments);
    };
  } catch (e) {}

  // 8. 移除 Electron 特有属性
  delete window.process;
  delete window.Buffer;
  delete window.global;
  delete window.require;
  delete window.module;
  delete window.exports;
  delete window.__dirname;
  delete window.__filename;
})();
