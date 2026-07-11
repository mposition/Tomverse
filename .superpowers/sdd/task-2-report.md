# Task 2 Report: Stable UI Test Contracts

## Implementation Summary

Added stable Playwright-facing UI contracts across the desktop shell, mobile shell, chat input, message list, model selector, conversation menu trigger, and lock dialog. The changes are limited to `data-testid`, data attributes, and accessibility labels/relationships; no visible UI behavior was intentionally changed.

## Files Changed

- `tests/e2e/ui-contracts.spec.ts`: added desktop and mobile selector-contract tests.
- `components/chat/DesktopChatShell.tsx`: added `desktop-chat-shell` and `desktop-model-panel` contracts.
- `components/chat/MobileChatShell.tsx`: added `mobile-chat-shell` and `mobile-model-tab` contracts.
- `components/chat/ChatInput.tsx`: added `chat-input`, `chat-textarea`, and `model-option` contracts.
- `components/chat/ChatMessageList.tsx`: added `chat-message-list` and per-message role/model attributes.
- `components/chat/ChatSidebar.tsx`: added stable conversation menu attributes and named/labelled lock dialog fields.
- `lib/csp.ts` and `playwright.config.ts`: added a test-only CSP flag so WebKit can load local HTTP assets during E2E.

## Verification

- Confirmed the new UI contract test failed before adding selectors.
- `npm run build`: exit code `0`.
- `npx playwright test tests/e2e/smoke.spec.ts tests/e2e/ui-contracts.spec.ts`: exit code `0`, `12 passed`.
- External network guard check: exit code `0`, printed `QA_EXTERNAL_NETWORK_BLOCKED`.
- `npm run check`: exit code `0`.

## Notes

Git CLI is unavailable in this environment, so no commit was created. Task completion is based on changed-file review plus fresh command output.
