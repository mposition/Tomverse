/**
 * What the readiness screen actually asserts.
 *
 * Deliberately narrow. This spike answers one question -- do the existing
 * shared packages run in a Vite browser bundle the way they run inside
 * Next.js -- and nothing about the product. There is no request, no token, no
 * session and no conversation here, because a shell that could authenticate
 * would be a second implementation of the boundary
 * docs/policy/tomverse-chat-mobile-authentication.md is still deciding.
 */
import {
  LENGTH_RAW_FINISH_REASONS,
  resolveChatCompletionOutcome,
} from "@tomverse/chat-core";

export type ReadinessCheck = {
  id: string;
  title: string;
  detail: string;
  passed: boolean;
};

/**
 * `chat-core` is TypeScript compiled by the consumer, with no build output and
 * no dependencies. Importing it proves resolution; calling it proves the
 * module evaluated to the same semantics the web app relies on.
 */
const chatCoreChecks = (): ReadinessCheck[] => {
  const finished = resolveChatCompletionOutcome({ finishReason: "stop" });
  const truncated = resolveChatCompletionOutcome({ rawFinishReason: "MAX_TOKENS" });

  return [
    {
      id: "chat-core-resolves",
      title: "@tomverse/chat-core resolves and evaluates",
      detail: `LENGTH_RAW_FINISH_REASONS carries ${LENGTH_RAW_FINISH_REASONS.size} entries`,
      passed: LENGTH_RAW_FINISH_REASONS.size > 0,
    },
    {
      id: "chat-core-normal",
      title: "A finished answer is reported as normal",
      detail: `finishReason "stop" -> status "${finished.status}"`,
      passed: finished.status === "normal",
    },
    {
      id: "chat-core-incomplete",
      title: "A truncated answer is reported as incomplete",
      detail: `rawFinishReason "MAX_TOKENS" -> status "${truncated.status}", reason "${truncated.incompleteReason ?? "-"}"`,
      passed:
        truncated.status === "incomplete" && truncated.incompleteReason === "length",
    },
  ];
};

/**
 * `ui-tokens` ships CSS, so "it built" is not the question -- a stylesheet that
 * compiled to nothing passes a file-exists check. Read the values back off the
 * document instead, the same way scripts/verify-package-build-matrix.mjs
 * checks the emitted CSS rather than its presence.
 */
const uiTokenChecks = (readToken: (name: string) => string): ReadinessCheck[] => {
  const background = readToken("--background");
  const accentMid = readToken("--tomverse-accent-mid");

  return [
    {
      id: "ui-tokens-loaded",
      title: "@tomverse/ui-tokens stylesheet carries its values",
      detail: `--background = "${background || "(empty)"}"`,
      passed: background.length > 0,
    },
    {
      id: "ui-tokens-accent",
      title: "Brand accent tokens resolve outside the Tailwind build",
      detail: `--tomverse-accent-mid = "${accentMid || "(empty)"}"`,
      passed: accentMid.length > 0,
    },
  ];
};

/**
 * Whether this bundle is running inside a Capacitor WebView, and on which
 * origin. The origin is the fact that matters: it is what an explicit CORS
 * allowlist would have to name, and today `lib/requestOrigin.ts` accepts
 * neither of the two Capacitor produces.
 */
const shellChecks = (origin: string, isNative: boolean): ReadinessCheck[] => [
  {
    id: "shell-origin",
    title: isNative ? "Running inside a Capacitor WebView" : "Running in a browser",
    detail: `origin = "${origin}"`,
    passed: true,
  },
  {
    id: "shell-local-bundle",
    title: "Assets are served from the local bundle",
    detail: isNative
      ? "capacitor.config.ts declares no server.url, so the WebView loads the copied webDir"
      : "Not a native shell; this is the Vite dev/preview server",
    passed: true,
  },
];

export const collectReadinessChecks = (input: {
  readToken: (name: string) => string;
  origin: string;
  isNative: boolean;
}): ReadinessCheck[] => [
  ...shellChecks(input.origin, input.isNative),
  ...chatCoreChecks(),
  ...uiTokenChecks(input.readToken),
];
