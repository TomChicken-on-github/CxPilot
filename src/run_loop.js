const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const config = require('./config');
const logger = require('./lib/logger');

const progressPath = path.join(process.cwd(), 'data', 'progress.json');

// ─── 拦截 Ctrl+C 信号 (防止 Ctrl+C 触发守护进程错误重启) ───
let userInterrupted = false;

process.on('SIGINT', () => {
  userInterrupted = true;
  console.log('\n🛑 [用户中断] 收到 Ctrl+C 信号，正在退出...');
  if (currentChild) {
    try { currentChild.kill('SIGKILL'); } catch (e) {}
  }
  process.exit(0);
});

function readProgress() {
  try {
    if (fs.existsSync(progressPath)) {
      return JSON.parse(fs.readFileSync(progressPath, 'utf8')) || {};
    }
  } catch (e) {}
  return {};
}

async function runInteractiveMenu() {
  const p = readProgress();
  const hasHistory = !!(p.nextLesson || p.lastUrl);

  console.log(`\n📚 欢迎使用 CxPilot - 自动化学习助手`);
  console.log(`====================================\n`);

  const choices = [];

  if (hasHistory) {
    choices.push({ title: '▶️ 继续上次的进度', value: 'resume' });
  }

  choices.push({ title: '🎯 指定目标章节开始 (例如: 1.2)', value: 'specific' });
  choices.push({ title: '🌐 从默认课程入口开始', value: 'default' });
  choices.push({ title: '❌ 退出', value: 'exit' });

  const response = await prompts({
    type: 'select',
    name: 'action',
    message: '请选择运行模式:',
    choices,
    initial: 0
  });

  if (!response.action || response.action === 'exit') {
    process.exit(0);
  }

  let startUrl = config.DEFAULT_COURSE_URL;
  let targetChapterNum = null;

  if (response.action === 'resume') {
    startUrl = p.nextLesson || p.lastUrl || config.DEFAULT_COURSE_URL;
  } else if (response.action === 'specific') {
    const chapRes = await prompts({
      type: 'text',
      name: 'chapter',
      message: '请输入章节号 (例如 1.2，留空返回):'
    });
    if (!chapRes.chapter) {
      return runInteractiveMenu(); // 重新开始
    }
    // Check if it's a raw chapter ID
    if (/^\d{5,}$/.test(chapRes.chapter)) {
      startUrl = config.DEFAULT_COURSE_URL.replace(/chapterId=\d+/, `chapterId=${chapRes.chapter}`);
    } else {
      targetChapterNum = chapRes.chapter;
      startUrl = config.DEFAULT_COURSE_URL;
    }
  }

  return { startUrl, targetChapterNum };
}

function runMainProcess(mainScript, startUrl, env) {
  return new Promise((resolve) => {
    currentChild = spawn('node', [mainScript, startUrl], {
      stdio: 'inherit',
      env
    });

    currentChild.on('exit', (code, signal) => {
      currentChild = null;
      resolve({ code, signal });
    });
  });
}

async function start() {
  // 如果是作为守护进程直接被重启拉起，跳过菜单
  let startUrl = config.DEFAULT_COURSE_URL;
  let targetChapterNum = null;

  if (process.env.AUTO_RESTART !== '1') {
    const result = await runInteractiveMenu();
    startUrl = result.startUrl;
    targetChapterNum = result.targetChapterNum;
  } else {
    // 读取上一次的记录继续
    const p = readProgress();
    startUrl = p.nextLesson || p.lastUrl || config.DEFAULT_COURSE_URL;
    console.log(`[守护进程] 自动恢复执行: ${startUrl}`);
  }

  logger.info('runner_start', { mode: config.DAEMON_MODE ? 'daemon' : 'single-run', pid: process.pid });

  const mainScript = path.join(__dirname, 'main.js');
  let retries = 0;

  while (true) {
    logger.info('runner_launch', { startUrl, targetChapterNum, retries });

    const env = { ...process.env, PLAY_START_URL: startUrl };
    if (targetChapterNum) env.TARGET_CHAPTER_NUM = targetChapterNum;

    // 使用异步 spawn 代替 spawnSync，让事件循环能处理 SIGINT
    const { code: exitCode, signal } = await runMainProcess(mainScript, startUrl, env);

    logger.info('runner_child_exit', { status: exitCode, signal: signal || null });

    // 尝试更新 progress 为下一次启动准备
    const p = readProgress();
    if (p.nextLesson) {
      try {
        if (!fs.existsSync(path.dirname(progressPath))) fs.mkdirSync(path.dirname(progressPath), { recursive: true });
        fs.writeFileSync(progressPath, JSON.stringify({ lastUrl: p.nextLesson }, null, 2));
        startUrl = p.nextLesson;
      } catch (e) {}
    } else if (p.lastUrl) {
      startUrl = p.lastUrl;
    }

    // 如果是用户手动 Ctrl+C (130 / SIGINT / userInterrupted)，直接退出，绝不触发守护进程重启
    if (userInterrupted || exitCode === 130 || signal === 'SIGINT') {
      logger.info('runner_stop', { message: 'User interrupted via SIGINT', exitCode });
      console.log('\n🛑 [用户中断] 已安全退出');
      process.exit(0);
    }

    // 退出码 0 代表正常跑完了 maxLessons 节课，正常结束
    if (exitCode === 0) {
      logger.info('runner_stop', { message: 'Normal completion', exitCode });
      process.exit(0);
    }

    // 守护进程重启逻辑
    if (config.DAEMON_MODE) {
      retries++;
      if (retries > config.MAX_RETRIES) {
        logger.error('runner_stop', { message: 'Max retries reached', retries });
        process.exit(exitCode !== null ? exitCode : 1);
      }
      console.log(`\n[守护进程] 子进程异常退出 (代码: ${exitCode})。5秒后自动重启 (重试 ${retries}/${config.MAX_RETRIES})...\n`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      process.env.AUTO_RESTART = '1';
      targetChapterNum = null; // 重启后不再指定特殊章节，顺着上一次的进度继续
    } else {
      logger.info('runner_stop', { message: 'Exiting', exitCode });
      process.exit(exitCode !== null ? exitCode : 1);
    }
  }
}

start().catch(e => {
  console.error(e);
  process.exit(1);
});
