import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
const storage = 'tomverse-native-synthetic-demo';
const rows = [
  { id: 'travel', title: 'Travel plan', selectedModels: ['demo'], messages: [{ id: 'travel-question', role: 'user', content: 'Snorkeling near Brisbane' }] },
  { id: 'budget', title: 'Budget notes', selectedModels: ['demo'], shareEnabled: true, projectId: 'work', messages: [] },
  { id: 'comparison', title: 'Compare providers', selectedModels: ['demo', 'demo-b'], messages: [] },
  { id: 'private', title: 'Private notes', selectedModels: ['demo'], isLocked: true, messages: [{ id: 'private-question', role: 'user', content: 'Private snorkeling notes' }] },
  { id: 'long', title: 'A longer conversation title that wraps to two lines without expanding the entire conversation list', selectedModels: ['demo'], messages: [] },
];
test.beforeEach(async ({ page }) => {
  await page.route('https://tomverse.app/**', route => route.abort());
  await page.addInitScript(({ storage, rows }) => { if (!localStorage.getItem(storage)) { localStorage.setItem(storage, JSON.stringify(rows)); localStorage.setItem(storage + ':projects', JSON.stringify([{ id: 'work', name: 'Work' }])); } localStorage.setItem(storage + ':session', 'signed-in'); if (!localStorage.getItem('tomverse-language')) localStorage.setItem('tomverse-language', 'en'); localStorage.setItem('tomverse-theme', 'dark'); }, { storage, rows });
  await page.goto('/'); await page.getByRole('button', { name: 'Conversations', exact: true }).click();
});
async function menu(page: Page, title = 'Travel plan') { await page.getByRole('button', { name: `More actions: ${title}`, exact: true }).click(); }
async function close(page: Page) { await page.getByRole('dialog').last().getByRole('button', { name: 'Cancel', exact: true }).click(); }
async function filter(page: Page, label: string) { await page.getByRole('button', { name: 'Filter conversations', exact: true }).click(); await page.getByRole('dialog', { name: 'Filter conversations' }).getByRole('button', { name: label, exact: true }).click(); }

test('compact rows keep touch targets, truncate long titles and pin the account footer', async ({ page }, info) => {
  await expect(page.locator('.conversation-row')).toHaveCount(5);
  const first = await page.locator('.conversation-row').first().boundingBox(); expect(first!.height).toBeGreaterThanOrEqual(48); expect(first!.height).toBeLessThan(51);
  expect(await page.locator('.conversation-row').last().evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(72);
  expect(await page.locator('.history-more').first().evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
  expect((await page.locator('.conversation-row').allTextContents()).join('')).not.toContain('↗');
  await page.screenshot({ path: resolve(process.cwd(), '../../.tmp/native-parity/history-implemented-dark.png') });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 480 }); await expect(page.getByTestId('sidebar-account').getByRole('button', { name: 'Settings' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: info.outputPath('compact-short-screen.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => localStorage.setItem('tomverse-language','ko')); await page.reload(); await page.getByRole('button',{name:'대화',exact:true}).click();
  await page.screenshot({ path: resolve(process.cwd(), '../../.tmp/native-parity/history-implemented-korean.png') });
  await page.getByRole('button',{name:'추가 작업: Travel plan',exact:true}).click(); await page.screenshot({ path: resolve(process.cwd(), '../../.tmp/native-parity/history-menu-korean.png') });
});
test('search includes message contents, omits locked snippets, and combines with web filters', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: 'Search conversations' }); await search.fill('Snorkeling');
  await expect(page.locator('.conversation-row')).toHaveCount(1); await expect(page.locator('.history-snippet')).toContainText('Brisbane');
  await expect(page.locator('.history-snippet')).not.toContainText('Private'); await search.fill('');
  await filter(page, 'Shared'); await expect(page.locator('.conversation-row')).toHaveCount(1); await expect(page.locator('.conversation-row')).toContainText('Budget notes');
  await filter(page, 'Locked'); await expect(page.locator('.conversation-row')).toHaveCount(1); await expect(page.locator('.conversation-row')).toContainText('Private notes');
  await filter(page, 'Comparisons'); await expect(page.locator('.conversation-row')).toHaveCount(1); await expect(page.locator('.conversation-row')).toContainText('Compare providers');
  await filter(page, 'Local demo B'); await expect(page.locator('.conversation-row')).toHaveCount(1);
  await filter(page, 'Work'); await expect(page.locator('.conversation-row')).toContainText('Budget notes');
  await filter(page, 'All conversations'); await expect(page.locator('.conversation-row')).toHaveCount(5);
});
test('rename and pin persist; the full row still opens the conversation', async ({ page }) => {
  await menu(page); await page.getByRole('button', { name: 'Rename', exact: true }).click(); await page.getByLabel('Conversation title', { exact: true }).fill('Summer travel');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await menu(page, 'Summer travel'); await page.getByRole('button', { name: 'Pin conversation', exact: true }).click(); await expect(page.getByRole('button', { name: 'Unpin conversation' })).toBeVisible(); await close(page);
  await page.reload(); await page.getByRole('button', { name: 'Conversations', exact: true }).click(); await expect(page.locator('.conversation-row').first()).toContainText('Summer travel');
  await page.locator('.conversation-row').first().click(); await expect(page.locator('article.user')).toContainText('Snorkeling near Brisbane');
});
test('project creation, rename, move and removal reuse a single conversation', async ({ page }) => {
  await page.getByRole('button', { name: 'Filter conversations' }).click(); await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Project name').fill('Trips'); await page.getByRole('button', { name: 'Confirm', exact: true }).click(); await expect(page.getByRole('button', { name: 'Rename project: Trips' })).toBeVisible();
  await page.getByRole('button', { name: 'Rename project: Trips' }).click(); await page.getByLabel('Project name').fill('Holidays'); await page.getByRole('button', { name: 'Confirm', exact: true }).click(); await close(page);
  await menu(page); await page.getByRole('button', { name: 'Move to project', exact: true }).click(); await page.getByLabel('Projects', { exact: true }).selectOption({ label: 'Holidays' }); await page.getByRole('button', { name: 'Confirm' }).click();
  await filter(page, 'Holidays'); await expect(page.locator('.conversation-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Filter conversations' }).click(); await page.getByRole('button', { name: 'Delete project: Holidays' }).click(); await page.getByRole('button', { name: 'Confirm' }).click(); await close(page);
  await filter(page, 'All conversations'); await expect(page.locator('.conversation-row')).toHaveCount(5);
});
test('sharing and deletion wait for confirmation; TXT uses a real browser download', async ({ page }) => {
  await menu(page); await page.getByRole('button', { name: 'Share', exact: true }).click();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!)[0].shareEnabled, storage)).toBeUndefined();
  await page.getByRole('button', { name: 'Confirm' }).click(); await expect(page.getByLabel('Share link')).toHaveValue('https://tomverse.app/share/fixture-travel'); await close(page);
  await menu(page); await page.getByRole('button', { name: 'Revoke share link' }).click(); await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download TXT', exact: true }).click(); expect((await download).suggestedFilename()).toBe('Travel plan.txt');
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click(); expect(await page.locator('.conversation-row').count()).toBe(5);
  await page.getByRole('button', { name: 'Confirm' }).click(); await expect(page.locator('.conversation-row')).toHaveCount(4);
});
test('conversation password proof opens a protected chat and can remove its lock', async ({ page }) => {
  await menu(page); await page.getByRole('button', { name: 'Lock conversation', exact: true }).click(); const password = page.getByLabel('Password', { exact: true });
  await password.fill('short'); await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled(); await password.fill('fixture-password'); await page.getByRole('button', { name: 'Confirm' }).click();
  await page.locator('.conversation-row').filter({ hasText: 'Travel plan' }).click(); await page.getByLabel('Password', { exact: true }).fill('wrong'); await page.getByRole('button', { name: 'Confirm' }).click(); await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('fixture-password'); await page.getByRole('button', { name: 'Confirm' }).click(); await expect(page.locator('article.user')).toContainText('Snorkeling');
  await page.getByRole('button', { name: 'Conversations', exact: true }).click(); await menu(page); await page.getByRole('button', { name: 'Remove conversation lock', exact: true }).click(); await page.getByLabel('Current password').fill('fixture-password'); await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await filter(page, 'Locked'); await expect(page.locator('.conversation-row')).toHaveCount(1); await expect(page.locator('.conversation-row')).toContainText('Private notes');
});
test('a rollout-unavailable usage read never displays a fabricated zero and can recover', async ({ page }) => {
  await page.route('**/src/main.tsx', async route => { const response = await route.fetch(); const source = await response.text(); const injection = `const normalUsage=transport.usage;transport.usage=async()=>{if(!window.usageReady)throw {code:'NATIVE_USAGE_UNAVAILABLE'};return normalUsage();};`; await route.fulfill({ response, body: source.replace('createRoot(container).render(', injection + 'createRoot(container).render(') }); });
  await page.reload(); await page.getByRole('button', { name: 'Conversations', exact: true }).click(); const footer = page.getByTestId('sidebar-account');
  await expect(footer).toContainText('Usage is temporarily unavailable'); await expect(footer.getByRole('progressbar')).toHaveCount(0); await expect(footer).toContainText('Demo User');
  await page.evaluate(() => { (window as unknown as { usageReady: boolean }).usageReady = true; }); await footer.getByRole('button', { name: 'Retry usage' }).click(); await expect(footer).toContainText('25%');
});

test('a lost share response persists a read-before-change marker and never publishes twice automatically',async({page})=>{
  await page.route('**/src/main.tsx',async route=>{const response=await route.fetch();const source=await response.text();const injection=`const share=transport.history.share;transport.history.share=async id=>{localStorage.setItem('qa-share-count',String(Number(localStorage.getItem('qa-share-count')||0)+1));await share(id);throw new TypeError('Response lost');};`;await route.fulfill({response,body:source.replace('createRoot(container).render(',injection+'createRoot(container).render(')});});
  await page.reload();await page.getByRole('button',{name:'Conversations',exact:true}).click();await menu(page);await page.getByRole('button',{name:'Share',exact:true}).click();await page.getByRole('button',{name:'Confirm',exact:true}).click();await expect(page.getByRole('button',{name:'Check saved state'})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'Conversations',exact:true}).click();await menu(page);await expect(page.getByRole('button',{name:'Refresh share link'})).toBeDisabled();expect(await page.evaluate(()=>localStorage.getItem('qa-share-count'))).toBe('1');
  await page.getByRole('button',{name:'Check saved state'}).click();await expect(page.getByRole('button',{name:'Refresh share link'})).toBeEnabled();expect(await page.evaluate(()=>localStorage.getItem('qa-share-count'))).toBe('1');
});

test('Review reuses history controls and never treats multi-model images as comparison chats',async({page})=>{
  await page.evaluate(key=>{const existing=JSON.parse(localStorage.getItem(key)!);localStorage.setItem(key,JSON.stringify([...existing,{id:'review-c',title:'Review perspectives',surface:'workspace',kind:'chat',selectedModels:['demo','demo-b'],messages:[]},{id:'image-c',title:'Image alternatives',surface:'workspace',kind:'image',selectedModels:['image-a','image-b'],messages:[]}]));},storage);
  await page.getByTestId('product-switcher').selectOption('review');await page.getByRole('button',{name:'Conversations',exact:true}).click();await expect(page.locator('.conversation-row')).toHaveCount(2);
  await menu(page,'Image alternatives');await expect(page.getByRole('button',{name:'Share',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Download TXT',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Rename',exact:true})).toBeVisible();await close(page);
  await filter(page,'Comparisons');await expect(page.locator('.conversation-row')).toHaveCount(1);await expect(page.locator('.conversation-row')).toContainText('Review perspectives');
});

test('a WebView without clipboard support leaves the public link selectable',async({page})=>{
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true}));await menu(page);await page.getByRole('button',{name:'Share',exact:true}).click();await page.getByRole('button',{name:'Confirm',exact:true}).click();await page.getByRole('button',{name:'Copy link',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Press and hold the link');await expect(page.getByLabel('Share link')).toHaveValue('https://tomverse.app/share/fixture-travel');await expect(page.getByRole('button',{name:'Copied',exact:true})).toHaveCount(0);
});
