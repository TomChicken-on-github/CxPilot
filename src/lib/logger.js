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
  // 同时输出到 console
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
  console.log(`${prefix} [${event}]`, JSON.stringify(data));
}

function info(event, data) { log('info', event, data); }
function warn(event, data) { log('warn', event, data); }
function error(event, data) { log('error', event, data); }

module.exports = { log, info, warn, error, LOG_FILE };
