# ✈️ CxPilot

<p align="center">
  <b>现代化、智能化的超星 / 学习通录播网课全自动挂机助手</b>
  <br />
  <i>Automated Chaoxing lecture pilot — auto-plays recorded courses and advances chapters hands-free.</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A518.0.0-green?style=flat-square" alt="Node.js" />
  <img src="https://img.shields.io/badge/Playwright-Automated-purple?style=flat-square" alt="Playwright" />
  <img src="https://img.shields.io/badge/Release-EXE%20Available-orange?style=flat-square" alt="Release" />
  <img src="https://img.shields.io/badge/License-MIT-brightgreen?style=flat-square" alt="License" />
</p>

---

## 🌟 核心特性

- 🖥️ **双运行形态支持**：
  - **开箱即用**：提供 Windows 单文件便携版可执行程序（`CxPilot.exe`），无需预装 Node.js 或配置复杂环境。
  - **源码驱动**：完整支持源码级定制与二次开发，多平台跨系统运行。
- 🧭 **自然序号智能跳章引擎**：
  - 首创**侧边栏智能序号解析**：严格遵循自然序号递进（如 `1.1` $\rightarrow$ `1.2` $\rightarrow$ `2.1`），自动过滤测验、作业、非视频小节及已完成章节，彻底解决旧版跳乱、死循环等痛点。
  - **双重跳章策略**：优先触发播放器底部原生“下一节”按钮，失败时自动无缝回退至侧边栏层级解析跳转。
- ⚡ **倍速随心自定**：
  - 控制台提供 `1x` ~ `5x` 快捷倍速预设，同时支持 `0.1x` ~ `32x` 自定义倍速调节，自动绕过播放器原生效验。
- 📊 **双保险进度检测与实时终端进度条**：
  - 结合 `setInterval` 轮询与 HTML5 `timeupdate` 事件双通道监听，精准捕获 90% 达标节点与完播事件。
  - 终端配备高颜值单行覆写进度条，直观展示实时进度百分比与剩余播放时长。
- 🔁 **全自动防卡死看门狗与自愈**：
  - **播放卡死检测**：视频播放停滞超过 3 分钟自动刷新页面并重试（最多重试 3 次）。
  - **Iframe 动态重注入**：监听 `framenavigated` 事件，页面重载或切换时自动重新注入监听器。
  - **守护进程自动重启**：子进程异常退出时，5 秒内自动读取最后进度快照并无缝恢复执行。
- 🔑 **全自动会话管理与签名自动续签**：
  - 自动检测并等待手动扫码/账号登录，登录成功自动持久化登录态到 `data/storage.json`。
  - 智能探测可能过期的 `enc` 签名链接，自动返回课程主页重新签发全新凭据，免去频繁手动更新链接的烦恼。
- 🛡️ **智能弹窗拦截与环境兼容**：
  - 自动接受 JS 原生弹窗（Alert / Confirm / Prompt），周期性点击页面内“确定 / 继续观看”防作弊互动弹窗。
  - 优先调用系统自带 Edge / Chrome 独立沙盒会话；若系统无兼容内核，全自动异步下载轻量 Chromium 执行环境。
- 🔒 **单例进程锁与全链路日志**：
  - 基于 `data/runner.lock` 防止多实例并发冲突。
  - 全链路结构化日志输出至 `logs/`，完整记录运行轨迹与抓包快照。

---

## 🚀 快速上手

### 方式一：直接运行独立版 EXE（推荐新手使用）

1. 前往本项目的 **[Releases](../../releases)** 页面下载最新版本的 `CxPilot.exe`。
2. 双击运行 `CxPilot.exe`：
   - 若首次使用且未检测到登录凭据，程序会自动唤起独立的浏览器窗口，请在其中**完成超星/学习通登录**。
   - 登录完成后，程序会自动保存会话并在控制台展示交互式菜单。
3. 使用键盘上下箭头键 `↑` `↓` 选择运行模式与播放倍速即可开始挂机！

---

### 方式二：从源码运行与二次开发

#### 1. 环境准备
- **Node.js** $\ge 18.0.0$
- 包管理器：**pnpm**（推荐）或 **npm**

#### 2. 克隆与安装依赖
```bash
git clone https://github.com/TomChicken-on-github/CxPilot.git
cd CxPilot

# 安装项目依赖
pnpm install

# 安装 Playwright 浏览器内核 (可选，程序内置 Edge/Chrome 调用与自动下载能力)
pnpm exec playwright install chromium
```

#### 3. 配置课程链接
在项目根目录创建 `.env` 文件（或直接通过控制台指定），填入课程主页链接：
```env
DEFAULT_COURSE_URL=https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=xxxx&clazzid=xxxx&cpi=xxxx&enc=xxxx
```

#### 4. 启动运行
```bash
# 交互式启动（推荐）
pnpm start
# 或
node src/run_loop.js

# 直接指定起始章节序号（例如从 2.1 节开始）
node src/run_loop.js 2.1
```

---

## 🎛️ 运行模式说明

启动程序后，交互式终端将提供以下运行模式：

| 模式 | 描述 |
|---|---|
| ▶️ **继续上次的进度** | 自动读取 `data/progress.json`，从上一次中断或挂机结束的位置继续播放 |
| 🎯 **指定目标章节开始** | 输入章节序号（如 `1.2`、`3.1`）或直接输入超星的纯数字 `chapterId` 跳转 |
| 🌐 **从默认课程入口开始** | 从 `.env` 中配置的 `DEFAULT_COURSE_URL` 或内置课程主页第 1 节开始播放 |
| ❌ **退出** | 安全释放进程锁并退出程序 |

---

## ⚙️ 进阶配置与环境变量

你可以在根目录下新建 `.env` 文件以覆盖默认行为：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DEFAULT_COURSE_URL` | *(内置预设链接)* | 默认课程入口主页 URL |
| `MAX_LESSONS` | `20` | 单次挂机最大连续执行章节数 |
| `DAEMON_MODE` | `false` | 是否开启守护进程死循环自愈模式（`true`/`false`） |
| `MAX_RETRIES` | `3` | 守护进程连续异常重启的最大重试次数 |
| `PLAY_SPEED` | `1` | 视频默认播放倍速（支持 `1` ~ `32`） |

`.env` 示例配置：
```ini
DEFAULT_COURSE_URL=https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=263837700&clazzid=147110605&cpi=517019981&enc=1c0c74b9a48543e4ae307613f2ebf9ad&t=1787037581265&pageHeader=1
MAX_LESSONS=50
DAEMON_MODE=true
MAX_RETRIES=5
```

---

## 🏗️ 工作流程与运行架构

```mermaid
flowchart TD
    Start([🚀 启动 CxPilot]) --> LockCheck{获取进程互斥锁}
    LockCheck -- 失败: 存在并发实例 --> ExitLock[🛑 提示并退出]
    LockCheck -- 成功 --> CheckSession{检查 data/storage.json}

    CheckSession -- 凭据缺失/失效 --> ManualLogin[🔑 唤起浏览器手动登录]
    ManualLogin --> SaveSession[💾 保存 session 至 storage.json]
    SaveSession --> ShowMenu[📋 交互式菜单 & 倍速选择]
    CheckSession -- 凭据有效 --> ShowMenu

    ShowMenu --> LaunchBrowser[🌐 启动 Edge/Chrome 独立沙盒会话]
    LaunchBrowser --> NavChapter[📚 打开章节播放页]

    NavChapter --> EncCheck{enc 签名是否有效?}
    EncCheck -- 签名过期 --> ReSign[🔄 返回课程主页重新签发链接]
    ReSign --> NavChapter
    EncCheck -- 签名正常 --> LocateVideo{定位页面/iframe 视频控件}

    LocateVideo -- 未找到视频 --> SkipNonVideo[⏭️ 跳过非视频节点, 寻找下一节]
    LocateVideo -- 成功定位 --> InjectScript[💉 注入倍速 & 双通道进度监听]

    InjectScript --> Playing[▶️ 播放视频 & 渲染终端动态进度条]
    
    Playing --> Watchdog{3分钟内进度静止?}
    Watchdog -- 是 (卡死) --> RefreshPage[🔄 自动刷新页面 (最多3次)]
    RefreshPage --> InjectScript
    
    Playing --> ProgressCheck{视频进度 ≥ 90% / 完播?}
    ProgressCheck -- 否 --> Playing
    ProgressCheck -- 是 --> MarkDone[💾 写入 completed_lessons.json]

    MarkDone --> NextStep[🖱️ 触发跳章]
    NextStep --> ClickBottom{点击播放器下方'下一节'}
    ClickBottom -- 成功 --> UpdateProgress[📝 更新 progress.json]
    ClickBottom -- 失败 --> SidebarParse[🧭 侧边栏自然序号智能解析]
    SidebarParse --> UpdateProgress

    UpdateProgress --> LoopCheck{达到最大章节数 / 全部结束?}
    LoopCheck -- 否 --> NavChapter
    LoopCheck -- 是 --> Cleanup[🧹 清理资源并释放锁]
    Cleanup --> Done([✅ 挂机任务圆满完成])

    classDef success fill:#d4edda,stroke:#28a745,color:#155724;
    classDef warning fill:#fff3cd,stroke:#ffc107,color:#856404;
    classDef danger fill:#f8d7da,stroke:#dc3545,color:#721c24;

    class Done,MarkDone success;
    class Watchdog,RefreshPage,ReSign warning;
    class ExitLock danger;
```

---

## 📂 项目结构

```text
CxPilot/
├── src/
│   ├── main.js                     # 核心业务引擎：浏览器调度、视频监听、跳章与自愈
│   ├── run_loop.js                 # 交互式 CLI 入口与守护进程看门狗
│   ├── config.js                   # 全局环境变量与配置解析器
│   └── lib/
│       ├── lock.js                 # 进程互斥锁模块 (防止多开冲突)
│       └── logger.js               # 结构化全链路日志与终端进度条渲染器
├── tools/                          # 辅助分析与逆向抓包工具集
│   ├── analyze_enc.js              # 课程 enc 校验与签名算法分析
│   ├── analyze_capture.js          # 网络抓包与回放数据分析
│   ├── capture_play_requests.js    # 页面请求抓取调试工具
│   └── inspect_next_button.js      # 播放器 DOM 节点与下一节按钮探测工具
├── data/                           # 运行时数据目录（已加入 .gitignore）
│   ├── storage.json                # 浏览器持久化登录态
│   ├── progress.json               # 当前挂机进度快照
│   ├── chapter_list.json           # 课程章节层级结构缓存
│   ├── completed_lessons.json      # 已完成章节持久化清单
│   └── runner.lock                 # 进程互斥锁标记
├── logs/                           # 运行日志归档目录
│   └── latest.log                  # 最新一次运行的控制台输出全记录
└── package.json
```

---

## 🛠️ 常见问题排查 (FAQ)

<details>
<summary><b>Q1: 运行时报错 <code>[LOCK] Cannot start: Lock held by PID...</code> 怎么办？</b></summary>

这是为了防止同时打开多个浏览器冲突而设计的**进程锁机制**。
- 如果之前程序异常被强杀导致锁未正常释放，直接删除 `data/runner.lock` 文件即可。
- PowerShell 快速清理命令：
  ```powershell
  Remove-Item data/runner.lock -ErrorAction SilentlyContinue
  ```
</details>

<details>
<summary><b>Q2: 提示缺少浏览器内核或者启动报错？</b></summary>

`CxPilot` 会按以下优先级自动寻找可用浏览器：
1. 本地已安装的 **Microsoft Edge**（Windows 默认自带）；
2. 本地已安装的 **Google Chrome**；
3. 若均不存在，程序会自动下载并解压官方轻量版 `Chrome for Testing` 到 `data/chromium-fallback/` 目录中，全程全自动，无需手动配置。
</details>

<details>
<summary><b>Q3: 遇到防作弊弹窗、做题或作业卡住怎么办？</b></summary>

- 程序会自动模拟点击常见的“继续播放 / 确认”等页面 DOM 弹窗。
- 对于章节末尾的作业/测验页面，智能跳章引擎会自动探测并跳过非视频小节，继续播放后续章节的视频课程。
</details>

<details>
<summary><b>Q4: Windows Defender 或杀毒软件报毒/未知发布者？</b></summary>

由于 GitHub Actions 自动打包的 EXE 采用自动化构建生成，且未向微软购买昂贵的商业代码签名证书，属于正常误报。请点击 **“更多信息” $\rightarrow$ “仍要运行”** 即可正常使用。
</details>

---

## ⚠️ 免责声明 (Disclaimer)

1. 本项目仅供**计算机自动化测试与 Playwright 技术研究学习**交流使用。
2. 请合理安排学习时间，遵守所在高校及平台的相关学术规定与使用协议。
3. 作者不对使用本脚本所产生的任何直接或间接后果负责。

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
