const { spawnSync } = require('child_process');
const fs = require('fs');
const logger = require('./lib/logger');

// run_loop.js
// Supervisor: single-run mode — runs capture_play_requests_entry.js once with progress resume.

const baseDefaultStart = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1172050670&courseId=263837700&clazzid=147110605&cpi=517019981&enc=ea013ef07b8a9ab710af1b3cda15f1d7&mooc2=1&hidetype=0&openc=44f38f1c8faa0693a9f9f0d2d1c3504b';

function readProgress() {
  try {
    if (fs.existsSync('progress.json')) {
      return JSON.parse(fs.readFileSync('progress.json', 'utf8')) || {};
    }
  } catch (e) {}
  return {};
}

function chooseStartUrl(arg) {
  const p = readProgress();
  if (p.nextLesson) return p.nextLesson;
  if (p.lastUrl) {
    // try to use lastUrl's next by incrementing? fallback to lastUrl
    return p.lastUrl;
  }
  // If arg is a plain numeric chapterId, substitute into baseDefaultStart
  if (arg && /^\d+$/.test(arg)) {
    try {
      return baseDefaultStart.replace(/chapterId=\d+/, `chapterId=${arg}`);
    } catch (e) { /* fallthrough */ }
  }
  // If arg looks like a URL, return it; otherwise return baseDefaultStart
  if (arg && arg.startsWith('http')) return arg;
  return baseDefaultStart;
}

logger.info('runner_start', { mode: 'single-run', pid: process.pid });
console.log('Runner (single-run mode) started. Auto-restart loop disabled to avoid spawning multiple browsers.');

// Single-run: choose start URL and run capture once, then exit.
const startUrl = chooseStartUrl(process.argv[2]);
logger.info('runner_launch', { startUrl });
console.log(`[${new Date().toISOString()}] Starting single capture run with URL: ${startUrl}`);

const res = spawnSync('node', ['capture_play_requests_entry.js', startUrl], {
  stdio: 'inherit',
  timeout: 30 * 60 * 1000
});

const exitCode = res.status || 0;
logger.info('runner_child_exit', { status: exitCode, signal: res.signal || null });
console.log(`Child exited with status ${exitCode}`);

// after child exits, attempt to read progress.json to decide next start (saved for manual restart)
const p = readProgress();
if (p.nextLesson) {
  try { fs.writeFileSync('progress.json', JSON.stringify({ lastUrl: p.nextLesson }, null, 2)); } catch (e) {}
}

logger.info('runner_stop', { exitCode });
console.log('Single-run complete. To run again, invoke this script manually.');
process.exit(exitCode);
