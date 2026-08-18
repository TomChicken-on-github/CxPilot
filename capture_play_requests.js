const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const storagePath = 'storage.json';
  const outCaptured = 'captured_requests.json';
  const courseUrl = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=263837700&clazzid=147110605&cpi=517019981&enc=1c0c74b9a48543e4ae307613f2ebf9ad&t=1787037581265&pageHeader=1';

  if (!fs.existsSync(storagePath)) {
    console.error('storage.json not found in working directory. Please ensure you saved storage.json from Playwright open.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: storagePath });
  const page = await context.newPage();

  const captured = [];

  // Capture XHR/fetch-like responses and POST requests
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
        try {
          body = await res.text();
        } catch (e) {
          body = '<unavailable binary or failed to read>';
        }
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

  console.log('Navigating to course page...');
  await page.goto(courseUrl, { waitUntil: 'networkidle' });

  // Try to locate an iframe containing a <video> element
  console.log('Searching for video frame...');
  let videoFrame = null;
  for (const frame of page.frames()) {
    try {
      const hasVideo = await frame.$('video');
      if (hasVideo) { videoFrame = frame; break; }
    } catch (e) { }
  }

  if (!videoFrame) {
    // Try to open a lesson by clicking first lesson link in the list
    console.log('No video iframe found yet — attempting to click first lesson link to open player...');
    try {
      // common selectors for lesson links
      const lessonSelectors = ['.chapter-list a', '.course-list a', 'a[class*="video"]', 'a[href*="viewVideo"]', 'a[href*="chapter"]', '.mulu a'];
      let clicked = false;
      for (const sel of lessonSelectors) {
        const el = await page.$(sel);
        if (el) { await el.click(); clicked = true; break; }
      }
      if (clicked) {
        await page.waitForTimeout(1500);
        for (const frame of page.frames()) {
          try { if (await frame.$('video')) { videoFrame = frame; break; } } catch (e) { }
        }
      }
    } catch (e) { console.error(e); }
  }

  if (videoFrame) {
    console.log('Video frame found. Attempting to start playback and monitor progress events for ~90s...');

    // Expose a function to receive progress from the page context via console logs
    page.on('console', msg => {
      // capture console messages from page for debugging
      const text = msg.text();
      if (text && text.includes('[VIDEO_PROGRESS]')) {
        captured.push({ type: 'videoprogress', timestamp: Date.now(), text });
      }
    });

    await videoFrame.evaluate(() => {
      try {
        const video = document.querySelector('video');
        if (!video) return;
        video.play().catch(e => console.warn('play failed', e));
        const handler = () => {
          const pct = video.currentTime / video.duration;
          // Log progress to console so the Node side can capture
          console.log(`[VIDEO_PROGRESS] current=${video.currentTime} duration=${video.duration} pct=${(pct*100).toFixed(2)}`);
          if (pct >= 0.98) {
            video.removeEventListener('timeupdate', handler);
            console.log('[VIDEO_PROGRESS] REACHED_NEAR_END');
          }
        };
        video.addEventListener('timeupdate', handler);
      } catch (e) { console.error(e); }
    });

    // Wait for either the near-end marker or a fixed timeout
    const waitMs = 300000; // 300s (5min) to allow manual opening and playback
    await page.waitForTimeout(waitMs);

  } else {
    console.warn('No video frame located. Capturing network activity on course page for 5 minutes — please in the opened browser click the lesson and start playback now.');
    await page.waitForTimeout(300000);
  }

  // Save captured results
  fs.writeFileSync(outCaptured, JSON.stringify(captured, null, 2));
  console.log(`Captured network activity saved to ${outCaptured}`);

  await browser.close();
  process.exit(0);
})();
