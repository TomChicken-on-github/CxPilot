/**
 * T2 — 进程锁模块
 * 使用 runner.lock 文件防止同账号并发运行。
 *
 * - acquire(): 尝试创建锁文件，若已存在则检查是否过期（>30min）
 * - release(): 删除锁文件
 * - 支持 process exit / SIGINT 时自动释放
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const LOCK_FILE = path.join(dataDir, 'runner.lock');
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

let _acquired = false;

/**
 * 尝试获取进程锁
 * @returns {{ ok: boolean, reason?: string }}
 */
function acquire() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      // 检查锁文件是否过期
      const content = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const age = Date.now() - (content.createdAt || 0);
      if (age < STALE_THRESHOLD_MS) {
        return {
          ok: false,
          reason: `Lock held by PID ${content.pid} since ${content.createdIso} (${Math.round(age / 1000)}s ago). ` +
                  `If the process is dead, delete runner.lock manually.`
        };
      }
      // 锁已过期，强制覆盖
      console.warn(`[LOCK] Stale lock detected (${Math.round(age / 1000)}s old). Overriding.`);
    }

    const lockData = {
      pid: process.pid,
      createdAt: Date.now(),
      createdIso: new Date().toISOString()
    };
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lockData, null, 2));
    _acquired = true;

    // 注册自动清理
    const cleanup = () => { release(); };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });

    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `Failed to acquire lock: ${e.message}` };
  }
}

/**
 * 释放进程锁
 */
function release() {
  if (!_acquired) return;
  try {
    if (fs.existsSync(LOCK_FILE)) {
      // 仅删除属于本进程的锁
      const content = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (content.pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch (e) {
    // 清理失败不阻塞退出
  }
  _acquired = false;
}

module.exports = { acquire, release, LOCK_FILE };
