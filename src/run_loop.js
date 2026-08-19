const { spawnSync } = require('child_process');
const fs = require('fs');
const logger = require('./lib/logger');
const path = require('path');

// run_loop.js
// Supervisor: single-run mode — runs main.js once with progress resume.

const baseDefaultStart = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1172050670&courseId=263837700&clazzid=147110605&cpi=517019981&enc=ea013ef07b8a9ab710af1b3cda15f1d7&mooc2=1&hidetype=0&openc=44f38f1c8faa0693a9f9f0d2d1c3504b';
const progressPath = path.join(process.cwd(), 'data', 'progress.json');

function readProgress() {
  try {
    if (fs.existsSync(progressPath)) {
      return JSON.parse(fs.readFileSync(progressPath, 'utf8')) || {};
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

// Single-run: choose start URL and run capture once, then exit.
const startUrl = chooseStartUrl(process.argv[2]);
logger.info('runner_launch', { startUrl });

const mainScript = path.join(__dirname, 'main.js');
const res = spawnSync('node', [mainScript, startUrl], {
  stdio: 'inherit',
  timeout: 30 * 60 * 1000
});

const exitCode = res.status || 0;
logger.info('runner_child_exit', { status: exitCode, signal: res.signal || null });

// after child exits, attempt to read progress.json to decide next start (saved for manual restart)
const p = readProgress();
if (p.nextLesson) {
  try { 
    if (!fs.existsSync(path.dirname(progressPath))) fs.mkdirSync(path.dirname(progressPath), { recursive: true });
    fs.writeFileSync(progressPath, JSON.stringify({ lastUrl: p.nextLesson }, null, 2)); 
  } catch (e) {}
}

logger.info('runner_stop', { exitCode });
process.exit(exitCode);
