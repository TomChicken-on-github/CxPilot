const d = JSON.parse(require('fs').readFileSync('next_button_capture.json', 'utf8'));
const all = [...d.mainPage.elements, ...d.frames.flatMap(f => f.elements || [])];

console.log('=== Elements containing "下一" ===');
const next = all.filter(e => (e.text || '').includes('下一'));
next.forEach((e, i) => {
  console.log(`\n[${i}]`, {
    tag: e.tag, id: e.id,
    class: (e.className || '').substring(0, 100),
    text: (e.text || '').substring(0, 80),
    href: e.href, onclick: e.onclick,
    label: e.label
  });
  console.log('  outerHTML:', (e.outerHTML || '').substring(0, 300));
});

console.log('\n\n=== Chapter links (with chapterId) ===');
const ch = all.filter(e => e.type === 'chapterLink');
ch.forEach((e, i) => {
  console.log(`[${i}]`, { text: (e.text || '').substring(0, 60), href: e.href });
});

console.log('\n\n=== Matched selector elements ===');
const ms = all.filter(e => e.matchedSelector);
const selectors = [...new Set(ms.map(e => e.matchedSelector))];
selectors.forEach(s => {
  const els = ms.filter(e => e.matchedSelector === s);
  console.log(`\n${s}: ${els.length} elements`);
  els.slice(0, 3).forEach(e => {
    console.log('  ', { tag: e.tag, id: e.id, class: (e.className || '').substring(0, 80), text: (e.text || '').substring(0, 100) });
  });
});
