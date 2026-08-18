/**
 * T7 — analyze_enc.js
 * 读取 captured_requests.json，筛选并分析与 /multimedia/log/ 相关的请求，
 * 提取 enc 字段与签名参数，输出格式化报告。
 *
 * 用法：node analyze_enc.js [captured_requests.json]
 */
const fs = require('fs');
const url = require('url');

const capturedFile = process.argv[2] || 'captured_requests.json';

if (!fs.existsSync(capturedFile)) {
  console.error(`File not found: ${capturedFile}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(capturedFile, 'utf8'));
if (!Array.isArray(data)) {
  console.error('Expected captured_requests.json to be a JSON array.');
  process.exit(1);
}

// 目标 URL 模式
const PATTERNS = [
  /\/mooc-ans\/multimedia\/log/i,
  /\/multimedia\/log/i,
  /\/ananas\/status/i,
  /\/ananas\/red/i,
  /enc=/i
];

function matchesAny(urlStr) {
  return PATTERNS.some(p => p.test(urlStr || ''));
}

// 从 URL 或 POST body 提取参数
function extractParams(entry) {
  const params = {};

  // URL query params
  if (entry.url) {
    try {
      const parsed = new URL(entry.url);
      for (const [k, v] of parsed.searchParams.entries()) {
        params[k] = v;
      }
    } catch (e) { /* ignore */ }
  }

  // POST body params (application/x-www-form-urlencoded)
  if (entry.postData) {
    try {
      const pairs = entry.postData.split('&');
      for (const pair of pairs) {
        const [k, ...vParts] = pair.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(vParts.join('='));
      }
    } catch (e) { /* ignore */ }
  }

  return params;
}

// 筛选匹配的条目
const requests = data.filter(e => e.type === 'request' && matchesAny(e.url));
const responses = data.filter(e => e.type === 'response' && matchesAny(e.url));

console.log('='.repeat(80));
console.log(`Analyzed: ${capturedFile}`);
console.log(`Total entries: ${data.length}`);
console.log(`Matching requests: ${requests.length}`);
console.log(`Matching responses: ${responses.length}`);
console.log('='.repeat(80));

// 输出请求详情
requests.forEach((req, i) => {
  const params = extractParams(req);
  console.log(`\n--- Request #${i + 1} ---`);
  console.log(`  Time:   ${new Date(req.timestamp).toISOString()}`);
  console.log(`  Method: ${req.method}`);
  console.log(`  URL:    ${req.url}`);
  if (Object.keys(params).length > 0) {
    console.log('  Params:');
    for (const [k, v] of Object.entries(params)) {
      const highlight = /enc|token|sign|key|secret|auth/i.test(k) ? ' ⬅️ SIGNATURE?' : '';
      console.log(`    ${k} = ${v}${highlight}`);
    }
  }
  if (req.postData) {
    console.log(`  PostData: ${req.postData.substring(0, 500)}`);
  }
});

// 输出响应摘要
responses.forEach((res, i) => {
  console.log(`\n--- Response #${i + 1} ---`);
  console.log(`  Time:   ${new Date(res.timestamp).toISOString()}`);
  console.log(`  Status: ${res.status}`);
  console.log(`  URL:    ${res.url}`);
  if (res.body) {
    const bodyPreview = String(res.body).substring(0, 300);
    console.log(`  Body:   ${bodyPreview}${res.body.length > 300 ? '...' : ''}`);
  }
});

// 汇总 enc 字段分析
console.log('\n' + '='.repeat(80));
console.log('ENC / Signature Field Summary');
console.log('='.repeat(80));

const encValues = new Map();
for (const req of requests) {
  const params = extractParams(req);
  for (const [k, v] of Object.entries(params)) {
    if (/enc|sign|token/i.test(k)) {
      if (!encValues.has(k)) encValues.set(k, []);
      encValues.get(k).push({ value: v, timestamp: req.timestamp, url: req.url });
    }
  }
}

if (encValues.size === 0) {
  console.log('  No enc/sign/token fields found in matched requests.');
} else {
  for (const [field, occurrences] of encValues.entries()) {
    console.log(`\n  Field: "${field}" — ${occurrences.length} occurrence(s)`);
    const unique = [...new Set(occurrences.map(o => o.value))];
    console.log(`  Unique values: ${unique.length}`);
    unique.forEach((v, j) => {
      console.log(`    [${j + 1}] ${v}  (length=${v.length})`);
    });
    if (unique.length > 1) {
      console.log('  ⚠️  Multiple distinct values — likely dynamically generated (per-request or per-session).');
    } else {
      console.log('  ℹ️  Single value — may be static per session. Check if it changes across sessions.');
    }
  }
}

console.log('\n' + '='.repeat(80));
console.log('Analysis complete.');
