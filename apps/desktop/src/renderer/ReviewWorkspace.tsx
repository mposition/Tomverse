import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowUp, Check, CodeXml, FileText, Globe2, ImagePlus, Sparkles, Square } from "lucide-react";
import { reviewWorkspaceCopy } from "../../../../lib/reviewWorkspaceCopy";
import { workspaceWelcomeCopy } from "../../../../locales/workspaceWelcome";
import openaiLogo from "../../../../public/model-icons/chatgpt.png?no-inline";
import anthropicLogo from "../../../../public/model-icons/claude.png?no-inline";
import googleLogo from "../../../../public/model-icons/gemini.png?no-inline";
import { DEEP_RESEARCH_MODEL_ID } from "../../../../lib/deepResearchModel";
import { canUseModelWithPlan, getModel } from "../../../../lib/models";
import { reviewProviderName } from "../../../../lib/reviewProviderName";
import { desktopChatCopy } from "../../../../locales/desktopChat";
import { desktopReviewCopy } from "../../../../locales/desktopReview";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import type { ChatConversation, ChatModel, ReviewCapability, ReviewImageOffer, ReviewTurnInput, ReviewTurnResult } from "../chat-contract";
import { ImportedSource, type useChatHistory } from "./ChatWorkspace";
import { DraftDictation } from "./DraftDictation";
import { AttachmentDraftStatus, AttachmentPicker, type DesktopAttachmentDraft } from "./AttachmentDraft";
import { DesktopModelPicker } from "./DesktopModelPicker";
import { SavedImageTurn } from "./ImageWorkspace";
import { ComposerTools } from "./ComposerTools";
import { DesktopReviewAnalysis } from "./DesktopReviewAnalysis";
import { DesktopCompareSummary } from "./DesktopCompareSummary";
import { BrandMark } from "./ReviewBrand";
import { ReviewColumns, UserBubble, type ReviewLive } from "./ReviewColumns";
import { arrangeColumns } from "../review-columns";
import type { ImageCapability } from "../images-contract";

type Message = ChatConversation["messages"][number];
type ReviewTurn = { question: Message; answers: Message[] };
type History = ReturnType<typeof useChatHistory>;
type ReviewMode = ReviewTurnInput["mode"];
type Effort = ReviewTurnInput["effort"];
type ReviewNotice = Exclude<ReviewTurnResult["status"], "saved">;

const noMessages: Message[] = [];

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
  const [models, setModels] = useState<string[]>([]);
  const [only, setOnly] = useState<string>();
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
    setModels([]);
    setOnly(undefined);
  }), []);

  /** Sends the composer draft to the chosen models, or, with `followUp`, one question to one model of the saved Review. */
  async function send(mode: ReviewMode, choices: string[], effort: Effort, attachmentUploadIds: string[], followUp?: { prompt: string; modelId: string }) {
    const prompt = followUp ? followUp.prompt : history.draft;
    if (request.current || (!prompt.trim() && !attachmentUploadIds.length) || (history.selected && !history.conversation)) return false;
    const requestId = crypto.randomUUID();
    request.current = requestId;
    hasReviewRun.current = true;
    setRunning(true);
    setNotice(null);
    setQuestion("");
    setAnswers({});
    setOutcomeId(undefined);
    setImageOffer(undefined);
    setModels(mode === "professional" ? choices : []);
    setOnly(followUp?.modelId);
    try {
      const result = await window.desktop.sendReview({ mode, choices, effort, requestId, prompt, attachmentUploadIds,
        conversationId: history.conversation?.id, ...(followUp ? { onlyModelId: followUp.modelId } : {}) });
      if (request.current !== requestId) return false;
      if (result.savedQuestion && !followUp) history.setDraft("");
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
  return { running, question, answers, models, only, notice: notice ? desktopReviewCopy[history.language][notice] : "", outcomeId, imageOffer,
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
  const effortNames = { low: shell.lowEffort, default: shell.defaultEffort, high: shell.highEffort };
  const [models, setModels] = useState<ChatModel[]>([]);
  const [modeChoice, setModeChoice] = useState<ReviewMode | null>(null);
  const [picked, setPicked] = useState<{ conversationId?: string; mode: ReviewMode; choices: string[] }>();
  const [effort, setEffort] = useState<Effort>("default");
  useEffect(() => {
    let active = true;
    void window.desktop.chatModels().then((available) => {
      if (active) setModels(available.filter(({ id }) => id !== DEEP_RESEARCH_MODEL_ID));
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  const byId = new Map(models.map((model) => [model.id, model]));
  const describe = (modelId: string) => {
    const model = byId.get(modelId) ?? getModel(modelId);
    return { name: model?.name ?? modelId, provider: model?.provider ?? "" };
  };
  const messages = history.conversation?.messages ?? noMessages;
  const columnMessages = useMemo(() => messages.filter((message) => !message.imageTurn), [messages]);
  const turns = reviewTurns(messages);
  const mode = capability?.easy ? modeChoice ?? "easy" : "professional";
  const eligible = useMemo(() => models.filter((model) => capability && canUseModelWithPlan(capability.plan, model)), [models, capability]);
  const providerIds = [...new Set(eligible.map((model) => model.provider))];
  const id = history.selected?.id;
  const chatKey = id ?? "new";
  const [arranged, setArranged] = useState<{ key: string; ids: string[] }>();
  const [closed, setClosed] = useState<{ key: string; ids: string[] }>();
  // The models the Review holds, in the order the columns were arranged.
  const storedModelIds = arrangeColumns(history.conversation?.selectedModels ?? (!id ? preferredModelIds ?? [] : []), arranged?.key === chatKey ? arranged.ids : []);
  const selected = picked && picked.conversationId === id && picked.mode === mode ? picked.choices : mode === "easy"
    ? [...new Set(storedModelIds.flatMap((modelId) => eligible.find((model) => model.id === modelId)?.provider ?? []))]
    : storedModelIds.filter((modelId) => eligible.some((model) => model.id === modelId));
  const limit = Math.min(3, capability?.modelLimit ?? 0);
  const choices = selected.slice(0, limit);
  // The chosen providers keep the places they hold in the list and take them in the order of the columns.
  let nextChosen = 0;
  const shownProviders = providerIds.map((provider) => choices.includes(provider) ? choices[nextChosen++]! : provider);
  const levels = mode === "professional" && choices.length
    ? (["low", "high"] as const).filter((level) =>
      choices.every((modelId) => eligible.find((model) => model.id === modelId)?.reasoningEfforts?.includes(level)))
    : [];
  const actualEffort = effort === "default" || levels.includes(effort) ? effort : "default";
  const showOutcome = run.running || run.outcomeId === id;
  const liveAnswers = showOutcome ? Object.entries(run.answers) : [];
  const keyOf = (modelId: string) => mode === "easy" ? describe(modelId).provider : modelId;
  const closedIds = closed?.key === chatKey ? closed.ids : [];
  // The columns are the models the saved Review holds; while a send runs they are the models it asked, and a legacy Review shows its latest answerers.
  const answered = [...new Set(turns.findLast((turn) => turn.answers.some((answer) => answer.modelId && !answer.imageTurn))
    ?.answers.flatMap((answer) => answer.modelId && !answer.imageTurn ? [answer.modelId] : []))];
  const savedIds = history.conversation?.selectedModels.length ? history.conversation.selectedModels : answered;
  const liveIds = liveAnswers.map(([modelId]) => modelId);
  const providerOrder = (modelId: string) => { const at = choices.indexOf(describe(modelId).provider); return at < 0 ? choices.length : at; };
  const baseIds = run.running && !run.only && showOutcome
    ? run.models.length ? run.models : liveIds.length ? [...liveIds].sort((a, b) => providerOrder(a) - providerOrder(b)) : savedIds
    : [...savedIds, ...liveIds.filter((modelId) => !savedIds.includes(modelId))];
  const isOn = (modelId: string) => choices.includes(keyOf(modelId));
  const columnIds = arrangeColumns(baseIds, arranged?.key === chatKey ? arranged.ids : [])
    .filter((modelId) => !closedIds.includes(modelId) || isOn(modelId));
  const columns = columnIds.map((modelId) => ({ id: modelId, ...describe(modelId), on: isOn(modelId) }));
  const live: ReviewLive = { running: showOutcome && run.running, question: showOutcome ? run.question : "",
    answers: showOutcome ? run.answers : {}, only: run.only, participants: run.models };
  const actualModels = new Map(history.conversation?.responseAttempts?.flatMap(({ assistantMessageId, actualModelId, provider }) =>
    assistantMessageId && actualModelId ? [[assistantMessageId, { id: actualModelId, provider }] as const] : []));
  const imageTurns = turns.map(({ question, answers }) => ({ question, answers: answers.filter((answer) => answer.imageTurn) }))
    .filter((turn) => columns.length ? turn.answers.length : true);
  function changeChoices(next: string[]) { setPicked({ conversationId: id, mode, choices: next }); }
  function moveColumns(next: string[]) {
    setArranged({ key: chatKey, ids: next });
    // The composer lists the models in the order the columns show them.
    const keys = [...new Set(next.map(keyOf))];
    const ordered = [...keys.filter((key) => choices.includes(key)), ...choices.filter((key) => !keys.includes(key))];
    if (ordered.join("\n") !== choices.join("\n")) changeChoices(ordered);
  }
  function toggleColumn(modelId: string) {
    const key = keyOf(modelId);
    changeChoices(choices.includes(key) ? choices.filter((choice) => choice !== key) : [...choices, key]);
  }
  function closeColumn(modelId: string) {
    const key = keyOf(modelId);
    if (choices.includes(key)) changeChoices(choices.filter((choice) => choice !== key));
    setClosed({ key: chatKey, ids: [...closedIds, modelId] });
  }
  const readOnly = history.conversation?.desktopReviewWritable === false;
  const latest = turns.at(-1);
  const completedModels = new Set(latest?.answers.filter((answer) => answer.status === "normal" && !answer.imageTurn && answer.content.trim())
    .flatMap(({ modelId }) => modelId ? [modelId] : []));
  const showComposer = capability && !readOnly && !history.selected?.isLocked && (!id || history.conversation);
  function seedPrompt(prompt: string) {
    history.setDraft([history.draft.trimEnd(), prompt].filter(Boolean).join("\n\n"));
    document.getElementById("review-draft-input")?.focus();
  }

  const inWelcome = !history.selected && !run.running;
  const status = <>
    {history.opening && !history.conversation && <p role="status">{common.loadingConversation}</p>}
    {history.notice && <p className="notice" role="status">{history.notice}</p>}
    {readOnly && <p role="status">{copy.readOnlyConversation}</p>}
  </>;
  // What the last send left behind: why it ended and the offer to compare images instead.
  const outcome = <>
    {showOutcome && run.notice && <p className="notice" role="status">{run.notice}</p>}
    {showOutcome && run.imageOffer && <section className="review-reference" aria-label={copy.imagesSuggestion}>
      <p>{run.imageOffer.unavailable.length ? copy.modelsUnavailable.replace("{providers}", () => run.imageOffer!.unavailable.join(", "))
        : copy.imagesFound}</p>
      <button className="soft" type="button" onClick={() => {
        onImages(run.imageOffer!);
        run.clearImageOffer();
      }}>{copy.imageOptions}</button>
    </section>}
  </>;
  const canAsk = Boolean(showComposer && online && id && history.conversation);
  const showActions = Boolean(showComposer && id && completedModels.size >= 2 && !run.running);

  return <>{inWelcome ? <div className="scroll">
    <div className="content review-content">
      <section className="desktop-review-welcome" aria-label={welcome.newReview}>
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
      </section>
      {status}
      {outcome}
    </div>
  </div> : <div className="review-results" data-columns={columns.length > 0}>
    <div className="review-results-lead">
      {status}
      {history.conversation?.surface === "continuation" &&
        <ImportedSource key={history.conversation.id} id={history.conversation.id} language={language} />}
      {history.conversation && !turns.length && !run.running && <p className="notice">{copy.empty}</p>}
      {imageTurns.map(({ question, answers }) => <section className="review-turn" aria-label={copy.turn} key={question.id}>
        <UserBubble content={question.content} message={question} language={language} />
        {answers.map((answer) => <SavedImageTurn key={answer.imageTurn!.groupId} turn={answer.imageTurn!} language={language} />)}
      </section>)}
      {!columns.length && live.running && live.question && <UserBubble content={live.question} language={language} />}
      {run.running && !liveAnswers.length && !columns.length && <p className="notice" role="status">{copy.waiting}</p>}
      {outcome}
      {history.conversation?.messagePage.nextCursor && <button className="soft" type="button" disabled={history.opening}
        onClick={() => void history.more()}>{common.loadMessages}</button>}
    </div>
    {columns.length > 0 && <ReviewColumns key={chatKey} language={language} messages={columnMessages}
      columns={columns} describe={describe} actual={actualModels} live={live} canAsk={canAsk}
      canToggle={(modelId) => !run.running && (isOn(modelId) ? choices.length > 1 : choices.length < limit && eligible.some((model) => keyOf(model.id) === keyOf(modelId)))}
      canClose={(modelId) => !run.running && (!isOn(modelId) || choices.length > 1)}
      onMove={moveColumns} onToggle={toggleColumn} onClose={closeColumn}
      onAsk={(modelId, text) => run.send("professional", [modelId], "default", [], { prompt: text, modelId })}
      onFollowUp={onFollowUp} />}
  </div>}
  {showComposer && <div className="composer-slot chat-composer-slot review-composer-slot">
    {showActions && <div className="review-actions" role="group" aria-label={copy.analysisActions}>
      {!history.selected?.isLocked && <DesktopCompareSummary key={`${history.account ?? ""}:${id}:${latest?.answers.map((answer) => answer.id).join(",")}`} language={language}
        conversationId={id} ready={online && !history.writing} />}
      {analysisEnabled && <DesktopReviewAnalysis key={`${history.account ?? ""}:${id}`} language={language}
        conversationId={id} scope={JSON.stringify([latest?.question.id, latest?.answers.map(({ id }) => id)])}
        ready={online && !history.writing} />}
    </div>}
    <form className="composer chat-composer" aria-label={copy.composer} onSubmit={async (event) => {
      event.preventDefault();
      if (!online || !choices.length || (!history.draft.trim() && !attachments.files.length) || run.running) return;
      const attachmentUploadIds = await attachments.prepare();
      if (!attachmentUploadIds) return;
      if (await run.send(mode, choices, actualEffort, attachmentUploadIds)) attachments.clear();
    }}>
      <AttachmentDraftStatus draft={attachments} busy={run.running} />
      <div className="review-setup">
        {capability.easy && <div className="review-mode-toggle" role="group" aria-label={copy.mode}>
          {(["easy", "professional"] as const).map((value) => <button type="button" key={value} aria-pressed={mode === value}
            disabled={run.running} onClick={() => setModeChoice(value)}>{welcome[value]}</button>)}
        </div>}
        {mode === "easy" ? <div className="review-participants" role="group" aria-label={welcome.providers}>
          <span className="review-participants-label">{welcome.providers} <b>{choices.length} / {limit}</b></span>
          {shownProviders.map((provider) => {
            const on = choices.includes(provider);
            return <button type="button" key={provider} className="review-chip" aria-pressed={on} title={welcome.automatic}
              disabled={run.running || (on ? choices.length <= 1 : limit !== 1 && choices.length >= limit)}
              onClick={() => setPicked({ conversationId: id, mode, choices: on ? choices.filter((choice) => choice !== provider)
                : limit === 1 ? [provider] : [...choices, provider] })}>
              <BrandMark provider={provider} /><span>{reviewProviderName(provider)}</span>{on && <Check size={14} aria-hidden="true" />}
            </button>;
          })}
        </div> : <DesktopModelPicker key={id ?? "new"} account={history.account} language={language} label={copy.picker}
          models={models} choices={choices} limit={limit} plan={capability.plan}
          disabled={run.running || history.writing} onChoose={(choices) => setPicked({ conversationId: id, mode, choices })}
          imageCapability={imageCapability} onImage={(modelId) => onModelImage(modelId, history.draft)}
          searchReadiness={searchReadiness} hasImageAttachments={attachments.files.some(({ mediaType }) => mediaType.startsWith("image/"))}
          effort={levels.length > 0 && <label>{common.reasoningEffort} <select aria-label={common.reasoningEffort} value={actualEffort} disabled={run.running}
            onChange={(event) => setEffort(event.currentTarget.value as Effort)}><option value="default">{effortNames.default}</option>
            {levels.map((level) => <option value={level} key={level}>{effortNames[level]}</option>)}
          </select></label>}>
          <span className="review-participants-label">{welcome.models}{actualEffort !== "default" && ` · ${effortNames[actualEffort]}`} <b>{choices.length} / {limit}</b></span>
          {choices.map((modelId) => <span className="review-chip" key={modelId}>
            <BrandMark provider={eligible.find((model) => model.id === modelId)?.provider ?? ""} /><span>{describe(modelId).name}</span>
          </span>)}
          {!choices.length && <span className="review-chip review-chip--empty">{welcome.choose}</span>}
        </DesktopModelPicker>}
      </div>
      <textarea id="review-draft-input" aria-label={copy.question} placeholder={copy.ask} value={history.draft}
        disabled={run.running || attachments.uploading} onPaste={attachments.onPaste}
        onChange={(event) => history.setDraft(event.currentTarget.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} />
      <div className="composer-actions">
        {attachments.enabled && <ComposerTools language={language} disabled={run.running || attachments.uploading}
          onDrive={online && attachments.googleDrive ? () => void attachments.importDrive() : undefined} driveFull={attachments.driveFull}>
          <AttachmentPicker draft={attachments} busy={run.running} tool />
        </ComposerTools>}
        {dictation && <DraftDictation language={language} scope={"review:" + (history.selected?.id ?? "new")}
          disabled={run.running || attachments.uploading} draft={history.draft} setDraft={history.setDraft} />}
        <span className="spacer"/>
        {run.running
          ? <button className="send stop" type="button" aria-label={copy.stop} onClick={() => void window.desktop.stopChat()}><Square size={16} /></button>
          : <button className="send" type="submit" aria-label={copy.send}
            disabled={!online || !choices.length || (!history.draft.trim() && !attachments.files.length) || attachments.uploading}><ArrowUp size={18} /></button>}
      </div>
    </form>
  </div>}
  </>;
}
