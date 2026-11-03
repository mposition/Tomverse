import { continuationRowTitle } from "../../../lib/continuationTitleContext";
import { providerLabel } from "../../../components/imports/importFormatting";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import { mobileContinuationTitle } from "../../../locales/mobileContinuationTitle";
import type { ChatSummary } from "./chatTransport";

export function nativeConversationTitle(row: ChatSummary, language: MobileLanguage): string {
  return continuationRowTitle({
    ...row,
    storedTitle: row.title,
    isContinuation: row.surface === "continuation",
    sourceTitle: row.sourceState === "deleted" || row.sourceState === "locked" ? null : row.sourceTitle,
  }, {
    fallbackTemplate: mobileContinuationTitle[language],
    untitled: mobileCopy[language].newChat,
    providerLabel,
  });
}
