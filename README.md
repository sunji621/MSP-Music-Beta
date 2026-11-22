<div align="center">

# 🎵 MSP Music (Beta)

**本地优先的 Hi-Fi 音乐播放器 · Bit-perfect 输出 · B站 MV · 局域网互通**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20Android-success.svg)]()
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)]()
[![SQLite](https://img.shields.io/badge/Library-SQLite-003B57?logo=sqlite&logoColor=white)]()

[功能特性](#-核心特性) • [新版界面](#-新版桌面界面) • [快速开始](#-快速开始) • [数据库](#-本地曲库数据库) • [完整手册](./docs/Manual.md)

</div>

---

## 📖 简介

**MSP Music** 是一款面向**本地曲库**的跨平台音乐播放器。它不追求成为另一个在线音乐平台，而是把 **本地音乐管理、音质、可扩展性** 放在第一位。

电脑版使用 **Electron + mpv (FFmpeg)**，支持 WASAPI 独占、DSD/DoP 与专业 DSP；安卓版使用 **Java + WebView + Media3**，支持 SAF 授权、息屏播放与通知栏控制。两端可在同一 WiFi 下互相访问曲库。

> 📌 **当前版本**：电脑版 `v26.11.22-Beta` / 安卓版 `v2.4.0`
> 📌 项目处于 Beta 阶段，欢迎提交 Issue。

## ✨ 核心特性

- **🎵 Bit-perfect 音质**：mpv/FFmpeg 解码，WASAPI 独占输出，支持 DSD（DoP 直通）。
- **🗄️ SQLite 本地曲库**：扫描结果、CUE 分轨、扫描缓存、标签与歌词统一落库，重启不再全盘重扫。
- **📃 智能刮削与歌词**：QQ 音乐 / 网易云标签与封面，本地 `.lrc` 优先，逐行高亮，支持简繁转换。
- **📺 B站 MV 模式**：搜索并播放当前歌曲的 B站 MV，1080P DASH 音视频流。
- **🌐 局域网互通**：6 位配对码，电脑与手机互相串流曲库，无需拷贝文件。
- **🎛 专业调音台**：均衡器、混响、Crossfeed、延迟校正等 DSP 工具。
- **🖥 全新桌面 UI**：深色三栏、Hero 推荐、3D 封面卡堆、歌曲行操作节点、右侧播放队列、全屏播放页，支持深/浅主题。
- **📱 移动端体验**：Media3 原生播放，锁屏/通知栏/蓝牙按键，SAF 授权无需存储权限。

## 🖥 新版桌面界面

`v26.11.22-Beta` 对电脑版界面做了完整重做：

- **三栏布局**：248px 侧栏 / 主内容区 / 322px 播放队列
- **侧栏**：BETA 标识、浏览 / 音乐库 / 工具分组，本地模式状态卡
- **首页**：真实每日推荐 Hero、最近添加、今晚的混音、曲库表格
- **3D 封面卡堆**：拖拽、甩出、点击换页、自动轮换
- **歌曲行 Action Node**：鼠标长悬浮后展开播放 / 收藏 / 专辑 / 更多
- **Bencho 风格 Like**：心形弹跳、12 粒 bloom 粒子、只滚动变化的数字
- **播放器**：92px 播放条 + 全屏播放页，保留原 mpv / 歌词 / DSP 能力
- **深色 / 浅色**：两套完整主题，设置中即时切换

## 🚀 快速开始

### 🖥️ 电脑版（Windows / Linux）

1. 前往 [Releases](https://github.com/sunji621/MSP-Music-Beta/releases) 下载安装包。
2. 安装并启动。
3. 首次启动点击 **「添加音乐文件夹」**，扫描完成后点击歌曲播放。

开发模式：

```bash
git clone https://github.com/sunji621/MSP-Music-Beta.git
cd MSP-Music-Beta
npm install
npx electron .
```

### 📱 安卓版

1. 下载并安装 `apk/MSPMusic-Beta-*.apk`。
2. 冷启动白屏 7～12 秒属于 WebView 初始化，不是死机。
3. 点击 **「添加音乐文件夹」**，选择目录并允许访问。

## 🗄️ 本地曲库数据库

从 `v26.11.22-Beta` 开始，电脑版曲库会写入 SQLite：

```text
%APPDATA%\msp-music-beta\music-library.db
```

包含：

- `tracks`：曲目、CUE 分轨、标题/歌手/专辑/时长/歌词/元数据
- `scan_dirs`：音乐目录 mtime 与扫描结果缓存
- `kv`：预留配置与迁移数据

特性：

- 根目录 mtime 未变时，重启直接复用扫描结果，不再遍历整个磁盘
- 旧 JSON 元数据缓存命中时自动回填数据库
- 使用 [sql.js](https://github.com/sql-js/sql.js)（SQLite WebAssembly），数据库文件可用 DB Browser for SQLite 直接打开

## 🧱 技术栈

| 层 | 电脑版 | 安卓版 |
|---|---|---|
| 界面 | HTML/CSS/JS（`index.html` + `ui-shell.css`） | HTML/CSS/JS（`mobile.html`） |
| 外壳 | Electron 33 | Java + WebView |
| 播放 | mpv / FFmpeg | Media3 / ExoPlayer |
| 数据 | SQLite（sql.js）+ JSON + localStorage | SQLite/SAF + localStorage |
| 网络 | axios + 自定义协议 | Java 网络桥 |

## 📁 目录结构（电脑版）

```text
.
├─ index.html              # 电脑版界面与渲染层逻辑
├─ ui-shell.css            # 新版 MSP UI 样式
├─ main.js                 # Electron 主进程：扫描/刮削/IPC/托盘
├─ preload.js              # contextBridge 白名单
├─ db.js                   # SQLite 曲库数据库
├─ mpv-engine.js           # mpv 进程封装
├─ lan-server.js           # 局域网 HTTP + UDP 服务
├─ login-preload.js        # 登录窗口 preload
├─ docs/Manual.md          # 完整使用与开发手册
└─ apk/                    # 安卓工程与安装包
```

## 🛠️ 开发与构建

```bash
npm install        # 安装依赖
npx electron .     # 开发运行
npm run pack       # 生成未打包目录
npm run dist       # 生成安装包
```

打包配置在 `package.json` 的 `build` 字段；`db.js` 已加入 `files`。

> 打包前请把 `mpv.exe` 放到 `bin/mpv/mpv.exe`（约 62 MB，未纳入 Git）。安装包生成在 `release-new/`；GitHub 下载慢时可设置 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

## 📚 完整文档

详细使用教程、架构、局域网协议、DSP、调试与发版流程见：

👉 **[《MSP Music 完整手册》](./docs/Manual.md)**

## ⚖️ 声明

- 本项目采用 **GPL-3.0**，衍生作品需继续开源。
- 仅供学习与个人本地音乐管理；在线音源版权归原平台及权利人所有。
- 账号登录在平台官方页面完成，本软件不获取、不上传账号密码。
