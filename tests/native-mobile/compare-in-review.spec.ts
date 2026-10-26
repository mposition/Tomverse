import { expect, test } from '@playwright/test';

/*
  "Compare in Review" on a native Chat answer (owner request 2026-10-26).

  The Chat conversation stays as it is; the answer's question, with up to two
  earlier questions, opens as a new Review draft the user sends themselves
  (lib/chatReviewHandoff.ts) -- the same review:new draft the welcome starters
  hand to Review.
*/
const storage = 'tomverse-native-synthetic-demo';
const rows = [{
  id: 'trip', title: 'Tokyo trip', surface: 'chat', kind: 'chat', selectedModels: ['demo'], selectionMode: 'auto', autoSelection: { offered: true },
  messages: [
    { id: 'q1', role: 'user', content: '도쿄 3일 여행 계획 짜줘' },
    { id: 'a1', role: 'assistant', content: '1일차 ...', modelId: 'demo', status: 'normal' },
    { id: 'q2', role: 'user', content: '더 저렴하게' },
    { id: 'a2', role: 'assistant', content: '저렴한 계획 ...', modelId: 'demo', status: 'normal' },
    { id: 'q3', role: 'user', content: '실패한 질문' },
    { id: 'a3', role: 'assistant', content: '', modelId: 'demo', status: 'failed' },
  ],
}];

test.beforeEach(async ({ page }) => {
  await page.route('https://tomverse.app/**', route => route.abort());
  await page.addInitScript(({ storage, rows }) => {
    if (!localStorage.getItem(storage)) localStorage.setItem(storage, JSON.stringify(rows));
    localStorage.setItem(storage + ':session', 'signed-in');
    localStorage.setItem('tomverse-language', 'ko');
  }, { storage, rows });
  await page.goto('/');
  await page.getByRole('button', { name: '대화', exact: true }).click();
  await page.locator('.conversation-row', { hasText: 'Tokyo trip' }).click();
});

test('a Chat answer opens its question, with earlier questions, as a new Review draft', async ({ page }) => {
  const compare = page.getByTestId('chat-compare-in-review');
  // One per finished answer; the failed one has nothing to compare.
  await expect(compare).toHaveCount(2);
  await expect(compare.first()).toHaveAccessibleName('이 질문을 새 Review에서 여러 모델로 비교');
  await compare.last().click();

  await expect(page.getByTestId('product-switcher')).toHaveValue('review');
  await expect(page.locator('.review-workspace textarea')).toHaveValue('이전 질문:\n- 도쿄 3일 여행 계획 짜줘\n\n더 저렴하게');
  // A draft, not a sent comparison.
  await expect(page.getByTestId('review-landing')).toBeVisible();

  // The Chat conversation is unchanged.
  await page.getByTestId('product-switcher').selectOption('chat');
  await page.getByRole('button', { name: '대화', exact: true }).click();
  await page.locator('.conversation-row', { hasText: 'Tokyo trip' }).click();
  await expect(page.locator('.message.user')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the first answer opens Review with its question alone', async ({ page }) => {
  await page.getByTestId('chat-compare-in-review').first().click();
  await expect(page.locator('.review-workspace textarea')).toHaveValue('도쿄 3일 여행 계획 짜줘');
});
