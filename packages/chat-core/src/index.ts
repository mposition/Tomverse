/**
 * `@tomverse/chat-core` -- the framework-neutral half of the chat product.
 *
 * Everything exported here has to hold on the Next.js server, in the browser,
 * and inside the Capacitor shell, so it may not import a framework, a server
 * module, or a native bridge (docs/policy/shared-packages.md). The
 * boundary is enforced two ways: ESLint `no-restricted-imports` for imports,
 * and this package's own `tsconfig.json` -- no `dom`, no `types` -- for
 * globals.
 *
 * Re-exports only. Each module keeps its own doc comment.
 */

export {
  LENGTH_RAW_FINISH_REASONS,
  isChatCompletionStatus,
  isLengthRawFinishReason,
  resolveChatCompletionOutcome,
  type ChatCompletionOutcome,
  type ChatCompletionStatus,
  type ChatIncompleteReason,
} from "./completionStatus";
