import { z } from "zod";
import { cliProvider, codeExecutionMode, type CliProvider, type CodeExecutionMode } from "./code-execution";

const identifier = z.string().min(1).max(160).regex(/^[\w.:/@-]+$/);
const model = identifier.nullable();
const creditCap = z.int().positive().nullable();
export const codeTransferScope = z.enum(["summary", "summary_and_changes"]);
export const codeContinuation = z.object({
  segmentId: z.uuid(), model: identifier, maximumKeyCreditCap: z.int().positive(), transfer: codeTransferScope,
}).strict();
export type CodeContinuation = z.infer<typeof codeContinuation>;
export const codeCliContinuation = z.object({
  segmentId: z.uuid(), requestId: z.string().regex(/^req_[0-9a-f]{32}$/),
  provider: z.literal("openai"), model: identifier, version: z.string().min(1).max(48), transfer: codeTransferScope,
}).strict();
export type CodeCliContinuation = z.infer<typeof codeCliContinuation>;
const destination = z.discriminatedUnion("executionMode", [
  z.object({ executionMode: z.literal("tomverse_api"), model }).strict(),
  z.object({ executionMode: z.literal("provider_cli"), provider: cliProvider, model,
    version: z.string().min(1).max(48).nullable() }).strict().refine((value) => (value.model === null) === (value.version === null)),
]);
export const codeFallbackSettings = z.object({
  version: z.literal(1),
  destination: destination.nullable(),
  apiCreditCap: creditCap,
  transfer: codeTransferScope,
  automaticFrom: codeExecutionMode.nullable(),
}).strict().refine((settings) => !settings.automaticFrom ||
  Boolean(settings.destination?.model && settings.destination.executionMode !== settings.automaticFrom && settings.apiCreditCap !== null));
export type CodeFallbackSettings = z.infer<typeof codeFallbackSettings>;
export const defaultCodeFallbackSettings: CodeFallbackSettings = {
  version: 1, destination: null, apiCreditCap: null, transfer: "summary", automaticFrom: null,
};
export type CodeFallbackCliModels = Partial<Record<CliProvider, { version: string; models: Array<{ id: string; name: string }> }>>;

const scope = z.string().regex(/^[0-9a-f]{64}$/);
export const codeFallbackUpdate = z.discriminatedUnion("field", [
  z.object({ scope, field: z.literal("automatic"), enabled: z.boolean() }).strict(),
  z.object({ scope, field: z.literal("destination"), engine: z.union([z.literal("tomverse_api"), cliProvider]).nullable() }).strict(),
  z.object({ scope, field: z.literal("model"), model }).strict(),
  z.object({ scope, field: z.literal("apiCreditCap"), credits: creditCap }).strict(),
  z.object({ scope, field: z.literal("transfer"), transfer: codeTransferScope }).strict(),
]);
export type CodeFallbackUpdate = z.infer<typeof codeFallbackUpdate>;

export function codeFallbackModelAvailable(destination: CodeFallbackSettings["destination"],
  apiModels: readonly { id: string }[], cliModels: CodeFallbackCliModels) {
  if (!destination?.model) return false;
  if (destination.executionMode === "tomverse_api") {
    return destination.model !== "smart-adaptive" && apiModels.some(({ id }) => id === destination.model);
  }
  const catalog = cliModels[destination.provider];
  return catalog?.version === destination.version && catalog.models.some(({ id }) => id === destination.model);
}

export function updateCodeFallbackSettings(settings: CodeFallbackSettings, change: CodeFallbackUpdate, preference: CodeExecutionMode,
  apiModels: readonly { id: string }[], cliModels: CodeFallbackCliModels): CodeFallbackSettings {
  const current = settings.destination;
  switch (change.field) {
    case "destination": {
      const engine = change.engine;
      if (engine === (current?.executionMode === "provider_cli" ? current.provider : current?.executionMode ?? null)) return settings;
      const destination: CodeFallbackSettings["destination"] = !engine ? null : engine === "tomverse_api"
        ? { executionMode: "tomverse_api", model: null }
        : { executionMode: "provider_cli", provider: engine, model: null, version: null };
      if (destination?.executionMode === preference) throw new Error("Choose a fallback on the other execution mode.");
      return { ...settings, destination, automaticFrom: null };
    }
    case "model": {
      if (!current || current.executionMode === preference) throw new Error("Choose an alternate execution mode first.");
      const destination: NonNullable<CodeFallbackSettings["destination"]> = current.executionMode === "tomverse_api"
        ? { ...current, model: change.model }
        : { ...current, model: change.model, version: change.model ? cliModels[current.provider]?.version ?? null : null };
      if (change.model && !codeFallbackModelAvailable(destination, apiModels, cliModels)) {
        throw new Error("The fallback model is unavailable in the current catalog.");
      }
      if (current.model === change.model && (current.executionMode !== "provider_cli" || destination.executionMode !== "provider_cli" ||
          current.version === destination.version)) return settings;
      return { ...settings, destination, automaticFrom: null };
    }
    case "apiCreditCap":
      return settings.apiCreditCap === change.credits ? settings : { ...settings, apiCreditCap: change.credits, automaticFrom: null };
    case "transfer":
      return settings.transfer === change.transfer ? settings : { ...settings, transfer: change.transfer, automaticFrom: null };
    case "automatic":
      if (change.enabled && (current?.executionMode === preference || settings.apiCreditCap === null ||
          !codeFallbackModelAvailable(current, apiModels, cliModels))) {
        throw new Error("Choose an available fallback model and API credit cap first.");
      }
      return { ...settings, automaticFrom: change.enabled ? preference : null };
  }
}
