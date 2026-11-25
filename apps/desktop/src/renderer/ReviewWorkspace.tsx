import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowUp, Check, ChevronDown, CodeXml, FileText, Globe2, ImagePlus, Sparkles, Square } from "lucide-react";
import { reviewWorkspaceCopy } from "../../../../lib/reviewWorkspaceCopy";
import { workspaceWelcomeCopy } from "../../../../locales/workspaceWelcome";
import openaiLogo from "../../../../public/model-icons/chatgpt.png?no-inline";
import anthropicLogo from "../../../../public/model-icons/claude.png?no-inline";
import googleLogo from "../../../../public/model-icons/gemini.png?no-inline";
import { canUseModelWithPlan } from "../../../../lib/models";
import { desktopChatCopy } from "../../../../locales/desktopChat";
import { desktopReviewCopy } from "../../../../locales/desktopReview";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { mobileReviewModeLabel } from "../../../../locales/mobileSelection";
import { reviewHandoffCopy } from "../../../../locales/reviewHandoff";
import type { ChatConversation, ChatModel, ReviewCapability, ReviewImageOffer, ReviewTurnInput, ReviewTurnResult } from "../chat-contract";
import { ChatMarkdown, ImportedSource, type useChatHistory } from "./ChatWorkspace";
import { DraftDictation } from "./DraftDictation";
import { AttachmentDraftStatus, AttachmentPicker, SavedAttachments, type DesktopAttachmentDraft } from "./AttachmentDraft";
import { GeneratedFiles } from "./GeneratedFiles";
import { DesktopModelPicker } from "./DesktopModelPicker";
import { SavedImageTurn } from "./ImageWorkspace";
import { ComposerTools } from "./ComposerTools";
import { DesktopReviewAnalysis } from "./DesktopReviewAnalysis";
import type { ImageCapability } from "../images-contract";

type Message = ChatConversation["messages"][number];
type ReviewTurn = { question: Message; answers: Message[] };
type History = ReturnType<typeof useChatHistory>;
type ReviewMode = ReviewTurnInput["mode"];
type Effort = ReviewTurnInput["effort"];
type ReviewNotice = Exclude<ReviewTurnResult["status"], "saved">;

function reviewTurns(messages: readonly Message[]) {
  const turns: ReviewTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push({ question: message, answers: [] });
    else if (message.role === "assistant") turns.at(-1)?.answers.push(message);
  }
  return turns;
}

export function useReviewRun(history: History) {
  const request = useRef<string | null>(null);
  const hasReviewRun = useRef(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<ReviewNotice | null>(null);
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [outcomeId, setOutcomeId] = useState<string>();
  const [imageOffer, setImageOffer] = useState<ReviewImageOffer>();
  useEffect(() => window.desktop.subscribeReview((event) => {
    if (event.requestId !== request.current) return;
    if (event.savedPrompt !== undefined) setQuestion(event.savedPrompt);
    const { modelId, text } = event;
    if (modelId && text !== undefined) setAnswers((before) => ({ ...before, [modelId]: text }));
  }), []);
  useEffect(() => window.desktop.subscribe((snapshot) => {
    if (snapshot.account.stage === "connected" || !hasReviewRun.current) return;
    hasReviewRun.current = false;
    request.current = null;
    setRunning(false);
    setNotice(null);
    setQuestion("");
    setAnswers({});
    setOutcomeId(undefined);
    setImageOffer(undefined);
  }), []);

  async function send(mode: ReviewMode, choices: string[], effort: Effort, attachmentUploadIds: string[]) {
    if (request.current || (!history.draft.trim() && !attachmentUploadIds.length) || (history.selected && !history.conversation)) return false;
    const requestId = crypto.randomUUID();
    request.current = requestId;
    hasReviewRun.current = true;
    setRunning(true);
    setNotice(null);
    setQuestion("");
    setAnswers({});
    setOutcomeId(undefined);
    setImageOffer(undefined);
    try {
      const result = await window.desktop.sendReview({ mode, choices, effort, requestId, prompt: history.draft, attachmentUploadIds,
        conversationId: history.conversation?.id });
      if (request.current !== requestId) return false;
      if (result.savedQuestion) history.setDraft("");
      if (result.conversation) history.applyConversation(result.conversation);
      setQuestion("");
      setAnswers(Object.fromEntries(result.partial.map(({ modelId, text }) => [modelId, text])));
      setNotice(result.status === "saved" ? null : result.status);
      setOutcomeId(result.conversation?.id ?? history.selected?.id);
      setImageOffer(result.imageOffer);
      return result.savedQuestion;
    } catch {
      if (request.current === requestId) setNotice("failed");
      return false;
    } finally {
      if (request.current === requestId) {
        request.current = null;
        setRunning(false);
      }
    }
  }
  return { running, question, answers, notice: notice ? desktopReviewCopy[history.language][notice] : "", outcomeId, imageOffer,
    clearImageOffer: () => setImageOffer(undefined), send };
}

export function ReviewWorkspace({ history, capability, run, onFollowUp, onImages, onImageStarter, attachments, online, dictation, preferredModelIds,
  analysisEnabled, searchReadiness, imageCapability, onModelImage }: {
  history: History; capability: ReviewCapability | null; run: ReturnType<typeof useReviewRun>;
  onFollowUp?: (draft: string) => void;
  onImages: (offer: ReviewImageOffer) => void;
  onImageStarter?: (prompt: string) => void;
  attachments: DesktopAttachmentDraft;
  analysisEnabled?: boolean; searchReadiness?: { brave: boolean };
  imageCapability: ImageCapability | null; onModelImage(modelId: string, prompt: string): void;
  online: boolean;
  dictation: boolean;
  preferredModelIds?: readonly string[];
}) {
  const { language } = history;
  const copy = desktopReviewCopy[language];
  const welcome = reviewWorkspaceCopy[language];
  const starters = workspaceWelcomeCopy[language].starter.cards;
  const common = desktopChatCopy[language];
  const shell = desktopShellCopy[language];
  const handoff = reviewHandoffCopy[language === "zh-Hant" ? "zhHant" : language];
  const effortNames = { low: shell.lowEffort, default: shell.defaultEffort, high: shell.highEffort };
  const [models, setModels] = useState<ChatModel[]>([]);
  const [modeChoice, setModeChoice] = useState<ReviewMode | null>(null);
  const [picked, setPicked] = useState<{ conversationId?: string; mode: ReviewMode; choices: string[] }>();
  const [effort, setEffort] = useState<Effort>("default");
  useEffect(() => {
    let active = true;
    void window.desktop.chatModels().then((available) => {
      if (active) setModels(available);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  const byId = new Map(models.map((model) => [model.id, model.name]));
  const turns = reviewTurns(history.conversation?.messages ?? []);
  const mode = capability?.easy ? modeChoice ?? "easy" : "professional";
  const eligible = useMemo(() => models.filter((model) => capability && canUseModelWithPlan(capability.plan, model)), [models, capability]);
  const providerIds = [...new Set(eligible.map((model) => model.provider))];
  const id = history.selected?.id;
  const options = mode === "easy" ? providerIds.map((provider) => ({ id: provider, name: provider })) : eligible;
  const storedModelIds = history.conversation?.selectedModels ?? (!id ? preferredModelIds ?? [] : []);
  const selected = picked && picked.conversationId === id && picked.mode === mode ? picked.choices : mode === "easy"
    ? [...new Set(eligible.filter((model) => storedModelIds.includes(model.id)).map((model) => model.provider))]
    : storedModelIds.filter((modelId) => eligible.some((model) => model.id === modelId));
  const choices = selected.slice(0, Math.min(3, capability?.modelLimit ?? 0));
  const levels = mode === "professional" && choices.length
    ? (["low", "high"] as const).filter((level) =>
      choices.every((modelId) => eligible.find((model) => model.id === modelId)?.reasoningEfforts?.includes(level)))
    : [];
  const actualEffort = effort === "default" || levels.includes(effort) ? effort : "default";
  const showOutcome = run.running || run.outcomeId === id;
  const liveAnswers = showOutcome ? Object.entries(run.answers) : [];
  const readOnly = history.conversation?.desktopReviewWritable === false;
  const latest = turns.at(-1);
  const completedModels = new Set(latest?.answers.filter((answer) => answer.status === "normal" && !answer.imageTurn && answer.content.trim())
    .flatMap(({ modelId }) => modelId ? [modelId] : []));
  const showComposer = capability && !readOnly && !history.selected?.isLocked && (!id || history.conversation);
  function seedPrompt(prompt: string) {
    history.setDraft([history.draft.trimEnd(), prompt].filter(Boolean).join("\n\n"));
    document.getElementById("review-draft-input")?.focus();
  }

  return <><div className="scroll">
    <div className={`content review-content${history.selected || run.running ? " review-content--conversation" : ""}`}>
      {!history.selected && !run.running && <section className="desktop-review-welcome" aria-label={welcome.newReview}>
        <div className="desktop-review-intro-bar">
          <span>{welcome.newReview}</span>
          {capability?.easy && <small>{welcome.automatic}</small>}
        </div>
        <div className="desktop-review-intro">
          <div><h2>{welcome.welcome}</h2><p>{welcome.intro}</p></div>
          <div className="desktop-review-perspectives" aria-hidden="true">
            {[
              { name: "OpenAI", logo: openaiLogo, title: welcome.documents.split("\n")[0] },
              { name: "Anthropic", logo: anthropicLogo, title: welcome.focus },
              { name: "Google", logo: googleLogo, title: welcome.results },
            ].map(({ name, logo, title }) => <div className="desktop-review-perspective" key={name}>
              <div><img src={logo} width="22" height="22" alt="" /><span>{name}</span><Check size={13} /></div>
              <strong>{title}</strong><i /><i />
            </div>)}
          </div>
        </div>
        <>
          <div className="desktop-review-starter-heading"><strong>{welcome.start}</strong><small>{welcome.seedHint}</small></div>
          <div className="desktop-review-starter-grid">
            <button className="desktop-review-document" type="button" disabled={!showComposer || !attachments.enabled}
              onClick={() => seedPrompt(starters.documentQuestions.seed)}><FileText size={20} aria-hidden="true" />
              <strong>{welcome.documents}</strong><span>{welcome.documentHint}<ArrowRight size={16} aria-hidden="true" /></span>
            </button>
            <button className="desktop-review-image" type="button" disabled={!showComposer || !onImageStarter}
              onClick={() => onImageStarter?.(starters.compareImageModels.seed)}><ImagePlus size={20} aria-hidden="true" />
              <span><strong>{welcome.images}</strong><small>{welcome.imageHint}</small></span><ArrowRight size={16} aria-hidden="true" />
            </button>
            <button className="desktop-review-research" type="button" disabled={!showComposer} onClick={() => seedPrompt(starters.sourcedAnswer.seed)}>
              <Globe2 size={20} aria-hidden="true" /><span><strong>{welcome.research}</strong><small>{welcome.researchHint}</small></span><ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="desktop-review-extra-starters">
            <button className="soft" type="button" disabled={!showComposer} onClick={() => seedPrompt(starters.debugStackTrace.seed)}>
              <CodeXml size={16} aria-hidden="true" />{welcome.code}
            </button>
            <button className="soft" type="button" disabled={!showComposer} onClick={() => seedPrompt(starters.spreadsheetFromAnswer.seed)}>
              <FileText size={16} aria-hidden="true" />{welcome.files}
            </button>
          </div>
          <div className="desktop-review-starter-footer">
            <p>{workspaceWelcomeCopy[language].starter.hint}</p>
            <button className="soft" type="button" disabled={!showComposer || (capability?.modelLimit ?? 0) < 3} onClick={() => seedPrompt(starters.compareAnswers.seed)}>
              <Sparkles size={16} aria-hidden="true" />{starters.compareAnswers.label}
            </button>
          </div>
        </>
        {!capability && <p role="status">{copy.readOnlyServer}</p>}
      </section>}
      {history.opening && !history.conversation && <p role="status">{common.loadingConversation}</p>}
      {history.notice && <p className="notice" role="status">{history.notice}</p>}
      {readOnly && <p role="status">{copy.readOnlyConversation}</p>}
      {history.conversation?.surface === "continuation" &&
        <ImportedSource key={history.conversation.id} id={history.conversation.id} language={language} />}
      {history.conversation && !turns.length && !run.running && <p className="notice">{copy.empty}</p>}
      {turns.map(({ question, answers }) => <section className="review-turn" aria-label={copy.turn} key={question.id}>
        <h2>{question.content}</h2>
        <SavedAttachments message={question} language={language} />
        {answers.length > 0 && <ul className="review-answers" aria-label={copy.modelAnswers}>
          {answers.map((answer) => <li className="review-answer" key={answer.id}>
            {answer.imageTurn ? <SavedImageTurn key={answer.imageTurn.groupId} turn={answer.imageTurn} language={language} /> : <>
              <h3>{answer.modelId ? byId.get(answer.modelId) ?? answer.modelId : copy.modelUnavailable}</h3>
              <ChatMarkdown content={answer.content} />
            </>}
            <GeneratedFiles artifacts={answer.artifacts} language={language} />
            {answer.searchMetadata?.reasoningEffort?.applied &&
              <small className="chat-effort">{common.reasoningEffort} · {effortNames[answer.searchMetadata.reasoningEffort.applied]}
                {answer.searchMetadata.reasoningEffort.requested !== answer.searchMetadata.reasoningEffort.applied &&
                  ` · ${common.requested.replace("{effort}", effortNames[answer.searchMetadata.reasoningEffort.requested])}`}</small>}
            {answer.status === "incomplete" && <p className="notice">{copy.incomplete}</p>}
            {answer.status === "normal" && onFollowUp && <button className="chat-review-link" type="button" onClick={() => {
              const modelName = answer.modelId ? byId.get(answer.modelId) ?? answer.modelId : copy.model;
              const source = copy.answerFrom.replace("{model}", () => modelName);
              onFollowUp(`${copy.originalQuestion}:\n${question.content.slice(0, 1500)}\n\n${source}:\n${answer.content.slice(0, 7000)}\n\n${copy.followUp}: `);
            }}>{handoff.continue}</button>}
          </li>)}
        </ul>}
      </section>)}
      {(run.question || liveAnswers.length > 0) && <section className="review-turn" aria-label={copy.currentAnswers}>
        {run.question && <h2>{run.question}</h2>}
        {liveAnswers.length > 0 && <ul className="review-answers" aria-label={copy.liveAnswers}>
          {liveAnswers.map(([modelId, text]) => <li className="review-answer" key={modelId}>
            <h3>{byId.get(modelId) ?? modelId}</h3><ChatMarkdown content={text} />
          </li>)}
        </ul>}
      </section>}
      {run.running && !liveAnswers.length && <p className="notice" role="status">{copy.waiting}</p>}
      {showOutcome && run.notice && <p className="notice" role="status">{run.notice}</p>}
      {showOutcome && run.imageOffer && <section className="review-reference" aria-label={copy.imagesSuggestion}>
        <p>{run.imageOffer.unavailable.length ? copy.modelsUnavailable.replace("{providers}", () => run.imageOffer!.unavailable.join(", "))
          : copy.imagesFound}</p>
        <button className="soft" type="button" onClick={() => {
          onImages(run.imageOffer!);
          run.clearImageOffer();
        }}>{copy.imageOptions}</button>
      </section>}
      {history.conversation?.messagePage.nextCursor && <button className="soft" type="button" disabled={history.opening}
        onClick={() => void history.more()}>{common.loadMessages}</button>}
    </div>
  </div>
  {showComposer && <div className="composer-slot chat-composer-slot review-composer-slot">
    <form className="composer chat-composer" aria-label={copy.composer} onSubmit={async (event) => {
      event.preventDefault();
      if (!online || !choices.length || (!history.draft.trim() && !attachments.files.length) || run.running) return;
      const attachmentUploadIds = await attachments.prepare();
      if (!attachmentUploadIds) return;
      if (await run.send(mode, choices, actualEffort, attachmentUploadIds)) attachments.clear();
    }}>
      <AttachmentDraftStatus draft={attachments} busy={run.running} />
      <textarea id="review-draft-input" aria-label={copy.question} placeholder={copy.ask} value={history.draft}
        disabled={run.running || attachments.uploading} onPaste={attachments.onPaste}
        onChange={(event) => history.setDraft(event.currentTarget.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} />
      <div className="composer-actions">
        {attachments.enabled && <ComposerTools language={language}><AttachmentPicker draft={attachments} busy={run.running} tool /></ComposerTools>}
        {dictation && <DraftDictation language={language} scope={"review:" + (history.selected?.id ?? "new")}
          disabled={run.running || attachments.uploading} draft={history.draft} setDraft={history.setDraft} />}
        <span className="spacer"/>
        {capability.easy && <label className="desktop-review-mode" title={copy.mode}><select aria-label={copy.mode} value={mode} disabled={run.running}
          onChange={(event) => setModeChoice(event.currentTarget.value as ReviewMode)}>
          <option value="easy">{mobileReviewModeLabel(language, "easy")}</option>
          <option value="professional">{mobileReviewModeLabel(language, "professional")}</option>
        </select></label>}
        {mode === "professional" ? <DesktopModelPicker key={id ?? "new"} account={history.account} language={language} label={copy.picker}
          models={models} choices={choices} limit={Math.min(3, capability.modelLimit)} plan={capability.plan}
          disabled={run.running || history.writing} onChoose={(choices) => setPicked({ conversationId: id, mode, choices })}
          imageCapability={imageCapability} onImage={(modelId) => onModelImage(modelId, history.draft)}
          searchReadiness={searchReadiness} hasImageAttachments={attachments.files.some(({ mediaType }) => mediaType.startsWith("image/"))}
          effort={levels.length > 0 && <label>{common.reasoningEffort} <select aria-label={common.reasoningEffort} value={actualEffort} disabled={run.running}
            onChange={(event) => setEffort(event.currentTarget.value as Effort)}><option value="default">{effortNames.default}</option>
            {levels.map((level) => <option value={level} key={level}>{effortNames[level]}</option>)}
          </select></label>}>
          {copy.models} · {choices.length}
        </DesktopModelPicker> : <details className="model-menu">
          <summary aria-label={copy.picker}>
            {mobileReviewModeLabel(language, mode)}
            {actualEffort !== "default" && ` · ${effortNames[actualEffort]}`} <ChevronDown size={15} />
          </summary>
          <div className="model-popover review-picker">
            <fieldset disabled={run.running}>
              <legend>{mode === "easy" ? copy.providers : copy.models}</legend>
              {options.map((option) => <label key={option.id}>
                <input type="checkbox" checked={choices.includes(option.id)}
                  disabled={!choices.includes(option.id) && choices.length >= Math.min(3, capability.modelLimit)}
                  onChange={(event) => setPicked({ conversationId: id, mode, choices: event.currentTarget.checked
                    ? [...choices, option.id] : choices.filter((choice) => choice !== option.id) })} />
                {option.name}
              </label>)}
            </fieldset>
          </div>
        </details>}
        {run.running
          ? <button className="send stop" type="button" aria-label={copy.stop} onClick={() => void window.desktop.stopChat()}><Square size={16} /></button>
          : <button className="send" type="submit" aria-label={copy.send}
            disabled={!online || !choices.length || (!history.draft.trim() && !attachments.files.length) || attachments.uploading}><ArrowUp size={18} /></button>}
      </div>
      {analysisEnabled && <DesktopReviewAnalysis key={`${history.account ?? ""}:${id ?? "new"}`} language={language}
        conversationId={id} scope={JSON.stringify([latest?.question.id, latest?.answers.map(({ id }) => id)])}
        ready={online && !run.running && !history.writing && completedModels.size >= 2} />}
    </form>
  </div>}
  </>;
}
