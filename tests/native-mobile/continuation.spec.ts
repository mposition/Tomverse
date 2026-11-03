import { selectProduct } from "./workspaceNavigation";
import { expect, test } from '@playwright/test';

/*
  A conversation continued from an imported chat, on the native app
  (owner request 2026-10-26; docs/policy/external-conversation-continuation.md §8.2).

  The native lists used to filter by surface "chat" / "workspace" only, so a
  continuation (surface "continuation") was in neither. It is now listed with
  its stored product, and opening it shows the imported original, read-only,
  above the divider -- never a bare chat without the half it continues.
*/
const storage = 'tomverse-native-synthetic-demo';
const importedPage = (offset: number, ids: string[]) => ({
  provider: 'chatgpt', importedAt: '2026-07-02T00:00:00.000Z', status: 'available', offset, pageSize: 2,
  messages: ids.map((id, index) => ({ id, role: index % 2 ? 'assistant' : 'user', content: `Imported ${id}`, sourceModelLabel: index % 2 ? 'gpt-4-turbo' : null })),
});
const rows = [
  { id: 'ordinary', title: 'Ordinary chat', surface: 'chat', kind: 'chat', selectedModels: ['demo'], messages: [] },
  {
    id: 'chat-continuation', title: 'Continued from an imported chat', sourceTitle: 'Imported trip plan', sourceState: 'available', surface: 'continuation', productKey: 'chat', kind: 'chat',
    selectedModels: ['demo'], selectionMode: 'auto', autoSelection: { offered: true }, messages: [],
    imported: importedPage(2, ['ext-2', 'ext-3']), importedPages: { '0': importedPage(0, ['ext-0', 'ext-1']) },
  },
  {
    id: 'review-continuation', title: 'Imported comparison', surface: 'continuation', productKey: 'review', kind: 'chat',
    selectedModels: ['demo', 'demo-b'], selectionMode: 'manual', messages: [],
    imported: importedPage(0, ['rev-0', 'rev-1']),
  },
  {
    id: 'deleted-continuation', title: 'Deleted original', surface: 'continuation', productKey: 'chat', kind: 'chat',
    selectedModels: ['demo'], messages: [{ id: 'native-q', role: 'user', content: 'A Tomverse question' }],
    imported: { provider: 'claude', importedAt: '2026-07-03T00:00:00.000Z', status: 'deleted', offset: 0, pageSize: 2, messages: [] },
  },
];

test.beforeEach(async ({ page }) => {
  await page.route('https://tomverse.app/**', route => route.abort());
  await page.addInitScript(({ storage, rows }) => {
    if (!localStorage.getItem(storage)) localStorage.setItem(storage, JSON.stringify(rows));
    localStorage.setItem(storage + ':session', 'signed-in');
    localStorage.setItem('tomverse-language', 'ko');
  }, { storage, rows });
  await page.goto('/');
});

test('a Chat continuation is listed with Chat and opens with its original above the divider', async ({ page }) => {
  await page.getByRole('button', { name: '대화', exact: true }).click();
  // Listed with Chat, and the Review one is not.
  await expect(page.locator('.conversation-row')).toHaveCount(3);
  await expect(page.locator('.conversation-row', { hasText: 'Imported trip plan' })).toBeVisible();
  await expect(page.locator('.conversation-row', { hasText: 'Imported comparison' })).toHaveCount(0);
  await expect(page.locator('.history-more[aria-label$="Imported trip plan"]')).toBeVisible();
  await page.getByPlaceholder('대화 검색').fill('Imported trip');
  await expect(page.locator('.conversation-row')).toHaveCount(1);
  await page.getByPlaceholder('대화 검색').fill('');

  await page.locator('.conversation-row', { hasText: 'Imported trip plan' }).click();
  await expect(page.getByTestId('continuation-provenance')).toContainText('ChatGPT에서 가져온 대화');
  await expect(page.getByTestId('continuation-provenance')).toContainText('읽기 전용');
  const imported = page.locator('[data-message-source="imported"]');
  await expect(imported).toHaveCount(2);
  await expect(imported.last()).toContainText('ChatGPT · gpt-4-turbo');
  // Read-only: no report action on an imported answer.
  await expect(imported.getByTestId('answer-report')).toHaveCount(0);
  await expect(page.getByRole('separator', { name: '여기부터 Tomverse에서 이어진 대화' })).toBeVisible();
  // Not a blank new chat.
  await expect(page.locator('.workspace-welcome-content')).toHaveCount(0);

  // Earlier imported messages load above, a page at a time.
  await page.getByTestId('imported-load-older').click();
  await expect(imported).toHaveCount(4);
  await expect(imported.first()).toContainText('Imported ext-0');
  await expect(page.getByTestId('imported-load-older')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole('button', { name: '대화', exact: true }).click();
  await expect(page.locator('.history-more[aria-label$="Imported trip plan"]')).toBeVisible();
  await page.locator('.conversation-row', { hasText: 'Imported trip plan' }).click();
  await expect(page.locator('[data-message-source="imported"]', { hasText: 'Imported ext-2' })).toBeVisible();
  await expect(page.getByTestId('continuation-divider')).toBeVisible();
  await expect(page.locator('.email-login')).toHaveCount(0);
});

test('a Review continuation is listed with Review and shows its original', async ({ page }) => {
  await selectProduct(page, "review");
  await page.getByRole('button', { name: '대화', exact: true }).click();
  await expect(page.locator('.conversation-row', { hasText: 'Imported comparison' })).toBeVisible();
  await expect(page.locator('.conversation-row', { hasText: 'Imported trip plan' })).toHaveCount(0);

  await page.locator('.conversation-row', { hasText: 'Imported comparison' }).click();
  await expect(page.getByTestId('review-landing')).toHaveCount(0);
  await expect(page.locator('[data-message-source="imported"]')).toHaveCount(2);
  await expect(page.getByTestId('continuation-divider')).toBeVisible();
});

test('a deleted original says so in place, and the Tomverse turns stay', async ({ page }) => {
  await page.getByRole('button', { name: '대화', exact: true }).click();
  await page.locator('.conversation-row', { hasText: 'Deleted original' }).click();
  await expect(page.getByTestId('continuation-source-tombstone')).toBeVisible();
  await expect(page.locator('[data-message-source="imported"]')).toHaveCount(0);
  await expect(page.getByTestId('continuation-divider')).toBeVisible();
  await expect(page.locator('.message.user', { hasText: 'A Tomverse question' })).toBeVisible();
});
