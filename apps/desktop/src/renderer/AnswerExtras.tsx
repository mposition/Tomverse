import type { Language } from "../../../../lib/language";
import { sourceRows } from "../answer-sources";
import type { ChatConversation } from "../chat-contract";
import { webLocales } from "./answer-locales";
import { openLink } from "./WebViewer";
import "./answer-extras.css";

type Message = ChatConversation["messages"][number];

function SearchCitations({ citations, language }: { citations: NonNullable<Message["searchMetadata"]>["citations"]; language: Language }) {
  const rows = sourceRows(citations);
  if (!rows.length) return null;
  const label = webLocales[language].chat.searchCitationsLabel;
  return <section className="answer-sources" data-testid="desktop-search-citations" aria-label={label}>
    <h4>{label}</h4>
    <ul>{rows.map((row) => <li key={row.key} data-testid="desktop-search-citation" data-reference-number={row.referenceNumber ?? ""}>
      {row.referenceNumber !== undefined && <span className="answer-source-number">[{row.referenceNumber}]</span>}
      {row.openable
        ? <a className="chat-answer-link" href={row.url} title={row.url}
          onClick={(event) => { event.preventDefault(); void openLink(row.url).catch(() => {}); }}>{row.title}</a>
        : <span title={row.url}>{row.title}</span>}
      {row.title !== row.host && <small>{row.host}</small>}
    </li>)}</ul>
  </section>;
}

/** What sits under a saved answer: its web sources and the way to report a problem with it. */
export function AnswerExtras({ message, language }: { message: Message; conversationId?: string; language: Language; product?: "chat" | "review" }) {
  if (message.role !== "assistant") return null;
  return <SearchCitations citations={message.searchMetadata?.citations ?? []} language={language} />;
}
