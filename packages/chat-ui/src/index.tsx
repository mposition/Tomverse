import ReactMarkdown, { type Options } from "react-markdown";
import { CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPlugins";
export { CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPlugins";
/** Shared safe Markdown parser; navigation and visual components stay with each client. */
export function AnswerMarkdown(props: Options) {
  return <ReactMarkdown remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS} {...props} />;
}
