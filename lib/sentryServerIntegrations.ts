/**
 * Server Sentry integrations this app turns off.
 *
 * `VercelAI` subscribes to the AI SDK's `ai:telemetry` tracing channel and
 * taps each streamed model call by taking a reader on the call's `stream`.
 * From `ai` 7.0.165 the SDK publishes a redacted copy of an OpenAI call's
 * result to that channel and then pipes the original stream itself, so the
 * tap locks the stream the SDK still needs: every streamed OpenAI turn failed
 * with `ERR_INVALID_STATE` ("The ReadableStream is locked") and reached the
 * user as an empty answer. Anthropic results are not copied, which is why
 * only GPT models broke.
 *
 * Nothing is lost by turning it off: `dataCollection.genAI` already records
 * neither inputs nor outputs, and model spans are not sampled in production.
 */
export const SENTRY_SERVER_DISABLED_INTEGRATIONS: readonly string[] = ["VercelAI"];

export const withoutDisabledServerIntegrations = <T extends { name: string }>(
  defaults: T[]
): T[] =>
  defaults.filter(
    (integration) => !SENTRY_SERVER_DISABLED_INTEGRATIONS.includes(integration.name)
  );
