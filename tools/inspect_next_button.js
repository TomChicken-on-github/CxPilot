const fs = require('fs');
const { chromium } = require('playwright');

// 抓取页面中与"下一节"相关的所有元素信息
(async () => {
  const storagePath = 'storage.json';
  const baseUrl = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1172050672&courseId=263837700&clazzid=147110605&cpi=517019981&enc=ea013ef07b8a9ab710af1b3cda15f1d7&mooc2=1&hidetype=0&openc=44f38f1c8faa0693a9f9f0d2d1c3504b';
  const arg = process.argv[2];
  const startUrl = arg && /^\d+$/.test(arg) ? baseUrl.replace(/chapterId=\d+/, `chapterId=${arg}`) : (arg && arg.startsWith('http') ? arg : baseUrl);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: storagePath });
  const page = await context.newPage();

  console.log(`Opening: ${startUrl}`);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000); // 等页面完全加载

  const results = { mainPage: [], frames: [] };

  // 抓取主页面
  async function inspectFrame(frameOrPage, label) {
    try {
      const elements = await frameOrPage.evaluate(() => {
        const found = [];
        
        // 1. 搜索包含"下一"文字的所有元素
        const allEls = document.querySelectorAll('a, button, div, span, input, li');
        for (const el of allEls) {
          const text = (el.innerText || el.textContent || '').trim();
          if (text.includes('下一') || text.includes('next') || text.includes('Next')) {
            found.push({
              tag: el.tagName,
              id: el.id || null,
              className: el.className || null,
              text: text.substring(0, 100),
              href: el.href || null,
              onclick: el.getAttribute('onclick') || null,
              outerHTML: el.outerHTML.substring(0, 500),
              rect: el.getBoundingClientRect ? (() => {
                const r = el.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height };
              })() : null
            });
          }
        }

        // 2. 搜索章节导航相关元素
        const navSelectors = [
          '.chapter_item', '.catalogFolder', '.posCatalog_select',
          '.posCatalog_active', '.current_select', '.active',
          '[class*="next"]', '[class*="Next"]', '[id*="next"]',
          '[class*="chapter"]', '[class*="catalog"]',
          '.prev_next', '.prevnext', '.bottomList',
          '.ncells', '.cells'
        ];
        for (const sel of navSelectors) {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            for (const el of els) {
              found.push({
                matchedSelector: sel,
                tag: el.tagName,
                id: el.id || null,
                className: el.className || null,
                text: (el.innerText || el.textContent || '').trim().substring(0, 200),
                href: el.href || null,
                onclick: el.getAttribute('onclick') || null,
                childCount: el.children.length,
                outerHTML: el.outerHTML.substring(0, 500)
              });
            }
          }
        }

        // 3. 搜索含有 chapterId 的链接
        const chapterLinks = document.querySelectorAll('a[href*="chapterId"], a[href*="chapter"]');
        for (const el of chapterLinks) {
          found.push({
            type: 'chapterLink',
            tag: el.tagName,
            id: el.id || null,
            className: el.className || null,
            text: (el.innerText || '').trim().substring(0, 100),
            href: el.href,
            outerHTML: el.outerHTML.substring(0, 500)
          });
        }

        return found;
      });
      return { label, elements };
    } catch (e) {
      return { label, error: e.message, elements: [] };
    }
  }

  // 主页面
  results.mainPage = await inspectFrame(page, 'main_page');

  // 所有 iframe
  const frames = page.frames();
  console.log(`Found ${frames.length} frames total`);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const frameUrl = f.url();
    console.log(`  Frame ${i}: ${frameUrl.substring(0, 120)}`);
    const info = await inspectFrame(f, `frame_${i}_${frameUrl.substring(0, 80)}`);
    results.frames.push(info);
  }

  // 输出结果
  const outPath = 'next_button_capture.json';
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outPath}`);
  console.log(`Main page elements: ${results.mainPage.elements?.length || 0}`);
  for (const f of results.frames) {
    if (f.elements && f.elements.length > 0) {
      console.log(`${f.label}: ${f.elements.length} elements`);
    }
  }

  // 等用户看一眼再关
  await page.waitForTimeout(3000);
  await browser.close();
})();
