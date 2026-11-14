import { ASSISTANT_PROFILE_LIMITS } from "../../../lib/assistantProfileVersioning";
import { canUseModelWithPlan } from "../../../lib/models";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Brain, ChevronRight, FileText, Files, Globe, Image as ImageIcon, Library, MessagesSquare, Plus, ArrowLeft, BookOpen, LockKeyhole } from "lucide-react";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileIosWorkspaceCopy } from "../../../locales/mobileIosWorkspace";
import { Sheet } from "./Sheet";
import type { ChatTransport, AssistantSummary, MemoryPreferences } from "./chatTransport";
import type { AssistantDetail, AssistantEntry, AssistantInput, ExternalDetail, ExternalSnapshot, IosPanel, KnowledgeListing, KnowledgeFile, WorkspaceFeatures } from "./iosWorkspaceContract";
import type { WorkerResponse } from "../../../lib/workers/externalImportWorker";
import type { ImportPreview } from "../../../lib/externalImportPipeline";
import type { ParsedExternalConversation } from "../../../lib/externalImportAdapters/types";
import { AnswerContent } from "./AnswerContent";

const starterRows = [
  ["document", "Read a document", "자료를 읽고 할 일 정리", "Read the attached document and list actions, owners and deadlines.", "첨부 자료를 읽고 할 일, 담당자와 기한을 정리해줘."],
  ["search", "Find a sourced answer", "출처가 있는 답 찾기", "Find current information and explain it with source links.", "최근 정보를 찾아 출처 링크와 함께 설명해줘."],
  ["image", "Make an image", "이미지 만들기", "Create an image of a calm, bright workspace.", "밝고 차분한 작업 공간 이미지를 만들어줘."],
  ["xlsx", "Create an Excel table", "Excel 표 만들기", "Create an Excel checklist for my launch plan.", "출시 준비 계획을 Excel 체크리스트로 만들어줘."],
  ["docx", "Create a Word document", "Word 문서 만들기", "Turn my plan into a downloadable Word document.", "내 계획을 내려받을 수 있는 Word 문서로 만들어줘."],
  ["pptx", "Create a presentation", "발표자료 만들기", "Turn my plan into a PowerPoint presentation.", "내 계획을 PowerPoint 발표자료로 만들어줘."],
  ["pdf", "Convert my file to PDF", "내 파일을 PDF로", "Convert the attached file to PDF.", "첨부한 파일을 PDF로 변환해줘."],
  ["summary", "Summarise a long text", "긴 글 요약하기", "Summarise this text and list what I should check.", "이 글을 요약하고 확인할 점을 정리해줘."],
  ["reply", "Draft a reply", "답장 초안 쓰기", "Help me write a clear and considerate reply.", "이해하기 쉽고 정중한 답장 초안을 써줘."],
  ["code", "Explain some code", "코드 이해하기", "Explain what this code does, with a simple example.", "이 코드가 하는 일을 쉬운 예시로 설명해줘."],
  ["learn", "Learn a concept", "낯선 개념 배우기", "Teach me this concept as a beginner, using examples.", "초보자도 이해하도록 이 개념을 예시로 설명해줘."],
  ["week", "Plan my week", "한 주 계획 세우기", "Help me prioritise and plan this week.", "이번 주 할 일의 우선순위와 일정을 정리해줘."],
] as const;
export function IosAssistantBadge({ id, transport }: { id: string; transport: ChatTransport }) {
  const [name, setName] = useState("");
  useEffect(() => {
    let live = true;
    void transport.assistants?.().then(rows => { if (live) setName(rows.find(row => row.id === id)?.name ?? ""); }).catch(() => {});
    return () => { live = false; };
  }, [id, transport]);
  return name ? <div className="ios-assistant-badge" data-testid="ios-active-assistant"><Bot size={17} /><span>{name}</span></div> : null;
}
function ImportWarnings({ preview, language }: { preview: ImportPreview; language: MobileLanguage }) {
  const c = mobileIosWorkspaceCopy(language), t = preview.totals;
  const rows = [[c.skippedMessages, t.skippedNonConversationMessages], [c.skippedParts, t.skippedNonTextParts], [c.branches, t.additionalBranches], [c.nestedArchives, t.skippedNestedArchives], [c.unassigned, t.unassignedTurns], [c.missingAttachments, t.missingAttachments], [c.duplicateBranches, t.duplicatedBranchMessages], [c.unsupportedAnswers, t.skippedUnrecognizedAnswers]] as const;
  const visible = rows.filter(([, count]) => count > 0);
  return visible.length ? <details><summary>{c.warnings}</summary><dl>{visible.map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl></details> : null;
}
export function IosStarters({ language, imageEnabled, onSeed, all = false }: { language: MobileLanguage; imageEnabled: boolean; onSeed: (text: string) => void; all?: boolean }) {
  return <div className="ios-starters">{starterRows.filter(row => row[0] !== "image" || imageEnabled).slice(0, all ? undefined : 3).map(([key, en, ko, seedEn, seedKo]) => <button type="button" key={key} data-testid={`ios-starter-${key}`} onClick={() => onSeed(language === "ko" ? seedKo : seedEn)}>{key === "image" ? <ImageIcon size={18} /> : key === "search" ? <Globe size={18} /> : <FileText size={18} />}<span>{language === "ko" ? ko : en}</span><ChevronRight size={16} /></button>)}</div>;
}
export function IosWelcome({ language, automatic, imageEnabled, importsEnabled, onPanel, onSeed }: { importsEnabled: boolean; language: MobileLanguage; automatic: boolean; imageEnabled: boolean; onPanel: (panel: IosPanel) => void; onSeed: (text: string) => void }) {
  const c = mobileIosWorkspaceCopy(language);
  return <section className="ios-welcome" data-testid="workspace-start" data-product="chat"><span className="ios-eyebrow">Chat</span><h1>{automatic ? c.chatFirst : c.manualFirst}<br />{automatic ? c.chatLast : c.manualLast}</h1><p>{automatic ? c.automatic : c.manual}</p><IosStarters language={language} imageEnabled={imageEnabled} onSeed={onSeed} />{importsEnabled && <button className="ios-import-entry" onClick={() => onPanel("imports")}><MessagesSquare size={21} /><span>{c.imports}<small>{c.importHint}</small></span><ChevronRight size={17} /></button>}<div className="ios-welcome-links"><button onClick={() => onPanel("assistants")}><Bot size={17} />{c.assistants}</button><button onClick={() => onPanel("starters")}><Plus size={17} />{c.starters}</button></div></section>;
}
export function IosNavigation({ language, product, busy, importsEnabled, onProduct, onPanel }: { importsEnabled: boolean; language: MobileLanguage; product: "chat" | "review"; busy: boolean; onProduct: (product: "chat" | "review") => void; onPanel: (panel: IosPanel) => void }) {
  const c = mobileIosWorkspaceCopy(language);
  return <nav className="ios-navigation" aria-label={c.library}><button disabled={busy} aria-current={product === "chat" ? "page" : undefined} onClick={() => onProduct("chat")}><MessagesSquare size={19} />Chat</button><button className="ios-ipad-review" disabled={busy} aria-current={product === "review" ? "page" : undefined} onClick={() => onProduct("review")}><Files size={19} />Review</button><button disabled={busy} onClick={() => onPanel("library")}><Library size={19} />{c.library}</button><div className="ios-ipad-links">{importsEnabled && <button disabled={busy} onClick={() => onPanel("imports")}><BookOpen size={19} />{c.imports}</button>}<button disabled={busy} onClick={() => onPanel("assistants")}><Bot size={19} />{c.assistants}</button></div></nav>;
}

export function IosWorkspacePanel({ entry, language, transport, imageEnabled, onClose, onStartAssistant, onContinue, onSeed, onSettings }: {
  entry: AssistantEntry; language: MobileLanguage; transport: ChatTransport; imageEnabled: boolean;
  onClose: () => void; onStartAssistant: (profile: AssistantSummary) => Promise<void>; onContinue: (id: string) => Promise<void>; onSeed: (text: string) => void; onSettings: () => void;
}) {
  const c = mobileIosWorkspaceCopy(language), productName = entry.product === "review" ? "Review" : "Chat";
  const workspace = useMemo(() => transport.workspace, [transport]);
  const [panel, setPanel] = useState<IosPanel | "memory">(entry.panel);
  const [features, setFeatures] = useState<WorkspaceFeatures>({ assistantEditing: false, assistantKnowledge: false, externalImport: false });
  const [profiles, setProfiles] = useState<AssistantSummary[]>([]), [profile, setProfile] = useState<AssistantDetail | null>(null);
  const [editing, setEditing] = useState(false), [saved, setSaved] = useState(false);
  const [name, setName] = useState(""), [instructions, setInstructions] = useState("");
  const [web, setWeb] = useState(false), [research, setResearch] = useState(false), [accountMemory, setAccountMemory] = useState(false);
  const [model, setModel] = useState(""), [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeFile[]>([]), [fileIds, setFileIds] = useState<string[]>([]);
  const [snapshots, setSnapshots] = useState<ExternalSnapshot[]>([]), [total, setTotal] = useState(0), [continuationEnabled, setContinuationEnabled] = useState(false);
  const [source, setSource] = useState<ExternalDetail | null>(null), [disclosure, setDisclosure] = useState(false);
  const [guide, setGuide] = useState(false), [provider, setProvider] = useState("chatgpt"), [preview, setPreview] = useState<ImportPreview | null>(null), [parsed, setParsed] = useState<ParsedExternalConversation[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [knowledgeCapacity, setKnowledgeCapacity] = useState<KnowledgeListing["capacity"] | null>(null);
  const [importCapacity, setImportCapacity] = useState<{ externalConversations: number; normalizedTextBytes: number } | null>(null);
  const [memory, setMemory] = useState<MemoryPreferences | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(""), [uncertain, setUncertain] = useState(false), [status, setStatus] = useState("");
  const worker = useRef<Worker | null>(null), live = useRef(true), continuationKey = useRef<{ id: string; key: string } | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; worker.current?.terminate(); }; }, []);
  async function reload() {
    if (!live.current) return;
    try {
      const flags = await workspace?.features(); if (!live.current) return;
      if (flags) setFeatures(flags);
      const rows = await transport.assistants?.().catch(() => { if (live.current) setError(c.error); return []; }); if (!live.current) return; setProfiles(rows ?? []);
      if (flags?.externalImport && workspace) { const capacity = await workspace.importCapacity(); if (!live.current) return; setImportCapacity(capacity.remaining); const list = await workspace.imports(); if (!live.current) return; setSnapshots(list.conversations); setTotal(list.total); setContinuationEnabled(list.continuationEnabled); }
      if (transport.memoryPreferences) { const value = await transport.memoryPreferences(); if (live.current) setMemory(value); }
      if (!live.current) return;
      setUncertain(false); setEditing(false); setProfile(null); setSource(null); setPreview(null); setGuide(false);
    } catch { if (live.current) setError(c.error); }
    finally { if (live.current) setLoading(false); }
  }
  useEffect(() => { void Promise.resolve().then(reload); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- Account-scoped panel mounts capture the setup origin and transport.
  async function action(operation: () => Promise<void>, write = false) {
    if (busy || loading || uncertain) return;
    setBusy(true); setError(""); setStatus("");
    try { await operation(); } catch (failure) { if (live.current) { setError((failure as { code?: string }).code === "ASSISTANT_PROFILE_VERSION_STALE" ? c.reload : c.error); if (write) setUncertain(true); } }
    finally { if (live.current) setBusy(false); }
  }
  function assignProfile(value: AssistantDetail) {
    setProfile(value); setName(value.name); setInstructions(value.currentVersion?.instructions ?? ""); setModel(value.currentVersion?.models[0] ?? ""); setWeb(value.currentVersion?.toolPolicy.webSearch ?? false); setResearch(value.currentVersion?.toolPolicy.deepResearch ?? false); setAccountMemory(value.currentVersion?.memoryPolicy.useAccountMemory ?? false); setKnowledge(value.knowledgeFiles ?? []); setFileIds(value.currentVersion?.knowledgeManifest.map(file => file.fileId) ?? []);
  }
  async function edit(id?: string) {
    if (!workspace) return;
    if (id) { assignProfile(await workspace.assistant(id)); if (features.assistantKnowledge) { const listing = await workspace.knowledge(id); if (!live.current) return; setKnowledge(listing.files); setKnowledgeCapacity(listing.capacity); } }
    else { setProfile(null); setName(""); setInstructions(""); setModel(""); setWeb(false); setResearch(false); setAccountMemory(false); setFileIds([]); setKnowledge([]); setKnowledgeCapacity(null); }
    const [catalog, capability] = await Promise.all([transport.models(), transport.mobileCapabilities?.()]); if (!live.current) return; setModels(capability ? catalog.filter(row => canUseModelWithPlan(capability.plan, row)) : []); setSaved(false); setEditing(true);
  }
  async function save() {
    if (!workspace || !name.trim() || !instructions.trim()) throw Error("ASSISTANT_INPUT_REQUIRED");
    let current = profile;
    if (!current) {
      current = await workspace.createAssistant({ name: name.trim(), instructions: instructions.trim(), modelIds: model ? [model] : [] });
      if (!live.current) return;
      assignProfile(current);
    } else {
      const input: AssistantInput = { name: name.trim(), instructions, modelIds: (current.currentVersion?.models.length ?? 0) > 1 ? current.currentVersion!.models : model ? [model] : [], toolPolicy: { webSearch: web, deepResearch: research }, memoryPolicy: { useAccountMemory: accountMemory }, starters: current.currentVersion?.starters ?? [], knowledgeFileIds: fileIds };
      current = await workspace.saveAssistant(current, input); if (!live.current) return; assignProfile(current);
    }
    setProfiles(await transport.assistants!()); if (!live.current) return; setSaved(true); setEditing(false);
  }
  function parse(file?: File) {
    if (!file || busy) return;
    worker.current?.terminate(); setBusy(true); setError(""); setPreview(null); setParsed([]); setSelected([]);
    const task = new Worker(new URL("../../../lib/workers/externalImportWorker.ts", import.meta.url), { type: "module" }); worker.current = task;
    task.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (!live.current || worker.current !== task) return;
      if (event.data.type === "preview") { setPreview(event.data.preview); setParsed(event.data.conversations); setProvider(event.data.preview.provider); setBusy(false); task.terminate(); }
      if (event.data.type === "error" || event.data.type === "cancelled") { setError(c.failedParse); setBusy(false); task.terminate(); }
    };
    task.onerror = () => { if (live.current) { setError(c.failedParse); setBusy(false); } task.terminate(); };
    task.postMessage({ type: "parse", file });
  }
  function chooseSource(item: ExternalSnapshot) { void action(async () => { const value = await workspace!.source(item.id); if (live.current) { setSource(value); setDisclosure(false); continuationKey.current = { id: item.id, key: crypto.randomUUID() }; } }); }
  const disabled = busy || loading || uncertain;
  const back = <button type="button" className="ios-back" disabled={busy} onClick={() => { setPanel(entry.panel); setEditing(false); setProfile(null); setSource(null); setGuide(false); setPreview(null); setSaved(false); }}><ArrowLeft size={17} />{c.back}</button>;
  return <Sheet className="ios-workspace-sheet" title={panel === "assistants" ? c.assistants : panel === "imports" ? c.imports : panel === "memory" ? c.memory : panel === "starters" ? c.starters : c.library} closeLabel={c.close} onClose={() => { if (!busy) onClose(); }} exitLabel={c.return.replace("{product}", productName)} onExit={() => { if (!busy) onClose(); }}>
    <div className="ios-panel-content" aria-busy={busy || loading}>
      {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}{loading && <p role="status">{c.working}</p>}
      {uncertain && <button disabled={busy} onClick={() => { setLoading(true); setError(""); void reload(); }}>{c.reload}</button>}
      {panel === "library" && <div className="ios-library">{([["imports", MessagesSquare, c.imports], ["assistants", Bot, c.assistants], ["memory", Brain, c.memory]] as const).filter(([value]) => value !== "imports" || features.externalImport).map(([value, Icon, label]) => <button key={value} disabled={disabled} onClick={() => setPanel(value)}><Icon size={21} /><span>{label}</span><ChevronRight size={17} /></button>)}<button onClick={onSettings}><Library size={21} /><span>{c.settings}</span><ChevronRight size={17} /></button></div>}
      {panel === "starters" && <IosStarters language={language} imageEnabled={imageEnabled} all onSeed={onSeed} />}
      {panel === "memory" && <>{back}<p>{memory ? memory.masterEnabled ? c.memoryOn : c.memoryOff : c.sourceUnavailable}</p>{memory && <><label className="ios-checkbox"><input type="checkbox" checked={memory.masterEnabled} disabled={disabled} onChange={event => setMemory({ ...memory, masterEnabled: event.target.checked })} />{c.useMemory}</label><button className="primary" disabled={disabled || !transport.saveMemoryPreferences} onClick={() => void action(async () => { await transport.saveMemoryPreferences!(memory); if (live.current) setStatus(c.saved); }, true)}>{c.save}</button></>}</>}
      {panel === "assistants" && <><p className="ios-entry-product" data-testid="ios-assistant-origin">{c.entry.replace("{product}", productName)}</p>
        {!editing && !saved && <><div className="ios-library">{profiles.map(row => <div className="ios-assistant-row" key={row.id}><Bot size={23} /><div><strong>{row.name}</strong><small>{row.description || c.private}</small><button disabled={disabled} data-testid="ios-start-assistant" onClick={() => void action(() => onStartAssistant(row), true)}>{c.start.replace("{product}", productName)}</button></div>{features.assistantEditing && <button aria-label={`${c.advanced}: ${row.name}`} disabled={disabled} onClick={() => void action(() => edit(row.id))}><ChevronRight size={18} /></button>}</div>)}</div>{features.assistantEditing ? <button className="primary" disabled={disabled} onClick={() => void action(() => edit())}><Plus size={18} />{c.newAssistant}</button> : <p className="ios-server-note">{c.unavailable}</p>}</>}
        {editing && <form onSubmit={event => { event.preventDefault(); void action(save, true); }}><label className="ios-field">{c.name}<input autoComplete="off" maxLength={ASSISTANT_PROFILE_LIMITS.maxNameCharacters} required value={name} disabled={disabled} onChange={event => setName(event.target.value)} /></label><label className="ios-field">{c.instructions}<textarea maxLength={ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters} required value={instructions} disabled={disabled} onChange={event => setInstructions(event.target.value)} /></label><details><summary>{c.advanced}</summary><label className="ios-field">{c.model}<select disabled={disabled || (profile?.currentVersion?.models.length ?? 0) > 1} value={model} onChange={event => setModel(event.target.value)}><option value="">{c.defaultModel}</option>{models.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>{profile && <><label className="ios-checkbox"><input type="checkbox" checked={web} disabled={disabled} onChange={event => setWeb(event.target.checked)} />{c.tools}</label><label className="ios-checkbox"><input type="checkbox" checked={research} disabled={disabled} onChange={event => setResearch(event.target.checked)} />{c.deepResearch}</label><label className="ios-checkbox"><input type="checkbox" checked={accountMemory} disabled={disabled} onChange={event => setAccountMemory(event.target.checked)} />{c.useMemory}</label></>}{profile && features.assistantKnowledge && <div className="ios-knowledge">{knowledgeCapacity && <p>{c.capacity.replace("{count}", String(Math.min(knowledgeCapacity.remaining.filesInProfile, knowledgeCapacity.remaining.filesInAccount))).replace("{mb}", String(Math.floor(knowledgeCapacity.remaining.objectBytes / 1048576)))}</p>}<label className="ios-file-picker">{c.addFile}<input type="file" disabled={disabled || !knowledgeCapacity || knowledgeCapacity.remaining.filesInProfile < 1 || knowledgeCapacity.remaining.filesInAccount < 1} accept={knowledgeCapacity?.acceptedMediaTypes.join(",")} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file && knowledgeCapacity && (file.size > Math.min(knowledgeCapacity.limits.maxFileBytes, knowledgeCapacity.remaining.objectBytes) || !knowledgeCapacity.acceptedMediaTypes.includes(file.type || "application/octet-stream"))) { setError(c.fileLimit); return; } if (file) void action(async () => { await workspace!.uploadKnowledge(profile.id, file); const files = await workspace!.knowledge(profile.id); if (live.current) { setKnowledge(files.files); setKnowledgeCapacity(files.capacity); } }, true); }} /></label><button type="button" disabled={disabled} onClick={() => void action(async () => { const files = await workspace!.knowledge(profile.id); if (live.current) { setKnowledge(files.files); setKnowledgeCapacity(files.capacity); } })}>{c.refresh}</button>{knowledge.map(file => <label className="ios-checkbox" key={file.id}><input type="checkbox" checked={fileIds.includes(file.id)} disabled={disabled || file.processingStatus !== "ready"} onChange={event => setFileIds(ids => event.target.checked ? [...ids, file.id] : ids.filter(id => id !== file.id))} /><span>{file.name}<small>{file.processingStatus === "ready" ? c.ready : file.processingStatus === "failed" ? c.failedFile : c.pending} · {c.select}</small></span></label>)}<p>{c.fileHint}</p></div>}</details><button type="submit" className="primary" disabled={disabled || !name.trim() || !instructions.trim()}>{c.save}</button></form>}
        {saved && profile && <><p role="status">{c.saved}</p><h3>{profile.name}</h3><p>{profile.currentVersion?.instructions}</p><button disabled={disabled} className="primary" data-testid="ios-start-assistant" onClick={() => void action(() => onStartAssistant(profile), true)}>{c.start.replace("{product}", productName)}</button><button disabled={disabled} onClick={() => void action(() => edit(profile.id))}>{c.advanced}</button><p>{c.revision}</p></>}
      </>}
      {panel === "imports" && (!features.externalImport ? <p className="ios-server-note">{c.importsUnavailable}</p> : <>
        {!source && !guide && !preview && <><button className="primary" disabled={disabled} onClick={() => setGuide(true)}><Plus size={18} />{c.addImport}</button><div className="ios-library">{snapshots.map(item => <button key={item.id} disabled={disabled || item.locked} onClick={() => chooseSource(item)}>{item.locked ? <LockKeyhole size={20} /> : <BookOpen size={20} />}<span>{item.title}<small>{item.provider} · {item.messageCount}</small></span><ChevronRight size={17} /></button>)}</div>{snapshots.length < total && <button disabled={disabled} onClick={() => void action(async () => { const next = await workspace!.imports(snapshots.length); if (live.current) setSnapshots(rows => [...rows, ...next.conversations]); })}>{c.more}</button>}</>}
        {guide && !preview && <>{back}{importCapacity && <p>{c.importCapacity.replace("{count}", String(importCapacity.externalConversations)).replace("{mb}", String(Math.floor(importCapacity.normalizedTextBytes / 1048576)))}</p>}<h3>{c.addImport}</h3><div className="ios-provider-choices">{["chatgpt", "claude", "gemini"].map(value => <button key={value} aria-pressed={value === provider} disabled={busy} onClick={() => setProvider(value)}>{value === "chatgpt" ? "ChatGPT" : value === "claude" ? "Claude" : "Gemini"}</button>)}</div><p>{provider === "gemini" ? c.geminiGuide : c.exportGuide}</p><label className="ios-file-picker">{c.file}<input type="file" accept=".zip,.json,.html" disabled={disabled || !importCapacity || importCapacity.externalConversations < 1 || importCapacity.normalizedTextBytes < 1} onChange={event => { parse(event.target.files?.[0]); event.target.value = ""; }} /></label>{busy && <p role="status">{c.importing}</p>}</>}
        {preview && <>{back}<h3>{c.choose}</h3><p>{c.noAttachments}</p><ImportWarnings preview={preview} language={language} />{preview.conversations.map(row => <label className="ios-checkbox" key={row.conversation.rawExternalConversationId}><input type="checkbox" disabled={disabled || row.importability.kind !== "importable"} checked={selected.includes(row.conversation.rawExternalConversationId)} onChange={event => setSelected(ids => event.target.checked ? [...ids, row.conversation.rawExternalConversationId] : ids.filter(id => id !== row.conversation.rawExternalConversationId))} /><span>{row.conversation.title}<small>{row.conversation.messages.length}{row.importability.kind !== "importable" && ` · ${row.importability.kind === "not_importable" ? c.notImportable : c.truncated}`}</small></span></label>)}<button className="primary" disabled={disabled || !selected.length} onClick={() => void action(async () => { await workspace!.importText(provider, parsed.filter(row => selected.includes(row.rawExternalConversationId))); if (!live.current) return; setPreview(null); setGuide(false); setStatus(c.importDone); const list = await workspace!.imports(); if (live.current) { setSnapshots(list.conversations); setTotal(list.total); setContinuationEnabled(list.continuationEnabled); } }, true)}>{c.importSave}</button></>}
        {source && <>{back}<p className="ios-eyebrow">{source.provider} · {c.original}</p><h3>{source.title}</h3><p>{c.readOnly}</p><div className="ios-source-messages">{source.messages?.map(message => <article key={message.id}><small>{message.role === "user" ? "You" : source.provider}</small><AnswerContent content={message.content} transport={transport} language={language} /></article>)}</div>{continuationEnabled && !disclosure && <button className="primary" disabled={disabled} onClick={() => setDisclosure(true)}>{c.disclosure}</button>}{disclosure && <div className="ios-continuation-disclosure"><h3>{c.disclosure}</h3><p>{c.disclosureBody}</p><button className="primary" disabled={disabled} onClick={() => void action(async () => { const receipt = await workspace!.continue(source.id, continuationKey.current!.key); if (live.current) await onContinue(receipt.conversationId); }, true)}>{c.continue}</button></div>}<p>{memory ? memory.masterEnabled ? c.memoryOn : c.memoryOff : c.sourceUnavailable}</p><button disabled={disabled} onClick={() => setPanel("memory")}><Brain size={18} />{c.memory}</button></>}
      </>)}
    </div>
  </Sheet>;
}
