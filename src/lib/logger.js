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

/**
 * 写入一行 JSON Lines 日志
 * @param {'info'|'warn'|'error'} level
 * @param {string} event - 事件类型，如 start / stop / error / navigate / complete / skip / click / progress
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
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    // 日志写入失败不应导致主流程中断
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
    case 'progress_90': humanMsg = `🎉 [进度达标] 视频进度已 >= 90% (将等待 ${data.waitMs}ms 后跳章)`; break;
    case 'complete': humanMsg = `💾 [保存记录] 章节 ${data.chapterId} 已标记为完成`; break;
    case 'click_next_method': humanMsg = `🖱️ [触发跳章] 采用方案: ${data.method}`; break;
    case 'click_next': humanMsg = `🖱️ [点击下一节] 触发结果: ${data.clicked ? '成功' : '失败'}`; break;
    case 'navigate': humanMsg = `🧭 [导航跳转] 方式: ${data.source} ${data.chapterId ? `-> 章节 ${data.chapterId}` : ''}`; break;
    case 'skip': humanMsg = `⏭️ [跳过当前] 章节 ${data.chapterId} 此前已完成`; break;
    case 'skip_failed': humanMsg = `⚠️ [跳过失败] 无法找到章节 ${data.chapterId} 的下一节`; break;
    case 'no_next': humanMsg = `🏁 [播放结束] 未检测到下一节链接`; break;
    case 'no_navigation': humanMsg = `⏳ [跳转超时] 点击后未发生页面跳转`; break;
    case 'chapter_list_updated': humanMsg = `📜 [缓存更新] 成功抓取到 ${data.count} 个章节`; break;
    case 'timeout_90': humanMsg = `⏱️ [等待超时] 10分钟内未检测到 90% 进度，中断当前检测`; break;
    case 'no_video': humanMsg = `🈳 [未找到视频] 当前页面不存在视频控件`; break;
    case 'target_closed': humanMsg = `💥 [连接丢失] 浏览器页面已被外部关闭`; break;
    case 'lock_denied': humanMsg = `🔒 [进程互斥] 无法启动: ${data.reason}`; break;
    case 'no_storage': humanMsg = `🔑 [需要登录] 找不到 storage.json，将开启手动登录模式`; break;
    case 'fatal':
    case 'uncaught_exception':
    case 'unhandled_rejection': humanMsg = `🔥 [致命错误] ${data.message}`; break;
    default: humanMsg = `[${event}] ${Object.keys(data).length ? JSON.stringify(data) : ''}`;
  }

  // 根据 level 设置基础前缀颜色/图标 (Node终端不一定全彩，这里用Emoji区分)
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
  console.log(`${prefix} ${humanMsg}`);
}

function info(event, data) { log('info', event, data); }
function warn(event, data) { log('warn', event, data); }
function error(event, data) { log('error', event, data); }

module.exports = { log, info, warn, error, LOG_FILE };
