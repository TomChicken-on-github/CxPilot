# ✈️ CxPilot

> **Automated Chaoxing lecture pilot** — auto-plays recorded courses and advances chapters hands-free.

---

## 功能特性

- 🎬 **自动播放**：基于 Playwright，在真实浏览器中打开录播课页面并注入进度监听器
- 📊 **进度检测**：`setInterval` 与 `timeupdate` 双保险轮询，无惧视频断点异步恢复与防自动播放拦截，精准捕捉 90% 进度
- ⏭️ **智能跳章**：优先触发播放器下方“下一节”按钮；自动跳过已完成章节；首创**侧边栏智能序号解析**引擎，按自然序号（1.1 -> 1.2 -> 2.1）回退跳转，彻底解决跳乱、跳测验的问题
- 🔒 **进程锁**：`runner.lock` 机制防止多实例并发打开浏览器
- 📝 **完整日志**：请求抓包（`captured_requests.json`）、章节记录（`completed_lessons.json`）、运行日志（`run.log`）
- 🛡️ **弹窗处理**：自动 accept JS dialog，并周期性点击"确定/确认/跳过"类 DOM 弹窗

---

## 快速开始

### 前提

- Node.js ≥ 18
- pnpm（或 npm）

### 安装

```bash
pnpm install
pnpm exec playwright install chromium
```

### 登录态准备

首次使用需手动登录一次并导出登录态到 `data/storage.json`：

```bash
mkdir data
npx playwright open --save-storage=data/storage.json https://mooc1.chaoxing.com
```

在打开的浏览器中完成登录，关闭窗口后 `data/storage.json` 即生成。

> ⚠️ **不要将 `data/storage.json` 提交到版本库！** 它包含你的登录凭据。

### 运行

```bash
# 默认从上次中断的进度继续播放
node src/run_loop.js

# 指定从某个具体的章节序号开始（例如 2.1）
node src/run_loop.js 2.1

# 或使用 npm 脚本
pnpm start 2.1
```

---

## 项目结构

```
CxPilot/
├── src/
│   ├── main.js                     # 主脚本：自动化播放 & 进度检测
│   ├── run_loop.js                 # 启动器（单次运行模式）
│   └── lib/
│       ├── lock.js                 # 进程锁模块
│       └── logger.js               # 日志模块
├── tools/
│   ├── analyze_enc.js              # 签名/enc 分析工具
│   ├── analyze_capture.js          # 抓包分析工具
│   ├── capture_play_requests.js    # 早期探测脚本（一次性抓包）
│   └── inspect_next_button.js      # 下一节按钮检测工具
├── data/                           # 运行时产生的数据（被 git 忽略）
│   ├── storage.json                # 登录态（⚠️ 包含敏感凭据）
│   ├── captured_requests.json      # 抓包与事件日志（运行时追加）
│   ├── completed_lessons.json      # 已完成章节列表
│   └── runner.lock                 # 进程锁文件
└── logs/                           # 运行日志目录
    └── run.log
```

---

## 工作原理

```mermaid
flowchart TD
  Start[开始：准备 storage.json] --> Open[Playwright 打开播放页]
  Open --> Locate{定位 video 元素}
  Locate -- 未找到 --> Wait[等待/重试/找下一节]
  Locate -- 找到 --> Inject[注入 setInterval 双保险监听]
  Inject --> Monitor[轮询检查 & 防全局旧日志穿透]
  Monitor --> Check{进度 ≥ 90%?}
  Check -- 否 --> Monitor
  Check -- 是 --> Save[记录 completed_lessons.json]
  Save --> RandWait[随机等待 1~3s]
  RandWait --> ClickNext[点击底部“下一节”按钮]
  ClickNext --> Nav{导航成功?}
  Nav -- 是 --> SaveProgress[写 progress.json，开始下一节]
  Nav -- 否 --> Fallback[侧边栏序号智能跳转 (如 1.1 -> 1.2)]
  Fallback --> SaveProgress

  classDef err fill:#fdd;
  class Fallback err;
```

---

## 调试

遇到多浏览器实例或崩溃时：

```powershell
# 强制终止所有 node 进程
Get-Process -Name node | Stop-Process -Force

# 手动清理锁文件
Remove-Item data/runner.lock -ErrorAction SilentlyContinue
```

---

## 已知问题

| 问题 | 状态 |
|---|---|
| Target page closed 导致崩溃 | ✅ 已修复 (添加全局错误捕获机制) |
| 章节 ID 非线性跳号、PCount乱跳 | ✅ 已修复 (剥离 PCount.next，启用智能序号解析) |
| enc 签名来源未明确 | 🔍 分析中（见 `tools/analyze_enc.js`） |

---

## License

MIT
