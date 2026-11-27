import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical, X } from "lucide-react";
import { decideWebSearchBadge } from "../../../../lib/webSearchStatusBadge";
import { reviewFocusHint, reviewReorderHint, reviewWorkspaceCopy } from "../../../../lib/reviewWorkspaceCopy";
import { reviewProviderName } from "../../../../lib/reviewProviderName";
import type { Language } from "../../../../lib/language";
import { desktopChatCopy } from "../../../../locales/desktopChat";
import { desktopReviewCopy } from "../../../../locales/desktopReview";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { reviewHandoffCopy } from "../../../../locales/reviewHandoff";
import { columnTurns, moveColumn, shiftColumn, type ReviewMessage } from "../review-columns";
import { AnswerExtras } from "./AnswerExtras";
import { webLocales } from "./answer-locales";
import { SavedAttachments } from "./AttachmentDraft";
import { ChatMarkdown, CopyAnswer, UserMessageContent } from "./ChatTranscript";
import { GeneratedFiles } from "./GeneratedFiles";
import { effortLabel } from "./CodeEngine";
import { BrandMark } from "./ReviewBrand";
import "./review-columns.css";

const DRAG_TYPE = "application/x-tomverse-review-model";
const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);

export type ReviewColumnModel = { id: string; name: string; provider: string; on: boolean };
/** What a send in progress shows: its question, the answers received so far, the models asked ([] while the server still chooses) and a single target. */
export type ReviewLive = { running: boolean; question: string; answers: Readonly<Record<string, string>>; participants: readonly string[]; only?: string };

type Props = {
  language: Language;
  messages: readonly ReviewMessage[];
  columns: readonly ReviewColumnModel[];
  describe(modelId: string): { name: string; provider: string };
  /** The model that actually answered a saved message, where the server recorded one. */
  actual: ReadonlyMap<string, { id: string; provider?: string | null }>;
  live: ReviewLive;
  canAsk: boolean;
  canToggle(modelId: string): boolean;
  canClose(modelId: string): boolean;
  onMove(modelIds: string[]): void;
  onToggle(modelId: string): void;
  onClose(modelId: string): void;
  onAsk(modelId: string, text: string): Promise<boolean>;
  onFollowUp?: (draft: string) => void;
};

export function UserBubble({ content, language, message }: { content: string; language: Language; message?: ReviewMessage }) {
  return <div className="review-user-bubble" data-testid="review-user-bubble">
    <UserMessageContent content={content} language={language} />
    {message && <SavedAttachments message={message} language={language} />}
  </div>;
}

function WebSearchBadge({ message, language }: { message: ReviewMessage; language: Language }) {
  const meta = message.searchMetadata;
  const decision = decideWebSearchBadge({
    searchMetadata: meta && meta.requested !== undefined
      ? { requested: meta.requested, supported: meta.supported ?? false, executed: meta.executed ?? false, failureCode: meta.failureCode } : undefined,
    usageClass: undefined,
  });
  if (!decision.shown) return null;
  const chat = webLocales[language].chat;
  const label = decision.status === "executed" ? chat.searchStatusWebSearch
    : decision.status === "unsupported" ? chat.searchStatusUnsupported
      : decision.status === "failed" ? chat.searchStatusFailed : null;
  return label ? <span className="review-answer-badge" data-testid="review-search-badge">{label}</span> : null;
}

export function ReviewColumns(props: Props) {
  const { language, columns, describe, onMove } = props;
  const copy = desktopReviewCopy[language];
  const welcome = reviewWorkspaceCopy[language];
  const hintId = useId();
  const ids = columns.map((column) => column.id);
  const [view, setView] = useState<"focus" | "compare">("focus");
  const [activeChoice, setActiveChoice] = useState<string>();
  const [dragging, setDragging] = useState<string>();
  const [note, setNote] = useState("");
  const chips = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string>(undefined);
  const canReorder = columns.length > 1;
  const canFocus = columns.length === 3;
  const resolvedView = canFocus ? view : "compare";
  const active = activeChoice && ids.includes(activeChoice) ? activeChoice : ids[0];

  // A keyboard move re-inserts the chip in the list; put the focus back on it.
  useEffect(() => {
    if (!refocus.current) return;
    chips.current.get(refocus.current)?.focus();
    refocus.current = undefined;
  });

  function focusModel(id: string) {
    if (!canFocus || !ids.includes(id)) return;
    setActiveChoice(id);
    setView("focus");
  }
  function arrange(id: string, next: string[]) {
    if (next.join("\n") === ids.join("\n")) return;
    onMove(next);
    refocus.current = id;
    setNote(fill(copy.moved, { model: describe(id).name, position: next.indexOf(id) + 1, count: next.length }));
  }
  const draggable = (id: string) => ({
    draggable: canReorder,
    onDragStart: (event: DragEvent) => {
      if (!canReorder) return;
      event.dataTransfer.setData(DRAG_TYPE, id);
      event.dataTransfer.effectAllowed = "move";
      setDragging(id);
    },
    onDragEnd: () => setDragging(undefined),
  });
  function dropTarget(id: string) {
    const accepts = Boolean(dragging && dragging !== id && ids.includes(dragging) &&
      (resolvedView === "compare" ? canReorder : canFocus && id === active));
    return {
      accepts,
      onDragOver: (event: DragEvent) => {
        if (!accepts || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      },
      onDrop: (event: DragEvent) => {
        if (!accepts) return;
        const dropped = event.dataTransfer.getData(DRAG_TYPE);
        if (dropped !== dragging || !ids.includes(dropped)) return;
        event.preventDefault();
        if (resolvedView === "compare") arrange(dropped, moveColumn(ids, dropped, id));
        else focusModel(dropped);
        setDragging(undefined);
      },
    };
  }
  function chipKey(event: KeyboardEvent, id: string) {
    if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    arrange(id, shiftColumn(ids, id, event.key === "ArrowLeft" ? -1 : 1));
  }

  if (!columns.length) return null;
  return <div className="review-columns-area" data-testid="review-columns-area">
    {canReorder && <div className="review-column-toolbar">
      <div className="review-toolbar-row">
        <div className="review-model-chips" role="group" aria-label={resolvedView === "focus" ? welcome.focus : welcome.sideBySide} aria-describedby={hintId}>
          {columns.map((column) => <button key={column.id} type="button" data-testid="review-focus-model" data-model-id={column.id}
            aria-pressed={column.id === active} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
            ref={(node) => { if (node) chips.current.set(column.id, node); else chips.current.delete(column.id); }}
            onClick={() => resolvedView === "focus" ? focusModel(column.id) : setActiveChoice(column.id)}
            onKeyDown={(event) => chipKey(event, column.id)} {...draggable(column.id)}>
            <BrandMark provider={column.provider} /><span>{column.name}</span><GripVertical size={14} aria-hidden="true" />
          </button>)}
        </div>
        {canFocus && <div className="review-comparison-switch" role="group" aria-label={welcome.results}>
          <button type="button" aria-pressed={resolvedView === "focus"} onClick={() => setView("focus")}>{welcome.focus}</button>
          <button type="button" aria-pressed={resolvedView === "compare"} onClick={() => setView("compare")}>{welcome.sideBySide}</button>
        </div>}
      </div>
      <p id={hintId}>{resolvedView === "focus" ? reviewFocusHint[language] : reviewReorderHint[language]} {copy.moveHint}</p>
      <p className="review-visually-hidden" role="status">{note}</p>
    </div>}
    <div className="review-columns" role="group" aria-label={copy.modelAnswers} data-testid="review-columns"
      data-view={resolvedView} data-count={columns.length}>
      {columns.map((column, position) => {
        const drop = dropTarget(column.id);
        return <ReviewColumn key={column.id} {...props} column={column} position={position} columnIds={ids}
          focused={column.id === active} dropTarget={drop.accepts} count={columns.length}
          onDragOver={drop.onDragOver} onDrop={drop.onDrop} dragProps={draggable(column.id)}
          hint={canReorder ? resolvedView === "compare" ? reviewReorderHint[language] : reviewFocusHint[language] : undefined} />;
      })}
    </div>
  </div>;
}

function ReviewColumn({ language, messages, column, columnIds, position, count, focused, dropTarget, describe, actual, live, canAsk, canToggle, canClose,
  onToggle, onClose, onAsk, onFollowUp, onDragOver, onDrop, dragProps, hint }: Props & {
  column: ReviewColumnModel; columnIds: string[]; position: number; count: number; focused: boolean; dropTarget: boolean;
  onDragOver(event: DragEvent): void; onDrop(event: DragEvent): void; dragProps: object; hint?: string;
}) {
  const copy = desktopReviewCopy[language];
  const chat = webLocales[language].chat;
  const common = desktopChatCopy[language];
  const shell = desktopShellCopy[language];
  const handoff = reviewHandoffCopy[language === "zh-Hant" ? "zhHant" : language];
  const effortNames = { low: shell.lowEffort, medium: effortLabel(language, "medium"), default: shell.defaultEffort, high: shell.highEffort };
  const { id: modelId, name, provider, on } = column;
  const arrangement = columnIds.join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const turns = useMemo(() => columnTurns(messages, modelId, columnIds), [messages, modelId, arrangement]);
  const liveText = live.answers[modelId];
  const takesPart = live.running && (live.only ? live.only === modelId : !live.participants.length || live.participants.includes(modelId));
  const liveQuestion = takesPart ? live.question : "";
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastTop = useRef(0);
  const lastPosition = useRef(position);
  const [showLatest, setShowLatest] = useState(false);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const signature = `${turns.length}:${turns.at(-1)?.answers.length ?? 0}:${liveText?.length ?? 0}:${liveQuestion ? 1 : 0}`;
  useLayoutEffect(() => {
    const pane = scroll.current;
    if (!pane) return;
    // Reordering moves the column in the document, which resets its scroll position.
    if (lastPosition.current !== position) {
      lastPosition.current = position;
      pane.scrollTop = nearBottom.current ? pane.scrollHeight : lastTop.current;
    }
  }, [position]);
  useEffect(() => {
    const pane = scroll.current;
    if (pane && nearBottom.current) pane.scrollTop = pane.scrollHeight;
  }, [signature]);
  const busy = live.running || asking;
  const canSend = canAsk && on && !busy && Boolean(draft.trim());
  async function submit() {
    if (!canSend) return;
    setAsking(true);
    try {
      if (await onAsk(modelId, draft)) setDraft("");
    } finally {
      setAsking(false);
    }
  }
  const position1 = position + 1;

  return <section className="review-column" data-testid="review-column" data-model-id={modelId} data-focused={focused}
    data-off={!on} data-drop-target={dropTarget} onDragOver={onDragOver} onDrop={onDrop}>
    <header className="review-column-head" data-testid="review-column-head" title={hint} {...dragProps}>
      <BrandMark provider={provider} large />
      <div className="review-column-title"><strong title={name}>{name}</strong><small>{reviewProviderName(provider)}</small></div>
      {count > 1 && <div className="review-column-controls">
        <button type="button" className="review-column-switch" aria-pressed={on} disabled={!canToggle(modelId)}
          aria-label={fill(on ? chat.panelPauseLabel : chat.panelResumeLabel, { position: position1, model: name })}
          title={on ? chat.pausePanel : chat.resumePanel} onClick={() => onToggle(modelId)}>
          <span aria-hidden="true">{on ? "ON" : "OFF"}</span><i aria-hidden="true" />
        </button>
        <button type="button" className="review-column-close" disabled={!canClose(modelId)} title={chat.closeModelPanel}
          aria-label={fill(chat.panelCloseLabel, { position: position1, model: name })} onClick={() => onClose(modelId)}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>}
    </header>
    <div className="review-column-frame">
      <div className="review-column-body" ref={scroll} tabIndex={0} role="region" aria-label={fill(copy.column, { model: name })}
        onScroll={(event) => {
          const pane = event.currentTarget;
          lastTop.current = pane.scrollTop;
          nearBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 64;
          setShowLatest(!nearBottom.current);
        }}>
        {turns.map(({ question, answers }) => <div className="review-column-turn" key={question.id}>
          <UserBubble content={question.content} message={question} language={language} />
          {answers.map((answer) => {
            const shown = actual.get(answer.id)?.id ?? answer.modelId ?? modelId;
            const info = describe(shown);
            const effort = answer.searchMetadata?.reasoningEffort;
            return <article className="review-answer-block" key={answer.id} data-testid="review-answer" data-model-id={answer.modelId ?? ""}>
              <div className="review-answer-meta">
                <BrandMark provider={actual.get(answer.id)?.provider ?? info.provider} />
                <span data-testid="review-answer-model" title={info.name}>{info.name}</span>
                <WebSearchBadge message={answer} language={language} />
              </div>
              <div className="review-answer-bubble">
                {answer.content && <CopyAnswer content={answer.content} language={language} />}
                <ChatMarkdown content={answer.content} language={language} />
                <GeneratedFiles artifacts={answer.artifacts} language={language} />
                <AnswerExtras message={answer} language={language} product="review" />
                {effort?.applied && <small className="chat-effort">{common.reasoningEffort} · {effortNames[effort.applied]}
                  {effort.requested !== effort.applied && ` · ${common.requested.replace("{effort}", effortNames[effort.requested])}`}</small>}
                {answer.status === "incomplete" && <p className="notice">{copy.incomplete}</p>}
              </div>
              {answer.status === "normal" && onFollowUp && <button className="chat-review-link" type="button" onClick={() => {
                const source = copy.answerFrom.replace("{model}", () => info.name);
                onFollowUp(`${copy.originalQuestion}:\n${question.content.slice(0, 1500)}\n\n${source}:\n${answer.content.slice(0, 7000)}\n\n${copy.followUp}: `);
              }}>{handoff.continue}</button>}
            </article>;
          })}
        </div>)}
        {liveQuestion && <UserBubble content={liveQuestion} language={language} />}
        {liveText && <article className="review-answer-block" data-testid="review-live-answer">
          <div className="review-answer-meta"><BrandMark provider={provider} /><span title={name}>{name}</span></div>
          <div className="review-answer-bubble"><ChatMarkdown content={liveText} language={language} /></div>
        </article>}
        {takesPart && !liveText && <p className="review-column-waiting" role="status">{copy.waiting}</p>}
      </div>
      {showLatest && <button type="button" className="review-jump-latest" onClick={() => {
        const pane = scroll.current;
        if (pane) pane.scrollTo({ top: pane.scrollHeight, behavior: "smooth" });
      }}><ArrowDown size={14} aria-hidden="true" /> {chat.scrollToLatest}</button>}
    </div>
    {count > 1 && canAsk && <form className="review-column-ask" data-testid="review-model-only-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <textarea rows={1} value={draft} disabled={!on || busy} data-testid="review-model-only-input" placeholder={chat.modelOnlyPlaceholder}
        aria-label={fill(chat.modelOnlyInputLabel, { model: name })} onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            void submit();
          }
        }} />
      <button type="submit" data-testid="review-model-only-send" disabled={!canSend} title={chat.modelOnlySendTitle}
        aria-label={`${chat.modelOnlySendTitle} · ${name}`}><ArrowUp size={17} aria-hidden="true" /></button>
    </form>}
  </section>;
}
