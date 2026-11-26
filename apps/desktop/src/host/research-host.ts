import { desktopResearchInput, type DesktopResearchOutcome } from "../research-contract";
import type { ChatTurnInput } from "../chat-contract";
import type { AccountSettingsApi } from "./account-settings-api";
import type { desktopChatApi } from "./chat-api";
import { createResearchRunner, type ResearchRunner } from "./research-api";

type SaveLoad = () => Promise<{ bytes: Uint8Array; suggestedName: string; extension: string }>;
type ChatApi = ReturnType<typeof desktopChatApi>;

/**
 * The `desktop:research` IPC handler. A Preview start first saves the question through the Desktop
 * Chat API (the same create and save steps a normal send makes), then asks the Research route to
 * run that saved question; nothing else in Chat changes.
 */
export function createResearchActions(deps: {
  settings(): AccountSettingsApi;
  withChat<T>(action: (api: ChatApi) => Promise<T>): Promise<T>;
  saveFile(load: SaveLoad, title: string, filterName: string): Promise<boolean>;
  saveTitle(): string;
}) {
  let current: { settings: AccountSettingsApi; run: ResearchRunner } | undefined;
  return async function research(value: unknown): Promise<DesktopResearchOutcome> {
    const input = desktopResearchInput.parse(value);
    const settings = deps.settings();
    if (current?.settings !== settings) {
      current = {
        settings,
        run: createResearchRunner(settings, {
          saveExport: (load) => deps.saveFile(load, deps.saveTitle(), "Research"),
          chat: {
            saveQuestion: (question) => deps.withChat(async (api) => {
              const turn: ChatTurnInput = { requestId: question.requestId, conversationId: question.conversationId, prompt: question.question,
                modelId: question.modelId, selectionMode: "manual", effort: "default" };
              const signal = AbortSignal.timeout(30_000);
              let conversationId = question.conversationId;
              if (conversationId) await api.configure(await api.conversation({ id: conversationId }, true, signal), turn, signal);
              else conversationId = await api.create(turn, signal);
              return { conversationId, sourceUserMessageId: await api.saveQuestion(conversationId, turn, signal) };
            }),
          },
        }),
      };
    }
    return current.run(input);
  };
}
