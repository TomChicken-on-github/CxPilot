const fs = require('fs');
const { chromium } = require('playwright');
const logger = require('./lib/logger');
const lock = require('./lib/lock');
const config = require('./config');

// Usage:
//   node capture_play_requests_entry.js <start_playback_url>
// If no URL provided, falls back to course listing URL.

// ─── 初始化数据目录 ───
if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });
if (!fs.existsSync('logs')) fs.mkdirSync('logs', { recursive: true });

// ─── T2: 进程锁 ───
const lockResult = lock.acquire();
if (!lockResult.ok) {
  console.error(`[LOCK] Cannot start: ${lockResult.reason}`);
  logger.error('lock_denied', { reason: lockResult.reason });
  process.exit(2);
}

// ─── T1: 全局错误处理 ───
(async () => {
  const storagePath = 'data/storage.json';
  const outCaptured = 'data/captured_requests.json';
  const completedPath = 'data/completed_lessons.json';
  const progressPath = 'data/progress.json';
  const startUrl = process.argv[2] || config.DEFAULT_COURSE_URL;
  const maxLessons = config.MAX_LESSONS; // 从 config 引入

  let browser = null;
  let context = null;
  let page = null;
  const captured = [];

  // ─── Helper: 安全清理资源 ───
  async function cleanup(exitCode = 0) {
    logger.info('cleanup', { exitCode });
    saveCaptured();
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    lock.release();
    process.exit(exitCode);
  }

  // ─── 未捕获异常处理 ───
  process.on('uncaughtException', async (err) => {
    logger.error('uncaught_exception', { message: err.message, stack: err.stack });
    await cleanup(1);
  });
  process.on('unhandledRejection', async (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : '';
    logger.error('unhandled_rejection', { message: msg, stack });
    await cleanup(1);
  });

  // 拦截 SIGINT 并清理退出，退出码使用约定的 130，告知父进程这是用户中断而非崩溃
  process.on('SIGINT', async () => {
    await cleanup(130);
  });

  // ─── Helper: 提取 URL 参数 ───
  function extractParam(url, param) {
    if (!url) return null;
    const m = String(url).match(new RegExp(`[?&]${param}=([^&]+)`));
    return m ? m[1] : null;
  }

  function extractChapterId(url) { return extractParam(url, 'chapterId'); }
  function extractCourseId(url) { return extractParam(url, 'courseId') || extractParam(url, 'courseid'); }
  function extractClazzId(url) { return extractParam(url, 'clazzid'); }

  // ─── T5: 丰富 completed_lessons 条目 ───
  let completedLessons = [];
  try {
    if (fs.existsSync(completedPath)) {
      completedLessons = JSON.parse(fs.readFileSync(completedPath, 'utf8')) || [];
    }
  } catch (e) { /* ignore */ }

  function hasCompletedChapter(chId) {
    if (!chId) return false;
    return completedLessons.some(c => c && String(c.chapterId) === String(chId));
  }

  function saveCompletedLesson(url) {
    try {
      if (!url) return;
      const ch = extractChapterId(url);
      if (!ch) return;
      if (!hasCompletedChapter(ch)) {
        const entry = {
          chapterId: String(ch),
          courseId: extractCourseId(url) || null,
          clazzid: extractClazzId(url) || null,
          recordedAt: new Date().toISOString(),
          url
        };
        completedLessons.push(entry);
        fs.writeFileSync(completedPath, JSON.stringify(completedLessons, null, 2));
        logger.info('complete', { chapterId: ch, courseId: entry.courseId, clazzid: entry.clazzid });
      }
    } catch (e) { /* ignore */ }
  }

  // ─── T6+: 章节列表缓存（解决 chapterId 乱序问题）───
  const chapterListPath = 'data/chapter_list.json';
  let chapterList = [];
  try {
    if (fs.existsSync(chapterListPath)) {
      chapterList = JSON.parse(fs.readFileSync(chapterListPath, 'utf8')) || [];
    }
  } catch (e) { /* ignore */ }

  function saveChapterList() {
    try { fs.writeFileSync(chapterListPath, JSON.stringify(chapterList, null, 2)); } catch (e) { /* ignore */ }
  }

  // 从缓存中找到当前章节的下一节 URL（不依赖 ID 数值）
  function getNextChapterUrl(currentUrl) {
    if (!chapterList.length) return null;
    const curId = extractChapterId(currentUrl);
    const idx = chapterList.findIndex(c => String(c.chapterId) === String(curId));
    if (idx !== -1 && idx + 1 < chapterList.length) {
      logger.info('navigate', { source: 'chapter_list_cache', chapterId: chapterList[idx + 1].chapterId });
      return chapterList[idx + 1].url;
    }
    return null;
  }

  // ─── Helper: 保存抓包数据 ───
  function saveCaptured() {
    try { fs.writeFileSync(outCaptured, JSON.stringify(captured, null, 2)); } catch (e) { /* ignore */ }
  }

  // ─── Helper: 保存进度 ───
  function saveProgress(data) {
    try { fs.writeFileSync(progressPath, JSON.stringify(data, null, 2)); } catch (e) { /* ignore */ }
  }

  // ─── T3: 安全等待元素 ───
  async function safeWaitAndClick(frameOrPage, selectors, options = {}) {
    const { timeout = 5000, description = 'element' } = options;
    for (const selector of selectors) {
      try {
        const el = await frameOrPage.waitForSelector(selector, { timeout, state: 'visible' });
        if (el) {
          const box = await el.boundingBox();
          if (box) {
            await el.click();
            logger.info('click', { selector, description });
            return true;
          }
        }
      } catch (e) { /* try next selector */ }
    }
    return false;
  }

  // ─── T3: 安全查找元素（带重试） ───
  async function safeFind(frameOrPage, selector, retries = 3, intervalMs = 1000) {
    for (let i = 0; i < retries; i++) {
      try {
        const el = await frameOrPage.$(selector);
        if (el) return el;
      } catch (e) { /* retry */ }
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }
    return null;
  }

  // ─── T3: 安全执行 ───
  async function safeEval(frameOrPage, fn, fallback = null) {
    try {
      return await frameOrPage.evaluate(fn);
    } catch (e) {
      if (e.message && e.message.includes('Target page, context or browser has been closed')) {
        logger.error('target_closed', { message: e.message });
        throw e;
      }
      return fallback;
    }
  }

  // ─── T8: 用户行为模拟 ───
  async function simulateHumanBehavior(page) {
    try {
      const viewportSize = page.viewportSize() || { width: 1280, height: 720 };
      const x = 100 + Math.floor(Math.random() * (viewportSize.width - 200));
      const y = 100 + Math.floor(Math.random() * (viewportSize.height - 200));
      await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
      const scrollY = -50 + Math.floor(Math.random() * 100);
      await page.mouse.wheel(0, scrollY);
      await page.waitForTimeout(500 + Math.floor(Math.random() * 1500));
      const x2 = x + Math.floor(Math.random() * 60) - 30;
      const y2 = y + Math.floor(Math.random() * 60) - 30;
      await page.mouse.move(x2, y2, { steps: 3 });
    } catch (e) { /* ignore */ }
  }

  // ─── 新增：按前缀匹配侧边栏编号提取章节 ───
  async function parseChapterList(page, currentUrl) {
    try {
      const list = await safeEval(page, () => {
        const items = Array.from(document.querySelectorAll('.posCatalog_name'));
        return items.map(el => {
          let url = '';
          const onclick = el.getAttribute('onclick');
          if (onclick && onclick.includes('getTeacherAjax')) {
            const match = onclick.match(/getTeacherAjax\('([^']+)','([^']+)','([^']+)'\)/);
            if (match) url = `/mycourse/studentstudy?courseId=${match[1]}&clazzid=${match[2]}&chapterId=${match[3]}`;
          }
          if (!url && onclick && onclick.includes('changePan')) {
            const match = onclick.match(/changePan\('([^']+)'\)/);
            if (match) url = `?chapterId=${match[1]}`;
          }
          
          let title = (el.innerText || '').trim();
          let nums = [];
          const prefixMatch = title.match(/^([\d\.]+)/);
          if (prefixMatch) {
            nums = prefixMatch[1].split('.').filter(n => n.length > 0).map(Number);
          }
          
          return {
            title,
            nums,
            url,
            chapterId: url ? (url.match(/chapterId=([^&]+)/) || [])[1] : null
          };
        }).filter(item => item.chapterId);
      });

      if (list && list.length > 0) {
        if (list.length > chapterList.length) {
          chapterList = list;
          saveChapterList();
          logger.info('chapter_list_updated', { count: chapterList.length });
        }
        
        const curId = extractChapterId(currentUrl);
        const idx = list.findIndex(item => item.chapterId === curId);
        if (idx !== -1 && idx + 1 < list.length) {
          let nextPath = list[idx + 1].url;
          if (nextPath.startsWith('?')) {
            const urlObj = new URL(currentUrl, 'https://mooc1.chaoxing.com');
            const newChapterId = nextPath.match(/chapterId=([^&]+)/)[1];
            urlObj.searchParams.set('chapterId', newChapterId);
            return urlObj.toString();
          } else if (nextPath.startsWith('/')) {
            return `https://mooc1.chaoxing.com${nextPath}`;
          }
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // ─── 备用逻辑：找下一节 URL ───
  async function findNextLessonUrl(page, currentUrl) {
    try {
      const nextFromParse = await parseChapterList(page, currentUrl);
      if (nextFromParse) return nextFromParse;
      if (chapterList.length > 0) {
        const next = getNextChapterUrl(currentUrl);
        if (next) return next;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // ─── 检查 storage.json ───
  const hasStoredSession = fs.existsSync(storagePath);

  logger.info('start', { startUrl, pid: process.pid, maxLessons });

  // ─── T1: 主流程用 try/catch 包裹 ───
  try {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext(hasStoredSession ? { storageState: storagePath } : {});
    page = await context.newPage();

    if (!hasStoredSession) {
      logger.warn('no_storage', { path: storagePath, action: 'manual_login_required' });
    }

    page.on('dialog', async dialog => {
      try {
        captured.push({ type: 'dialog', timestamp: Date.now(), dialogType: dialog.type(), message: dialog.message() });
        await dialog.accept();
      } catch (e) { }
    });

    async function overrideConfirms() {
      try {
        await page.evaluate(() => {
          window.confirm = () => true;
          window.alert = () => {};
          window.prompt = () => null;
        });
      } catch (e) {}
      for (const frame of page.frames()) {
        try {
          await frame.evaluate(() => { window.confirm = () => true; window.alert = () => {}; window.prompt = () => null; });
        } catch (e) {}
      }
    }

    context.on('request', req => {
      try {
        const resourceType = req.resourceType();
        if (resourceType === 'xhr' || resourceType === 'fetch' || req.method() === 'POST') {
          captured.push({
            type: 'request',
            timestamp: Date.now(),
            url: req.url(),
            method: req.method(),
            headers: req.headers(),
            postData: req.postData() || null
          });
        }
      } catch (e) { }
    });

    context.on('response', async res => {
      try {
        const req = res.request();
        const resourceType = req.resourceType();
        if (resourceType === 'xhr' || resourceType === 'fetch' || req.method() === 'POST') {
          let body = null;
          try { body = await res.text(); } catch (e) { body = '<unavailable binary or failed to read>'; }
          captured.push({
            type: 'response',
            timestamp: Date.now(),
            url: req.url(),
            method: req.method(),
            status: res.status(),
            headers: res.headers(),
            body
          });
        }
      } catch (e) { }
    });

    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // ─── 检测并等待手动登录 ───
    if (page.url().includes('login') || page.url().includes('passport')) {
      logger.warn('no_storage', {});
      while (page.url().includes('login') || page.url().includes('passport')) {
        await page.waitForTimeout(2000);
      }
      await context.storageState({ path: storagePath }).catch(() => {});
      logger.info('complete', { message: 'Manual login detected and session saved.' });
    }

    let currentUrl = page.url();

    if (process.env.TARGET_CHAPTER_NUM) {
      try {
        await page.waitForSelector('.posCatalog_box, #courselist, .posCatalog_name, a[href*="chapterId"]', { timeout: 10000 });
      } catch (e) { /* ignore timeout */ }
      
      await parseChapterList(page, currentUrl);
      const targetStr = process.env.TARGET_CHAPTER_NUM;
      const target = chapterList.find(c => c.nums && c.nums.join('.') === targetStr);
      if (target && target.url !== currentUrl) {
        logger.info('navigate', { source: 'jump_to_target', targetStr, url: target.url });
        currentUrl = target.url;
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
      } else if (!target) {
        console.warn(`[TARGET_NOT_FOUND] Could not find chapter matching ${targetStr}. Available:`, chapterList.map(c => c.nums ? c.nums.join('.') : '?').join(', '));
      }
    }

    // ─── 主循环 ───
    let lessonIndex = 0;

    while (lessonIndex < maxLessons) {
      lessonIndex += 1;

      // T8: 周期性用户行为模拟
      await simulateHumanBehavior(page);

      // 如果该章节已完成则跳过
      try {
        const curChapter = extractChapterId(currentUrl);
        if (curChapter && hasCompletedChapter(curChapter)) {
          logger.info('skip', { chapterId: curChapter, url: currentUrl });

          try {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1000);

            // T6: 优先用章节列表解析找下一节
            const nextFromList = await parseChapterList(page, currentUrl);
            if (nextFromList) {
              currentUrl = nextFromList;
              logger.info('navigate', { source: 'chapter_list', url: currentUrl });
              await page.waitForTimeout(500);
              continue;
            }


            // 回退2: 点击侧边栏下一个章节
            try {
              const sidebarClicked = await page.evaluate(() => {
                const active = document.querySelector('.posCatalog_active');
                if (active) {
                  let next = active.nextElementSibling;
                  while (next) {
                    if (next.classList.contains('posCatalog_select') && !next.classList.contains('firstLayer')) {
                      next.click();
                      return true;
                    }
                    next = next.nextElementSibling;
                  }
                }
                return false;
              });
              if (sidebarClicked) {
                logger.info('navigate', { source: 'sidebar_skip', url: currentUrl });
                for (let w = 0; w < 30; w++) {
                  await page.waitForTimeout(1000);
                  if (page.url() !== currentUrl) break;
                }
                currentUrl = page.url();
                await page.waitForTimeout(500);
                continue;
              }
            } catch (e) { /* ignore */ }

            // 回退3：从章节列表缓存取下一节（不依赖 ID 数值，兼容乱序）
            const cachedNext = getNextChapterUrl(currentUrl);
            if (cachedNext) {
              logger.info('navigate', { source: 'chapter_list_cache_skip', url: cachedNext });
              currentUrl = cachedNext;
              await page.waitForTimeout(500);
              continue;
            }
            logger.warn('skip_failed', { chapterId: curChapter, reason: 'no_next_link' });
          } catch (e) { /* ignore and fall through to normal handling */ }
        }
      } catch (e) { /* ignore */ }

      logger.info('lesson_start', { lessonIndex, url: currentUrl });
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);

      // ─── T3: 等待 video 元素（带重试） ───
      let videoFrame = null;
      for (let i = 0; i < 30; i++) {
        // check main frame
        const mainVideo = await safeFind(page, 'video', 1, 0);
        if (mainVideo) { videoFrame = page.mainFrame(); break; }
        // check child frames
        for (const frame of page.frames()) {
          const frameVideo = await safeFind(frame, 'video', 1, 0);
          if (frameVideo) { videoFrame = frame; break; }
        }
        if (videoFrame) break;
        await page.waitForTimeout(1000);
      }

      if (!videoFrame) {
        logger.warn('no_video', { url: currentUrl });
        console.warn('No video element found on this page. Capturing network for 30s and then trying to find a next-button.');
        await page.waitForTimeout(30000);
        saveCaptured();
      } else {
        logger.info('video_found', { url: currentUrl, lessonIndex });

        // ensure confirm/alert/prompt are overridden in page and frames
        await overrideConfirms();

        // set up periodic DOM modal auto-clicker
        try {
          await page.evaluate(() => {
            if (window._autoClickInterval) return;
            window._autoClickInterval = setInterval(() => {
              try {
                const texts = ['确定', '是', '继续', '确认', '跳过', '下一节', '我知道了'];
                const els = Array.from(document.querySelectorAll('button,a,div'));
                for (const el of els) {
                  const t = (el.innerText || '').trim();
                  if (!t) continue;
                  for (const tt of texts) {
                    if (t.includes(tt)) { try { el.click(); console.log('[AUTO_CLICK_CONFIRM] clicked: ' + t); return; } catch (e) { } }
                  }
                }
              } catch (e) { }
            }, 1500);
          });
        } catch (e) { }

        // Listen to console logs for progress messages
        page.on('console', msg => {
          const text = msg.text();
          if (text) {
            if (text.includes('[VIDEO_PROGRESS]')) {
              captured.push({ type: 'videolog', timestamp: Date.now(), text });
              const m = text.match(/pct=([\d.]+)/);
              if (m) {
                logger.info('video_progress', { pct: m[1], lessonIndex });
              }
            } else if (text.includes('[VIDEO_START]')) {
              const m = text.match(/pct=([\d.]+)/);
              if (m) logger.info('video_start', { pct: m[1] });
            } else if (text.includes('[VIDEO_REACHED_90]') || text.includes('[VIDEO_REACHED_END]')) {
              captured.push({ type: 'videolog', timestamp: Date.now(), text });
            }
          }
        });

        // ─── 进度监听注入（可复用，刷新后重新调用）───
        const injectProgressListener = async (frame) => {
          await safeEval(frame, () => {
            try {
              const video = document.querySelector('video');
              if (!video) return;
              window._reached90 = false;

              let lastLogTime = 0;
              let hasLoggedStart = false;
              const checkProgress = () => {
                if (window._reached90) return;
                const pct = video.duration ? (video.currentTime / video.duration) : 0;
                
                if (!hasLoggedStart && video.duration) {
                  hasLoggedStart = true;
                  console.log(`[VIDEO_START] pct=${(pct * 100).toFixed(2)}`);
                }

                const now = Date.now();
                if (now - lastLogTime > 5000) {
                  console.log(`[VIDEO_PROGRESS] current=${video.currentTime} duration=${video.duration} pct=${(pct * 100).toFixed(2)}`);
                  lastLogTime = now;
                }
                if (pct >= 0.90) {
                  window._reached90 = true;
                  console.log('[VIDEO_REACHED_90]');
                }
              };

              if (video.readyState >= 1 && video.duration) checkProgress();
              if (!window._reached90) video.addEventListener('loadedmetadata', checkProgress, { once: true });
              const progressInterval = setInterval(() => {
                if (window._reached90) { clearInterval(progressInterval); return; }
                checkProgress();
              }, 500);
              const handler = () => {
                if (window._reached90) { video.removeEventListener('timeupdate', handler); return; }
                checkProgress();
              };
              video.addEventListener('timeupdate', handler);
              // ⑤ 自动播放：无论 readyState 如何，立即调用 play() 触发视频加载和播放。
              // play() 本身会启动数据加载；若被浏览器拒绝（autoplay policy），
              // 则等待 canplay 事件（数据已缓冲足够时）再重试一次。
              const tryPlay = () => video.play().catch(() => {});
              tryPlay();
              if (video.readyState < 3) {
                video.addEventListener('canplay', tryPlay, { once: true });
              }
            } catch (e) { console.error(e); }
          });
        };

        // ─── 自动重新注入：监听 iframe 刷新 / 用户手动刷新 / 视频页重建 ───
        // 当任何非主框架发生跳转且该框架含有 video 元素时，自动更新 videoFrame 并重新注入监听器。
        // 这同时覆盖了：用户手动刷新、stuck-refresh 触发的 page.reload()、视频 iframe 异步重建等场景。
        page.on('framenavigated', async (frame) => {
          // 清理主框架上的自动点击定时器
          try { await page.evaluate(() => { if (window._autoClickInterval) { clearInterval(window._autoClickInterval); window._autoClickInterval = null; } }); } catch (e) { }

          // 只关心非主框架（避免在章节跳转时误触发）
          if (frame === page.mainFrame()) return;

          // 等待帧内容稳定（视频播放器异步挂载）
          await page.waitForTimeout(800).catch(() => {});

          try {
            const hasVideo = await frame.evaluate(() => !!document.querySelector('video'));
            if (!hasVideo) return;

            videoFrame = frame;
            logger.info('frame_reinjected', { lessonIndex, url: currentUrl });
            await injectProgressListener(frame);
          } catch (e) { /* frame may have been destroyed right after navigating */ }
        });

        // 首次注入
        await injectProgressListener(videoFrame);

        // ─── T8: 播放期间的行为模拟 ───
        const behaviorInterval = setInterval(async () => {
          try { await simulateHumanBehavior(page); } catch (e) { /* ignore */ }
        }, 15000 + Math.floor(Math.random() * 30000)); // 每 15-45s 做一次

        // ─── 超时策略 ───
        // 正常：只要 currentTime 在动，不论课程多长都不超时。
        // 卡死：3 分钟内 currentTime 没有变化 → 自动刷新页面（最多 3 次）。
        // 刷新后：framenavigated 事件自动重新注入监听器；等 8s 宽限期后再 30s 快速判定。
        // 三次刷新均失败 → 中断退出。
        const STUCK_TIMEOUT_MS    = 3 * 60 * 1000; // 卡死判定：3 分钟
        const REFRESH_TIMEOUT_MS  = 30 * 1000;      // 刷新后快速判定：30 秒
        const MAX_REFRESH_RETRIES = 3;              // 最多自动刷新次数
        const lessonStartTimestamp = Date.now();

        /**
         * 等待视频进度达到 90%，或检测到卡死后返回 'stuck'。
         * 通过 getter 函数动态读取最新的 videoFrame，自动感知 framenavigated 后的帧替换。
         * @param {()=>Frame} getFrame   返回当前 videoFrame 的 getter
         * @param {number} stuckLimitMs  多久没有进度变化算卡死
         * @param {number} gracePeriodMs 初始缓冲期（视频加载中时不纳入卡死计算）
         */
        const waitFor90 = async (getFrame, stuckLimitMs, gracePeriodMs = 0) => {
          let lastCurrentTime = -1;
          let lastProgressTime = Date.now() + gracePeriodMs;

          while (true) {
            const frame = getFrame();
            if (frame) {
              try {
                const state = await frame.evaluate(() => ({
                  reached:     window._reached90,
                  currentTime: document.querySelector('video')?.currentTime ?? -1,
                }));
                if (state.reached) return 'done';

                if (state.currentTime !== lastCurrentTime && state.currentTime >= 0) {
                  lastCurrentTime  = state.currentTime;
                  lastProgressTime = Date.now();
                }
              } catch (e) { /* frame detached — framenavigated handler will update videoFrame */ }
            }

            // Fallback: check captured console logs
            const idx = captured.findIndex(c =>
              c.type === 'videolog' &&
              c.timestamp > lessonStartTimestamp &&
              c.text?.includes('[VIDEO_REACHED_90]')
            );
            if (idx !== -1) return 'done';

            if (Date.now() - lastProgressTime > stuckLimitMs) return 'stuck';

            await page.waitForTimeout(1000);
          }
        };

        let reached90 = false;
        let refreshCount = 0;

        // 初次等待（卡死限制：3 分钟，无宽限期）
        let waitResult = await waitFor90(() => videoFrame, STUCK_TIMEOUT_MS);

        while (waitResult === 'stuck' && refreshCount < MAX_REFRESH_RETRIES) {
          refreshCount++;
          logger.warn('video_stuck_refresh', { lessonIndex, refreshCount, url: currentUrl });
          try {
            // 重置 videoFrame，让 framenavigated 处理器在刷新后重新赋值并注入监听器
            videoFrame = null;
            await page.reload({ waitUntil: 'domcontentloaded' });

            // 等待 framenavigated 处理器完成帧定位与监听器注入（最多 12s）
            let waited = 0;
            while (!videoFrame && waited < 12000) {
              await page.waitForTimeout(500);
              waited += 500;
            }

            if (!videoFrame) {
              logger.warn('video_frame_lost', { lessonIndex, refreshCount });
              break;
            }

            // 刷新后 8s 宽限期（视频从服务器恢复上次进度需要时间），再开始 30s 卡死计时
            waitResult = await waitFor90(() => videoFrame, REFRESH_TIMEOUT_MS, 8000);
          } catch (e) {
            logger.warn('video_stuck_refresh_error', { lessonIndex, refreshCount, message: e.message });
            break;
          }
        }

        if (waitResult === 'done') reached90 = true;

        clearInterval(behaviorInterval);

        if (!reached90) {
          logger.warn('timeout_90', { url: currentUrl, lessonIndex, refreshCount });
          saveCaptured();
          break;
        }

        // 达到 90%，记录并尝试跳到下一节
        try { saveCompletedLesson(currentUrl); } catch (e) { }
        const randMs = 1000 + Math.floor(Math.random() * 2000);
        logger.info('progress_90', { lessonIndex, url: currentUrl, waitMs: randMs });
        await page.waitForTimeout(randMs);

        // ─── T3: 点击"下一节" ───
        let clicked = false;

        // 方法1 (优先): 直接点击播放器下方的"下一节"按钮 (处理 display:none)
        if (!clicked) {
          try {
            clicked = await page.evaluate(() => {
              const el = document.querySelector('.nextChapter, #prevNextFocusNext, .prev_next.next');
              if (el) {
                el.style.display = '';
                el.click();
                return true;
              }
              return false;
            });
            if (clicked) logger.info('click_next_method', { method: 'bottom_next_button', lessonIndex });
          } catch (e) { /* ignore */ }
        }

        // 方法2 (回退): 按照右侧目录栏的顺序 (通过在 fallback 中执行 parseChapterList 来处理)

        // 方法3 (再回退): 通过侧边栏章节目录点击下一节
        if (!clicked) {
          try {
            clicked = await page.evaluate(() => {
              const active = document.querySelector('.posCatalog_active');
              if (active) {
                let next = active.nextElementSibling;
                while (next) {
                  if (next.classList.contains('posCatalog_select') && !next.classList.contains('firstLayer')) {
                    next.click();
                    return true;
                  }
                  next = next.nextElementSibling;
                }
              }
              return false;
            });
            if (clicked) logger.info('click_next_method', { method: 'sidebar_click', lessonIndex });
          } catch (e) { /* ignore */ }
        }

        logger.info('click_next', { clicked, lessonIndex });

        // Wait up to 60s for navigation after click
        let navigated = false;
        const navStart = Date.now();
        while (Date.now() - navStart < 60 * 1000) {
          await page.waitForTimeout(1000);
          saveCaptured();
          if (page.url() !== currentUrl) { navigated = true; break; }
        }

        if (!navigated) {
          logger.warn('no_navigation', { url: currentUrl, lessonIndex });

          // ─── T6: 尝试章节列表解析 ───
          const nextFromList = await parseChapterList(page, currentUrl);
          if (nextFromList) {
            logger.info('navigate', { source: 'chapter_list_fallback', url: nextFromList });
            currentUrl = nextFromList;
            saveProgress({ lastUrl: currentUrl });
            saveCaptured();
            await page.waitForTimeout(1000);
            continue;
          }

          saveCaptured();
          break;
        }
      }

      // 如果导航成功，更新 currentUrl 并继续
      const newUrl = page.url();
      if (newUrl && newUrl !== currentUrl) {
        logger.info('navigate', { source: 'page_navigation', url: newUrl, lessonIndex });
        currentUrl = newUrl;
        saveProgress({ lastUrl: newUrl });
        saveCaptured();
        await page.waitForTimeout(1500);
        continue;
      }

      // ─── T6: 用章节列表解析找下一节 ───
      const nextFromList = await parseChapterList(page, currentUrl);
      if (nextFromList) {
        currentUrl = nextFromList;
        logger.info('navigate', { source: 'chapter_list', url: currentUrl });
        saveProgress({ nextLesson: currentUrl });
        saveCaptured();
        await page.waitForTimeout(1000);
        continue;
      }

      // 回退到 DOM 中查找"下一节"
      const maybeNext = await safeEval(page, () => {
        const el = Array.from(document.querySelectorAll('a,button')).find(x => (x.innerText || '').includes('下一节'));
        return el ? el.href || null : null;
      });
      if (maybeNext) {
        currentUrl = maybeNext;
        logger.info('navigate', { source: 'dom_next_link', url: currentUrl });
        saveProgress({ nextLesson: currentUrl });
        saveCaptured();
        await page.waitForTimeout(1000);
        continue;
      }

      logger.info('no_next', { lessonIndex, url: currentUrl });
      break;
    }

    // Final save
    saveCaptured();
    logger.info('stop', { lessonsProcessed: lessonIndex, finalUrl: currentUrl });
    await browser.close();
    browser = null;
    lock.release();
    process.exit(0);

  } catch (err) {
    // ─── T1: 全局错误捕获 ───
    const isTargetClosed = err.message && err.message.includes('Target page, context or browser has been closed');
    logger.error('fatal', {
      message: err.message,
      stack: err.stack,
      isTargetClosed
    });
    saveCaptured();
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    lock.release();
    process.exit(isTargetClosed ? 3 : 1);
  }
})();