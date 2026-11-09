<div align="center">

# 🎵 MSP Music (Beta)

**一款主打 Bit-perfect 无损音质、B站 MV 播放与局域网互通的本地 Hi-Fi 音乐播放器**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20Android-success.svg)]()
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)]()
[![Android](https://img.shields.io/badge/Android-Media3-3DDC84?logo=android&logoColor=white)]()

[功能特性](#-核心特性) • [快速开始](#-快速开始) • [文档手册](./docs/Manual.md) • [参与开发](#-开发与构建)

</div>

---

## 📖 简介

**MSP Music** 是一款面向**本地曲库**的跨平台桌面/移动音乐播放器。它不想成为另一个“在线音乐平台”，而是把 **音质** 和 **可扩展性** 作为核心追求。借助内嵌的 mpv (FFmpeg) 和 Android Media3，提供极致的原生解码体验。

> 📌 **当前版本**：电脑版 `v26.9.16` / 安卓版 `v2.4.0` (Beta)
> 📌 **注意**：本项目当前处于 Beta 测试阶段，欢迎提交 Issue 反馈问题！

## ✨ 核心特性

- **🎵 原生高保真音质**：音频解码交由 **mpv (FFmpeg)**，支持 **WASAPI 独占输出**（Bit-perfect）与 **DSD 播放**（DoP 直通）。
- **📃 智能刮削与歌词**：优先抓取 QQ/网易云 标签与封面，自动匹配本地或在线 `.lrc` 并高亮滚动，支持简繁转换。
- **📺 B站 MV 模式**：一键搜索并播放当前歌曲的 B站 MV，支持 1080P DASH 音视频流合并与断点续播。
- **🌐 局域网互通**：同一 WiFi 下，电脑与手机可通过 6 位配对码互相串流播放对方的曲库，无需拷贝文件。
- **🎛 专业级调音台**：内置均衡器 (EQ)、混响、Crossfeed 等 DSP 音效，满足 Hi-Fi 发烧友需求。
- **📱 极致移动端体验**：安卓端基于 Java + WebView + Media3，支持息屏播放、通知栏控制、蓝牙按键与 SAF 授权（无需存储权限）。

## 🚀 快速开始

### 🖥️ 电脑版 (Windows / Linux)
1. 前往 [Releases](https://github.com/sunji621/MSP-Music-Beta/releases) 页面下载最新安装包。
2. 安装并启动软件。
3. 首次启动点击 **「添加音乐文件夹」**，扫描完成后点击任意歌曲即可开始播放。

### 📱 安卓版
1. 下载并安装 `apk/MSPMusic-Beta-*.apk`。
2. *(注意：冷启动白屏 7～12 秒是正常现象，WebView 在初始化)*。
3. 点击 **「添加音乐文件夹」**，选择文件夹并点击「允许」即可读取本地音乐。

## 📚 完整文档

为了保持首页清爽，详细的**使用教程**与**开发指南**已移至单独文档：

👉 **[点击查阅：《MSP Music 完整手册》](./docs/Manual.md)**

手册包含：功能详解、在线音源配置、局域网协议、DSP 引擎原理、打包构建踩坑记录等。

## 🛠️ 开发与构建

如果你想参与开发或自行编译：

```bash
# 克隆仓库
git clone https://github.com/sunji621/MSP-Music-Beta.git
cd MSP-Music-Beta

# 安装依赖
npm install

# 启动开发模式
npx electron .

# 打包
npm run dist