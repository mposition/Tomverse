import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const source = await readFile(new URL('../crates/amux-dashboard/static/app.js', import.meta.url), 'utf8');
const section = (begin, end) => {
  const start = source.indexOf(begin);
  assert(start >= 0, `missing ${begin}`);
  const stop = source.indexOf(end, start);
  assert(stop > start, `missing ${end}`);
  return source.slice(start, stop);
};
const helpers = [
  section('function esc(s) {', '// How many viewport'),
  section('function _sanitizeHtml(html) {', '// Resolve a markdown'),
  section('function _htmlText(value) {', 'function highlightPrompts(html) {'),
  section('function _csvEsc(s) {', 'let _csvRows ='),
  section('function showBranchPopover(name, e) {', 'async function doCreateBranch(name) {'),
].join('\n');

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><div id="probe"></div>');
  const result = await page.evaluate(helpers => {
    (0, eval)(helpers);
    const probe = document.getElementById('probe');
    const payloads = [
      `a\\';window.__xss=1;//`,
      `a" onmouseover="window.__xss=1`,
      `a&#39;);window.__xss=1;//`,
      `line\nnext\\'`,
      `<img src=x onerror=window.__xss=1>`,
    ];
    const records = [];
    for (const payload of payloads) {
      window.__xss = 0;
      window.__capture = value => { window.__captured = value; };
      probe.innerHTML = `<button onclick="window.__capture('${escJs(payload)}')">Go</button>`;
      const button = probe.querySelector('button');
      button.click();
      records.push({ captured: window.__captured, payload, xss: window.__xss, attributes: button.attributes.length });
    }
    window.__xss = 0;
    probe.innerHTML = _sanitizeHtml('<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>');
    const fallback = { imageCount: probe.querySelectorAll('img,script').length, xss: window.__xss, text: probe.textContent };
    const csv = `a" onmouseover="window.__xss=1`;
    probe.innerHTML = `<span title="${_csvEsc(csv)}">Cell</span>`;
    const span = probe.querySelector('span');
    const branchName = `a\\';window.__xss=1;//" onmouseover="window.__xss=2`;
    window.__xss = 0;
    window.gitInfo = { [branchName]: { branch: 'main' } };
    window.sessions = [{ name: branchName, branch: 'none' }];
    window._isBranchMain = branch => branch === 'main';
    window._cssRect = () => ({ left: 0, bottom: 0 });
    window.doCreateBranch = value => { window.__capturedBranch = value; };
    showBranchPopover(branchName, { stopPropagation() {}, target: probe });
    const pop = document.querySelector('.branch-popover');
    const input = pop.querySelector('input');
    pop.querySelector('button.primary').click();
    const branch = { id: input.id, value: input.value, captured: window.__capturedBranch, xss: window.__xss, inputCount: pop.querySelectorAll('input').length };
    return { records, fallback, csv: { title: span.title, attributes: span.attributes.length }, text: _htmlText('<b>safe</b>&amp; text'), branch, branchName };
  }, helpers);
  for (const row of result.records) {
    assert.equal(row.captured, row.payload);
    assert.equal(row.xss, 0);
    assert.equal(row.attributes, 1);
  }
  assert.equal(result.fallback.imageCount, 0);
  assert.equal(result.fallback.xss, 0);
  assert.match(result.fallback.text, /<img src=x/);
  assert.deepEqual(result.csv, { title: `a" onmouseover="window.__xss=1`, attributes: 1 });
  assert.equal(result.text, 'safe& text');
  assert.deepEqual(result.branch, { id: 'bp-input-' + result.branchName, value: 'session/' + result.branchName, captured: result.branchName, xss: 0, inputCount: 1 });
  console.log('Dashboard HTML security regression passed');
} finally {
  await browser.close();
}
