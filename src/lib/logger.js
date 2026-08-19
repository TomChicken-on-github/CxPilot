/**
 * T4 — 统一日志模块
 * 将关键事件以 JSON Lines 格式写入 run.log，便于聚合与分析。
 *
 * 每条日志格式：
 * {"ts":"ISO8601","level":"info|warn|error","event":"start|stop|error|navigate|complete|skip|click|progress","...data"}
 */
const fs = require('fs');
const path = require('path');

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const LOG_FILE = path.join(logsDir, 'run.log');

function formatTime(date) {
  const pad = (n) => n.toString().padStart(2, '0');
  const y = date.getFullYear().toString().slice(-2);
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

function createProgressBar(pctString, length = 25) {
  const pct = Math.min(100, Math.max(0, parseFloat(pctString) || 0));
  const filledLength = Math.round(length * pct / 100);
  const emptyLength = length - filledLength;
  const filledStr = '█'.repeat(filledLength);
  const emptyStr = '░'.repeat(emptyLength);
  return `[${filledStr}${emptyStr}]`;
}

function formatProgressTime(currentSec, durationSec) {
  const pad = (n) => n.toString().padStart(2, '0');
  const durH = Math.floor(durationSec / 3600);
  const durM = Math.floor((durationSec % 3600) / 60);
  const durS = Math.floor(durationSec % 60);
  
  const curH = Math.floor(currentSec / 3600);
  const curM = Math.floor((currentSec % 3600) / 60);
  const curS = Math.floor(currentSec % 60);
  
  if (durH > 0) {
    return `[${pad(curH)}:${pad(curM)}:${pad(curS)}/${pad(durH)}:${pad(durM)}:${pad(durS)}]`;
  } else {
    return `[${pad(curM)}:${pad(curS)}/${pad(durM)}:${pad(durS)}]`;
  }
}

let currentProgress = '';

function clearProgress() {
  if (currentProgress) {
    process.stdout.write('\x1b[2K\r'); // 清除当前行并回车
  }
}

function restoreProgress() {
  if (currentProgress) {
    process.stdout.write(currentProgress);
  }
}

/**
 * 写入一行 JSON Lines 日志
 * @param {'info'|'warn'|'error'} level
 * @param {string} event - 事件类型
 * @param {object} [data] - 附加数据
 */
function log(level, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data
  };
  try {
    // 进度日志太频繁，不写入 JSON 文件以防暴增
    if (event !== 'video_progress') {
      fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    }
  } catch (e) {
    console.error('[LOGGER] Failed to write log:', e.message);
  }

  // ─── 控制台人性化输出 ───
  let humanMsg = '';
  switch (event) {
    case 'runner_start': humanMsg = `🚀 [监督进程] 启动 (PID: ${data.pid})`; break;
    case 'runner_launch': humanMsg = `▶️ [开始任务] URL: ${data.startUrl}`; break;
    case 'runner_child_exit': humanMsg = `⏹️ [子进程退出] 状态码: ${data.status}`; break;
    case 'runner_stop': humanMsg = `🛑 [监督进程] 结束运行`; break;
    case 'start': humanMsg = `🌐 [浏览器] 启动自动化会话 (最大执行: ${data.maxLessons}节)`; break;
    case 'cleanup': humanMsg = `🧹 [清理释放] 退出代码: ${data.exitCode}`; break;
    case 'stop': humanMsg = `✅ [任务完成] 共处理 ${data.lessonsProcessed} 节课`; break;
    case 'lesson_start': humanMsg = `📚 [章节开始] 第 ${data.lessonIndex} 节，等待页面加载...`; break;
    case 'video_found': humanMsg = `🎥 [视频就绪] 正在注入进度检测与防作弊点击`; break;
    case 'video_start': humanMsg = `▶️ [开始播放] 从 ${data.pct}% 处开始播放。💡 提示：如需退出请在终端按 Ctrl+C，直接关闭浏览器会导致异常重启！`; break;
    case 'video_progress':
      // 进度条专门逻辑：单行覆盖
      clearProgress();
      const timeStr = formatTime(new Date());
      const bar = createProgressBar(data.pct);
      const timeProgress = formatProgressTime(data.current || 0, data.duration || 0);
      currentProgress = `[${timeStr}] 📈 [播放进度] ${timeProgress} ${bar} ${data.pct}%`;
      process.stdout.write(currentProgress);
      return;
    case 'progress_90': 
      clearProgress(); // 必须先清除终端上的进度条
      currentProgress = ''; // 达标后清空进度显示
      humanMsg = `🎉 [进度达标] 视频进度已 >= 90% (将等待 ${data.waitMs}ms 后跳章)`; 
      break;
    case 'complete': humanMsg = `💾 [保存记录] 章节 ${data.chapterId} 已标记为完成`; break;
    case 'click_next_method': humanMsg = `🖱️ [触发跳章] 采用方案: ${data.method === 'bottom_next_button' ? '播放器下方按钮' : data.method}`; break;
    case 'click_next': humanMsg = `🖱️ [点击下一节] 触发结果: ${data.clicked ? '成功' : '失败'}`; break;
    case 'navigate': humanMsg = `🧭 [导航跳转] 方式: ${data.source} ${data.chapterId ? `-> 章节 ${data.chapterId}` : ''}`; break;
    case 'skip': humanMsg = `⏭️ [跳过当前] 章节 ${data.chapterId} 此前已完成`; break;
    case 'skip_failed': humanMsg = `⚠️ [跳过失败] 无法找到章节 ${data.chapterId} 的下一节`; break;
    case 'no_next': humanMsg = `🏁 [播放结束] 未检测到下一节链接`; break;
    case 'no_navigation': humanMsg = `⏳ [跳转超时] 点击后未发生页面跳转`; break;
    case 'chapter_list_updated': humanMsg = `📜 [缓存更新] 成功抓取到 ${data.count} 个章节`; break;
    case 'frame_reinjected': humanMsg = `🔁 [自动重注入] 检测到视频帧刷新，已重新注入进度监听器`; break;
    case 'video_stuck_refresh': humanMsg = `🔄 [自动刷新] 视频卡死超过 3 分钟，正在刷新页面 (第 ${data.refreshCount}/3 次)`; break;
    case 'video_frame_lost': humanMsg = `🚫 [帧丢失] 刷新后无法重新定位视频帧 (第 ${data.refreshCount}/3 次)`; break;
    case 'video_stuck_refresh_error': humanMsg = `🔥 [刷新失败] 第 ${data.refreshCount}/3 次刷新出错: ${data.message}`; break;
    case 'timeout_90': humanMsg = `⏱️ [彻底卡死] 视频 ${data.refreshCount > 0 ? `经过 ${data.refreshCount} 次自动刷新后仍` : ''}卡死无进度，中断当前章节`; break;
    case 'no_video': humanMsg = `🈳 [未找到视频] 当前页面不存在视频控件`; break;
    case 'target_closed': humanMsg = `💥 [连接丢失] 浏览器页面已被外部关闭`; break;
    case 'lock_denied': humanMsg = `🔒 [进程互斥] 无法启动: ${data.reason}`; break;
    case 'no_storage': humanMsg = `🔑 [等待登录] 凭证不存在或失效，请在弹出的浏览器中手动登录...`; break;
    case 'fatal':
    case 'uncaught_exception':
    case 'unhandled_rejection': humanMsg = `🔥 [致命错误] ${data.message}`; break;
    default: humanMsg = `[${event}] ${Object.keys(data).length ? JSON.stringify(data) : ''}`;
  }

  // 普通日志输出前，先清除进度条，再输出，然后再恢复进度条
  clearProgress();
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
  console.log(`[${formatTime(new Date())}] ${prefix} ${humanMsg}`);
  restoreProgress();
}

function info(event, data) { log('info', event, data); }
function warn(event, data) { log('warn', event, data); }
function error(event, data) { log('error', event, data); }

module.exports = { log, info, warn, error, LOG_FILE };
