### Task 2: Add Stable UI Test Contracts

**Files:**
- Modify: `components/chat/DesktopChatShell.tsx`
- Modify: `components/chat/MobileChatShell.tsx`
- Modify: `components/chat/ChatInput.tsx`
- Modify: `components/chat/ChatMessageList.tsx`
- Modify: `components/chat/ChatSidebar.tsx`
- Create: `tests/e2e/ui-contracts.spec.ts`

**Interfaces:**
- Consumes: current shell, model, input, and message props.
- Produces: stable `data-testid`, `data-model-id`, and `data-message-role` selectors plus accessible model options, menu triggers, and lock-dialog names without changing visible UI.

- [ ] **Step 1: Write the failing selector-contract test**

```ts
import { expect, test } from "@playwright/test";

test("desktop exposes stable QA contracts", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/");
  await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await expect(page.getByTestId("chat-message-list")).toBeVisible();
});

test("mobile exposes stable QA contracts", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-input")).toBeVisible();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```powershell
npx playwright test tests/e2e/ui-contracts.spec.ts --project=desktop-chromium
```

Expected: FAIL because the test IDs do not exist.

- [ ] **Step 3: Add shell and model contracts**

In `DesktopChatShell.tsx`, add the shell ID and model ID:

```tsx
<main data-testid="desktop-chat-shell" className="...">
```

```tsx
<div key={modelId} data-testid="desktop-model-panel" data-model-id={modelId} className="...">
```

In `MobileChatShell.tsx`, add:

```tsx
<main data-testid="mobile-chat-shell" className="...">
```

```tsx
<button data-testid="mobile-model-tab" data-model-id={modelId} type="button" ...>
```

- [ ] **Step 4: Add input and message contracts**

In `ChatInput.tsx`, mark the existing input card and textarea:

```tsx
<div data-testid="chat-input" onDragEnter={handleDropZoneDragEnter} ...>
```

```tsx
<textarea
  data-testid="chat-textarea"
  aria-label={placeholderText}
  ref={textareaRef}
  ...
/>
```

Mark each model toggle button inside the selector:

```tsx
<button
  data-testid="model-option"
  data-model-id={model.id}
  type="button"
  disabled={unavailable}
  aria-pressed={isSelected}
  ...
>
```

In `ChatMessageList.tsx`, add:

```tsx
<div data-testid="chat-message-list" ref={containerRef} onScroll={handleScroll} ...>
```

In `ChatSidebar.tsx`, make each context-menu trigger uniquely accessible:

```tsx
<button
  data-testid="conversation-menu"
  data-conversation-id={conv.id}
  aria-label={`${t("chat.moreActions")}: ${conv.title}`}
  type="button"
  ...
>
```

Give the lock form a dialog name and connect the password label:

```tsx
<form
  role="dialog"
  aria-modal="true"
  aria-labelledby="conversation-lock-title"
  ...
>
  <h2 id="conversation-lock-title">{t("sidebar.lock")}</h2>
  <label htmlFor="conversation-lock-password">{t("sidebar.password")}</label>
  <input id="conversation-lock-password" type="password" ... />
</form>
```

```tsx
<div
  key={msg.id || idx}
  data-testid="chat-message"
  data-message-role={msg.role}
  data-model-id={msg.modelId || ""}
  className="..."
>
```

- [ ] **Step 5: Run both contract tests**

Run:

```powershell
npx playwright test tests/e2e/ui-contracts.spec.ts --project=desktop-chromium --project=mobile-safari
```

Expected: all contract tests pass in the applicable viewport.

- [ ] **Step 6: Commit**

```powershell
git add components/chat/DesktopChatShell.tsx components/chat/MobileChatShell.tsx components/chat/ChatInput.tsx components/chat/ChatMessageList.tsx components/chat/ChatSidebar.tsx tests/e2e/ui-contracts.spec.ts
git commit -m "test: expose stable chat UI contracts"
```

---

