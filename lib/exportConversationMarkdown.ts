import { formatExportMessageLabel, headerLineText } from "@/lib/exportConversation";

/**
 * The Markdown form of a conversation export.
 *
 * Same content, same access rules and same paging as the text export (the
 * route decides those); only the formatting differs. Message text is written
 * as it is stored, so the answer's own headings, lists and code fences survive.
 * Each turn is introduced by a level-2 heading, and the document's own
 * headings above it are the only ones this module writes.
 */

type MarkdownExportMessage = {
  role: string;
  content: string;
  modelId?: string | null;
  createdAt?: Date | string;
};

function formatDate(value?: Date | string) {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** A title on one line, with the characters Markdown would act on escaped. */
const headingText = (title: string) =>
  headerLineText(title).trim().replace(/([\\`*_{}[\]<>#|])/g, "\\$1") || "Conversation";

export function formatConversationHeaderMarkdown(
  conversation: { title: string; createdAt?: Date | string; productKey?: string | null },
  personalizationNotice?: string,
  provenance: readonly string[] = []
) {
  const created = formatDate(conversation.createdAt);
  return [
    `# ${headingText(conversation.title)}`,
    "",
    `*${conversation.productKey === "chat" ? "Tomverse Chat Export" : "Tomverse Review Export"}${created ? ` · ${created}` : ""}*`,
    ...(personalizationNotice ? ["", `> ${headerLineText(personalizationNotice)}`] : []),
    ...provenance.flatMap((line) => ["", `> ${headerLineText(line)}`]),
    "",
  ].join("\n");
}

export function formatExportMessageMarkdown(message: MarkdownExportMessage) {
  const label = headerLineText(formatExportMessageLabel(message));
  const when = formatDate(message.createdAt);
  return [
    "---",
    "",
    `## ${label}${when ? ` · ${when}` : ""}`,
    "",
    message.content,
    "",
  ].join("\n");
}
