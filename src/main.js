const fs = require('fs');
const { chromium } = require('playwright');
const logger = require('./lib/logger');
const lock = require('./lib/lock');

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
  const defaultCourseUrl = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=263837700&clazzid=147110605&cpi=517019981&enc=1c0c74b9a48543e4ae307613f2ebf9ad&t=1787037581265&pageHeader=1';
  const startUrl = process.argv[2] || defaultCourseUrl;
  const maxLessons = 20; // safety limit

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
  // 保存格式：[{ chapterId, url }, ...]，按页面侧边栏显示顺序排列
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
          // 确认元素可交互
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

  // ─── T3: 安全执行（处理 "Target page, context or browser has been closed"） ───
  async function safeEval(frameOrPage, fn, fallback = null) {
    try {
      return await frameOrPage.evaluate(fn);
    } catch (e) {
      if (e.message && e.message.includes('Target page, context or browser has been closed')) {
        logger.error('target_closed', { message: e.message });
        throw e; // 向上传播让全局 catch 处理
      }
      return fallback;
    }
  }

  // ─── T8: 用户行为模拟 ───
  async function simulateHumanBehavior(page) {
    try {
      // 随机鼠标移动
      const viewportSize = page.viewportSize() || { width: 1280, height: 720 };
      const x = 100 + Math.floor(Math.random() * (viewportSize.width - 200));
      const y = 100 + Math.floor(Math.random() * (viewportSize.height - 200));
      await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });

      // 随机短滚动
      const scrollY = -50 + Math.floor(Math.random() * 100);
      await page.mouse.wheel(0, scrollY);

      // 随机暂停再微移
      await page.waitForTimeout(500 + Math.floor(Math.random() * 1500));
      const x2 = x + Math.floor(Math.random() * 60) - 30;
      const y2 = y + Math.floor(Math.random() * 60) - 30;
      await page.mouse.move(x2, y2, { steps: 3 + Math.floor(Math.random() * 5) });
    } catch (e) { /* ignore — 行为模拟失败不影响主流程 */ }
  }

  // ─── T6: 章节列表解析 ───
  async function parseChapterList(page, currentUrl) {
    try {
      // 方法1：从侧边栏 DOM 解析并根据章节前缀序号 (如 1.1, 1.2) 严格排序
      const rawChapters = await safeEval(page, () => {
        // 提取侧边栏的章节列表 (支持 span onclick 和 a href)
        const nodes = Array.from(document.querySelectorAll('.posCatalog_name, a[href*="chapterId"]'));
        let parsed = [];
        
        for (const node of nodes) {
          const text = (node.innerText || node.textContent || '').trim();
          let chapterId = null;
          let href = node.href || '';
          
          if (node.tagName.toLowerCase() === 'a') {
            const m = href.match(/[?&]chapterId=(\d+)/);
            if (m) chapterId = m[1];
          } else if (node.hasAttribute('onclick')) {
            const oc = node.getAttribute('onclick');
            // getTeacherAjax('courseId','clazzid','chapterId')
            const m = oc.match(/getTeacherAjax\([^,]+,\s*[^,]+,\s*'(\d+)'/);
            if (m) chapterId = m[1];
            else {
              const m2 = oc.match(/changePan\('(\d+)'\)/);
              if (m2) chapterId = m2[1];
            }
          }
          
          if (!chapterId) continue;
          
          // 如果是 span，没有原生 href，从当前 URL 替换构造
          if (!href || href.includes('javascript:void')) {
            href = window.location.href.replace(/chapterId=\d+/, 'chapterId=' + chapterId);
          }
          
          let nums = [];
          const numMatch = text.match(/^(\d+(?:\.\d+)*)/);
          if (numMatch) {
            nums = numMatch[1].split('.').map(Number);
          }
          parsed.push({ chapterId, url: href, text, nums });
        }

        // 去重
        const seen = new Set();
        const unique = [];
        for (const item of parsed) {
          if (!seen.has(item.chapterId)) {
            seen.add(item.chapterId);
            unique.push(item);
          }
        }

        // 如果存在序号，则按照序号严格排序 (例如 1.1 -> 1.2 -> 2.1)
        const hasNumbering = unique.some(i => i.nums.length > 0);
        if (hasNumbering) {
          unique.sort((a, b) => {
            if (a.nums.length === 0 && b.nums.length > 0) return 1;
            if (b.nums.length === 0 && a.nums.length > 0) return -1;
            const len = Math.max(a.nums.length, b.nums.length);
            for (let i = 0; i < len; i++) {
              const valA = a.nums[i] || 0;
              const valB = b.nums[i] || 0;
              if (valA !== valB) return valA - valB;
            }
            return 0;
          });
        }
        return unique;
      }, []);

      if (rawChapters && rawChapters.length > 1) {
        // 更新缓存（章节数更多时才覆盖，避免页面局部渲染导致列表缩水）
        if (rawChapters.length >= chapterList.length) {
          chapterList = rawChapters;
          saveChapterList();
          logger.info('chapter_list_updated', { count: chapterList.length });
        }
        // 从列表中找当前章节的下一节
        const next = getNextChapterUrl(currentUrl);
        if (next) return next;
      }

      // 方法2：侧边栏活跃节点的下一个兄弟（快速回退）
      const sidebarNext = await safeEval(page, () => {
        const active = document.querySelector('.current_select, .active, .posCatalog_active, [class*="current"]');
        if (active) {
          let next = active.nextElementSibling;
          while (next) {
            const link = next.querySelector('a[href]');
            if (link && link.href) return link.href;
            next = next.nextElementSibling;
          }
        }
        return null;
      }, null);

      if (sidebarNext) return sidebarNext;
    } catch (e) {
      logger.warn('chapter_parse_error', { message: e.message });
    }
    return null;
  }

  // ─── 检查 storage.json ───
  const hasStoredSession = fs.existsSync(storagePath);

  // 登录态文件只是优化项：首次运行或登录态过期时，允许在打开的浏览器中手动登录。
  if (!hasStoredSession) {
    logger.warn('no_storage', { path: storagePath, action: 'manual_login_required' });
  }

  logger.info('start', { startUrl, pid: process.pid, maxLessons });

  // ─── T1: 主流程用 try/catch 包裹 ───
  try {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext(hasStoredSession ? { storageState: storagePath } : {});
    page = await context.newPage();

    // auto-accept JS dialogs and record them
    page.on('dialog', async dialog => {
      try {
        captured.push({ type: 'dialog', timestamp: Date.now(), dialogType: dialog.type(), message: dialog.message() });
        await dialog.accept();
      } catch (e) { }
    });

    // helper to override window.confirm/alert/prompt in all frames
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

    // Generic network capture for XHR/fetch/POST
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

    // (logger.info('start', ...) 已在上面记录)
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    let currentUrl = startUrl;

    if (process.env.TARGET_CHAPTER_NUM) {
      // 等待侧边栏加载，最多等 10 秒
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
            } else if (text.includes('[VIDEO_REACHED_90]') || text.includes('[VIDEO_REACHED_END]')) {
              captured.push({ type: 'videolog', timestamp: Date.now(), text });
            }
          }
        });

        // clear auto-click interval when navigation occurs
        page.on('framenavigated', async f => {
          try { await page.evaluate(() => { if (window._autoClickInterval) { clearInterval(window._autoClickInterval); window._autoClickInterval = null; } }); } catch (e) { }
        });

        // ─── 注入进度监听 ───
        // 录播课不可拖拽进度，但每次启动会从上次断点续播。
        // 若断点进度已 ≥90%，需在注入时立即检测，避免等待 timeupdate 触发超时。
        await safeEval(videoFrame, () => {
          try {
            const video = document.querySelector('video');
            if (!video) return;
            if (window._reached90 == null) window._reached90 = false;

            let lastLogTime = 0;
            const checkProgress = () => {
              if (window._reached90) return;
              const pct = video.duration ? (video.currentTime / video.duration) : 0;
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

            // ① 立即检查：视频已从断点恢复，可能进度已 ≥90%
            if (video.readyState >= 1 && video.duration) {
              checkProgress();
            }

            // ② loadedmetadata 兜底：元数据尚未就绪时，加载后再检查一次
            if (!window._reached90) {
              video.addEventListener('loadedmetadata', checkProgress, { once: true });
            }

            // ③ setInterval 主动轮询：防止视频被浏览器拦截自动播放（处于暂停状态）导致 timeupdate 不触发
            // 播放器通常会异步从服务器获取上次进度并 seek 到该位置，此时即使视频没播放，currentTime 也会更新。
            const progressInterval = setInterval(() => {
              if (window._reached90) {
                clearInterval(progressInterval);
                return;
              }
              checkProgress();
            }, 500);

            // ④ timeupdate 持续监听 (双保险)
            const handler = () => {
              if (window._reached90) { video.removeEventListener('timeupdate', handler); return; }
              checkProgress();
            };
            video.addEventListener('timeupdate', handler);

            // ⑤ 尝试继续播放（不可拖拽但可以 play）
            video.play().catch(() => {});
          } catch (e) { console.error(e); }
        });

        // ─── T8: 播放期间的行为模拟 ───
        const behaviorInterval = setInterval(async () => {
          try { await simulateHumanBehavior(page); } catch (e) { /* ignore */ }
        }, 15000 + Math.floor(Math.random() * 30000)); // 每 15-45s 做一次

        // 超时策略：不设总时长上限，只要视频在正常播放（currentTime 有变化）就一直等。
        // 若 5 分钟内 currentTime 完全没有任何变化，才判定为卡死并超时退出。
        const STUCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟进度不动才算超时
        const lessonStartTimestamp = Date.now();
        const reached90 = await (async () => {
          let lastCurrentTime = -1;
          let lastProgressTime = Date.now();

          while (true) {
            // Primary: check the flag directly in the video frame
            try {
              const state = await videoFrame.evaluate(() => ({
                reached: window._reached90,
                currentTime: document.querySelector('video')?.currentTime ?? -1,
              }));
              if (state.reached) return true;

              // 进度有变化，刷新"最后有进度时间"
              if (state.currentTime !== lastCurrentTime && state.currentTime >= 0) {
                lastCurrentTime = state.currentTime;
                lastProgressTime = Date.now();
              }
            } catch (e) { /* frame may have been detached */ }

            // Fallback: check captured console logs
            const idx = captured.findIndex(c => c.type === 'videolog' && c.timestamp > lessonStartTimestamp && c.text && c.text.includes('[VIDEO_REACHED_90]'));
            if (idx !== -1) return true;

            // 超时判断：仅在进度卡死（5分钟内毫无变化）时才退出
            if (Date.now() - lastProgressTime > STUCK_TIMEOUT_MS) return false;

            await page.waitForTimeout(1000);
          }
        })();

        clearInterval(behaviorInterval);

        if (!reached90) {
          logger.warn('timeout_90', { url: currentUrl, lessonIndex });
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