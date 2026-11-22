/**
 * Server Sentry integrations this app turns off.
 *
 * `VercelAI` subscribes to the AI SDK's `ai:telemetry` tracing channel and
 * taps each streamed model call by taking a reader on the call's `stream`.
 * With `ai` 7.0.165 and Sentry 11.12, that tap could lock the same OpenAI
 * stream that the SDK tried to pipe. Affected turns failed with
 * `ERR_INVALID_STATE` ("The ReadableStream is locked") and showed an empty answer.
 *
 * `dataCollection.genAI` disables capture of inputs and outputs, and production
 * does not sample model spans.
 */
export const SENTRY_SERVER_DISABLED_INTEGRATIONS: readonly string[] = ["VercelAI"];

export const withoutDisabledServerIntegrations = <T extends { name: string }>(
  defaults: T[]
): T[] =>
  defaults.filter(
    (integration) => !SENTRY_SERVER_DISABLED_INTEGRATIONS.includes(integration.name)
  );
