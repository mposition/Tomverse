import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ArrowRight, ArrowUp, ChevronDown, CodeXml, Ellipsis, FileSpreadsheet, FileText, Folder, FolderInput, ImagePlus, Lock, Paperclip, Plus, Search, SlidersHorizontal, Sparkles, Square } from "lucide-react";
import { chatHelpCopy } from "../../../../components/chat/chatHelpCopy";
import { continuationDisplayTitle } from "../../../../lib/continuationDisplayTitle";
import { millisecondsUntilNextDay, partitionConversationRows } from "../../../../lib/conversationListGrouping";
import { getPinOverrides, getServerPinOverrides, observeServerPins, reconcilePinStore, requestPin, subscribePinStore } from "../../../../lib/conversationPinStore";
import { CONVERSATION_TITLE_MAX_LENGTH, renameDecision } from "../../../../lib/conversationRename";
import { chatStarterCatalogFor } from "../../../../lib/chatStarterCatalog";
import { starterSeedMayWrite, type StarterSeedMemory } from "../../../../lib/chatStarterSeed";
import type { Language } from "../../../../lib/language";
import { getModel } from "../../../../lib/models";
import { de } from "../../../../locales/de";
import { desktopChatCopy } from "../../../../locales/desktopChat";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { en } from "../../../../locales/en";
import { es } from "../../../../locales/es";
import { fr } from "../../../../locales/fr";
import { ko } from "../../../../locales/ko";
import { mobileCopy } from "../../../../locales/mobile";
import { pt } from "../../../../locales/pt";
import { reviewHandoffCopy } from "../../../../locales/reviewHandoff";
import { workspaceWelcomeCopy } from "../../../../locales/workspaceWelcome";
import { zh } from "../../../../locales/zh";
import { zhHant } from "../../../../locales/zhHant";
import { reviewSeedFromChat } from "../../../../lib/chatReviewHandoff";
import { ChatDraftLocation, useChatDraftLocation } from "./ChatDraftLocation";
import { DraftDictation } from "./DraftDictation";
import { AnswerModel, ChatMarkdown, CopyAnswer, UserMessageContent } from "./ChatTranscript";
export { ChatMarkdown } from "./ChatTranscript";
import { AttachmentDraftStatus, AttachmentPicker, SavedAttachments, type DesktopAttachmentDraft } from "./AttachmentDraft";
import { GeneratedFiles } from "./GeneratedFiles";
import { HandoffDraft } from "./WorkspaceHandoff";
import { desktopPrivacyCopy } from "../../../../locales/desktopPrivacy";
import { readDesktopDraft, writeDesktopDraft } from "./draft-store";
import type { WorkspaceHandoff } from "../contract";
import type { AccountSettingsResult } from "../account-settings-contract";
import type {
  ChatConversation, ChatHistoryHit, ChatHistoryRow, ChatImportedSource, ChatModel, ChatStarter, ChatTurnInput, ChatTurnProgress, ChatTurnResult, DesktopTextProduct,
} from "../chat-contract";

type ChatNotice = keyof typeof desktopChatCopy.en | "contextChanged";
const statusNotice = {
  saved: null, partial: "partial", stopped: "stopped", failed: "failed", unconfirmed: "unconfirmed",
} as const satisfies Record<ChatTurnResult["status"], ChatNotice | null>;
const chatStarters = chatStarterCatalogFor("chat");
const starterIcons = new Map([
  ["debug-stack-trace", CodeXml],
  ["document-questions", FileText],
  ["spreadsheet-from-answer", FileSpreadsheet],
  ["make-an-image", ImagePlus],
]);
export const sidebarCopy = { de: de.sidebar, en: en.sidebar, es: es.sidebar, fr: fr.sidebar, ko: ko.sidebar,
  pt: pt.sidebar, zh: zh.sidebar, "zh-Hant": zhHant.sidebar };
const importedLabel = { de: de.journey.imported, en: en.journey.imported, es: es.journey.imported, fr: fr.journey.imported,
  ko: ko.journey.imported, pt: pt.journey.imported, zh: zh.journey.imported, "zh-Hant": zhHant.journey.imported };

function mergeChatMessages(previous: ChatConversation["messages"], incoming: ChatConversation["messages"]) {
  const messages = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((first, second) =>
    (first.createdAt ?? "").localeCompare(second.createdAt ?? "") || first.id.localeCompare(second.id));
}

export function useChatHistory(active: boolean, product: DesktopTextProduct, account: string | undefined, language: Language) {
  const [rows, setRows] = useState<ChatHistoryRow[]>([]);
  const pins = useSyncExternalStore(subscribePinStore, getPinOverrides, getServerPinOverrides);
  const [projects, setProjects] = useState<AccountSettingsResult<"projects">["projects"]>();
  const [projectRefresh, setProjectRefresh] = useState(0);
  const [searchResult, setSearchResult] = useState<{ query: string; hits: ChatHistoryHit[]; failed: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [listStatus, setListStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [selected, setSelected] = useState<ChatHistoryRow | null>(null);
  const [conversation, setConversation] = useState<ChatConversation | null>(null);
  const [notice, setNotice] = useState<ChatNotice | null>(null);
  const [opening, setOpening] = useState(false);
  const [writing, setWriting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraftValue] = useState("");
  const draftScope = useRef("new");
  const draftAccount = useRef(account);
  const [live, setLive] = useState<ChatTurnProgress | null>(null);
  const [sending, setSending] = useState(false);
  const sendingId = useRef<string | null>(null);
  const wasConnected = useRef(false);
  const openVersion = useRef(0);
  const listQuery = product === "chat" || searching ? query.trim() : "";
  const result = searchResult?.query === listQuery ? searchResult : null;
  const selectedRow = selected && (rows.find(row => row.id === selected.id) ?? selected);
  const selectedPinned = selectedRow && (pins[selectedRow.id] ?? selectedRow.pinned);

  function setDraft(value: string) {
    setDraftValue(value);
    writeDesktopDraft(draftAccount.current, `${product}:${draftScope.current}`, value);
  }

  function selectDraft(scope: string) {
    draftScope.current = scope;
    setDraftValue(readDesktopDraft(draftAccount.current, `${product}:${scope}`));
  }

  useEffect(() => {
    draftAccount.current = account;
    setDraftValue(readDesktopDraft(account, `${product}:${draftScope.current}`));
  }, [account, product]);

  useEffect(() => window.desktop.subscribe((snapshot) => {
    if (snapshot.account.stage === "connected") {
      wasConnected.current = true;
      return;
    }
    if (!wasConnected.current) return;
    wasConnected.current = false;
    reconcilePinStore("desktop-signed-out");
    openVersion.current++;
    setRows([]);
    setProjects(undefined);
    setSearchResult(null);
    setListStatus("loading");
    setQuery("");
    setSearching(false);
    setSelected(null);
    setConversation(null);
    setOpening(false);
    setWriting(false);
    setSending(false);
    draftScope.current = "new";
    draftAccount.current = undefined;
    setDraftValue("");
    setLive(null);
    sendingId.current = null;
    setNotice(null);
  }), []);

  useEffect(() => {
    if (!active) return;
    wasConnected.current = true;
    let current = true;
    void window.desktop.chatHistory(product).then((items) => {
      if (!current) return;
      if (account) {
        reconcilePinStore(account);
        observeServerPins(items);
      }
      setRows(items);
      setListStatus("ready");
    }, () => { if (current) setListStatus("failed"); });
    return () => { current = false; };
  }, [account, active, product, refresh]);
  useEffect(() => {
    if (!active || !account || product !== "chat") return;
    let current = true;
    void window.desktop.accountSettings<"projects">({ action: "projects" }).then(result => {
      if (current) setProjects(result.projects);
    }, () => {});
    return () => { current = false; };
  }, [account, active, product, projectRefresh]);
  useEffect(() => {
    if (!active) return;
    function reload() { setRefresh((value) => value + 1); }
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [active]);

  useEffect(() => {
    if (!active || listQuery.length < 2) return;
    let current = true;
    const timer = setTimeout(() => {
      void window.desktop.chatSearch(listQuery, product).then((items) => {
        if (current) setSearchResult({ query: listQuery, hits: items, failed: false });
      }, () => { if (current) setSearchResult({ query: listQuery, hits: [], failed: true }); });
    }, 280);
    return () => { current = false; clearTimeout(timer); };
  }, [active, product, listQuery]);

  useEffect(() => window.desktop.subscribeChat((change) => {
    if (sendingId.current !== change.requestId) return;
    if (change.savedPrompt !== undefined) {
      setDraftValue("");
      writeDesktopDraft(draftAccount.current, `${product}:${draftScope.current}`, "");
    }
    setLive((current) => ({ ...current, ...change }));
  }), [product]);

  async function open(row: ChatHistoryRow | null) {
    const request = ++openVersion.current;
    setSelected(row);
    setConversation(null);
    setLive(null);
    selectDraft(row?.id ?? "new");
    setOpening(Boolean(row && !row.isLocked));
    setNotice(row?.isLocked ? "unlockConversation" : null);
    if (!row || row.isLocked) return;
    try {
      const item = await window.desktop.chatConversation({ id: row.id, product });
      if (openVersion.current === request) setConversation(item);
    } catch {
      if (openVersion.current === request) setNotice("conversationLoadFailure");
    } finally {
      if (openVersion.current === request) setOpening(false);
    }
  }

  async function more() {
    const cursor = conversation?.messagePage.nextCursor;
    if (!cursor || !conversation || opening) return;
    const request = ++openVersion.current;
    setOpening(true);
    setNotice(null);
    try {
      const page = await window.desktop.chatConversation({ id: conversation.id, cursor, product });
      if (openVersion.current === request) {
        setConversation({ ...page, messages: mergeChatMessages(conversation.messages, page.messages) });
      }
    } catch {
      if (openVersion.current === request) setNotice("messagesLoadFailure");
    } finally {
      if (openVersion.current === request) setOpening(false);
    }
  }

  async function rename(title: string, row = selectedRow) {
    if (!row || writing) return false;
    const decision = renameDecision({ initialValue: chatTitle(row, language), nextValue: title });
    if (decision.action !== "save") return decision.action === "none";
    const id = row.id;
    const request = openVersion.current;
    setWriting(true);
    setNotice(null);
    try {
      const updated = await window.desktop.renameChat({ id, title: decision.title });
      setRows((items) => items.map((row) => row.id === id ? { ...row, title: updated.title } : row));
      setSelected((row) => row?.id === id ? { ...row, title: updated.title } : row);
      setRefresh((value) => value + 1);
      return true;
    } catch {
      if (openVersion.current === request) setNotice("renameUnconfirmed");
      setRefresh((value) => value + 1);
      return false;
    } finally {
      setWriting(false);
    }
  }

  async function remove(row = selectedRow) {
    if (!row || writing) return;
    const id = row.id;
    const request = openVersion.current;
    setWriting(true);
    setNotice(null);
    try {
      if (await window.desktop.removeChat(id)) {
        writeDesktopDraft(draftAccount.current, `${product}:${id}`, "");
        setRows((items) => items.filter((row) => row.id !== id));
        if (selected?.id === id && openVersion.current === request) await open(null);
      }
    } catch {
      if (openVersion.current === request) setNotice("deleteUnconfirmed");
    } finally {
      setRefresh((value) => value + 1);
      setWriting(false);
    }
  }

  async function togglePin(row = selectedRow) {
    if (!account || !row) return;
    await requestPin({ id: row.id, identity: account, ownerId: null, seen: row,
      pinned: !(pins[row.id] ?? row.pinned), transport: ({ id, pinned, seq }) =>
        window.desktop.accountSettings<"pinConversation">({ action: "pinConversation", id, pinned, seq, accountScope: account }),
    });
    setRefresh(value => value + 1);
  }

  function refreshProjects() {
    setProjectRefresh(value => value + 1);
    setRefresh(value => value + 1);
  }

  async function moveToProject(projectId: string | null, target = selectedRow) {
    if (!target || target.isLocked || writing) return;
    setWriting(true);
    try {
      const result = await window.desktop.accountSettings<"moveToProject">({
        action: "moveToProject", id: target.id, projectId,
      });
      setRows(items => items.map(row => row.id === target.id ? { ...row, projectId: result.projectId } : row));
      setSelected(row => row?.id === target.id ? { ...row, projectId: result.projectId } : row);
    } finally {
      setWriting(false);
      refreshProjects();
    }
  }

  function applyConversation(saved: ChatConversation) {
    if (draftScope.current === "new") {
      const unsent = readDesktopDraft(draftAccount.current, `${product}:new`);
      if (unsent && !readDesktopDraft(draftAccount.current, `${product}:${saved.id}`)) {
        writeDesktopDraft(draftAccount.current, `${product}:${saved.id}`, unsent);
        writeDesktopDraft(draftAccount.current, `${product}:new`, "");
      }
    }
    selectDraft(saved.id);
    setSelected(saved);
    setConversation((previous) => previous?.id === saved.id
      ? { ...saved, messages: mergeChatMessages(previous.messages, saved.messages), messagePage: previous.messagePage }
      : saved);
    setRefresh((value) => value + 1);
  }

  async function send(input: Omit<ChatTurnInput, "requestId" | "conversationId" | "prompt">) {
    if (writing || sendingId.current || (!draft.trim() && !input.attachmentUploadIds?.length && !input.handoffId) || (selected && !conversation)) return false;
    const requestId = crypto.randomUUID();
    const previous = conversation;
    sendingId.current = requestId;
    setSending(true);
    setLive(null);
    setNotice(null);
    try {
      const result = await window.desktop.sendChat({ ...input, prompt: draft, requestId, conversationId: previous?.id });
      if (sendingId.current !== requestId) return false;
      if (result.savedQuestion) setDraft("");
      if (result.conversation) applyConversation(result.conversation);
      setLive(result.partial && result.conversation ? {
        requestId, conversationId: result.conversation.id, text: result.partial, modelId: result.modelId, applied: result.applied,
      } : null);
      setNotice(result.contextChanged ? "contextChanged" : statusNotice[result.status]);
      if (!result.conversation) setRefresh((value) => value + 1);
      return result.savedQuestion;
    } catch {
      if (sendingId.current === requestId) setNotice(statusNotice.failed);
      return false;
    } finally {
      if (sendingId.current === requestId) {
        sendingId.current = null;
        setSending(false);
      }
    }
  }

  return { account, rows: rows.map(row => pins[row.id] === undefined ? row : { ...row, pinned: pins[row.id] }),
    hits: result?.hits ?? [], query, setQuery, searching, setSearching, listStatus, searchFailed: result?.failed === true, listQuery,
    selected: selectedRow && { ...selectedRow, pinned: selectedPinned ?? undefined },
    conversation, language,
    notice: notice === "contextChanged" ? desktopPrivacyCopy(language).contextChanged : notice ? desktopChatCopy[language][notice] : "",
    opening, writing, open, more, rename, remove, togglePin, applyConversation, projects, refreshProjects, moveToProject,
    draft, setDraft, newDraft: () => readDesktopDraft(draftAccount.current, `${product}:new`),
    sending, send, live, reload: () => setRefresh((value) => value + 1) };
}

type History = ReturnType<typeof useChatHistory>;

export function ChatHistorySearch({ chat }: { chat: History }) {
  return <button type="button" className="icon" aria-label={desktopChatCopy[chat.language].searchConversations} aria-expanded={chat.searching}
    onClick={() => chat.setSearching(!chat.searching)}><Search size={18} /></button>;
}

export function ChatHistory({ chat, product = "chat", busy = false, canModify = false, onImages, onImport }: {
  chat: History; product?: DesktopTextProduct; busy?: boolean; canModify?: boolean; onImages?: () => void; onImport?: () => void;
}) {
  const { language } = chat;
  const copy = desktopChatCopy[language];
  const sidebar = sidebarCopy[language];
  const help = chatHelpCopy[language];
  const [expanded, setExpanded] = useState(false);
  const [requestedFilter, setFilter] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string>();
  const [day, setDay] = useState(() => new Date());
  useEffect(() => {
    const timer = setTimeout(() => setDay(new Date()), millisecondsUntilNextDay({ now: day }));
    return () => clearTimeout(timer);
  }, [day]);
  const statusFilters = [
    { id: "locked", label: help.lockedFilter, matches: (row: ChatHistoryRow) => row.isLocked === true },
    { id: "shared", label: help.sharedFilter, matches: (row: ChatHistoryRow) => row.shareEnabled === true },
    { id: "comparison", label: sidebar.comparisonFilter, matches: (row: ChatHistoryRow) => (row.selectedModels?.length ?? 0) > 1 },
  ];
  const models = [...new Set(chat.rows.flatMap((row) => row.selectedModels ?? []))];
  const modelFilters = models.length < 2 ? [] : models.map((id) => ({
    id: `model:${id}`, label: getModel(id)?.name ?? id, matches: (row: ChatHistoryRow) => row.selectedModels?.includes(id) === true,
  })).sort((a, b) => a.label.localeCompare(b.label, language));
  const filter = [...statusFilters, ...modelFilters].find(({ id }) => id === requestedFilter);
  const projectId = chat.projects?.some(project => project.id === projectFilter) ? projectFilter : undefined;
  const filteredRows = chat.rows.filter(row => (!filter || filter.matches(row)) && (!projectId || row.projectId === projectId));
  const search = chat.listQuery.toLocaleLowerCase(language);
  const matching = filteredRows.filter((row) => !search || chatTitle(row, language).toLocaleLowerCase(language).includes(search));
  const byId = new Map(filteredRows.map((row) => [row.id, row]));
  const { pinned, groups } = partitionConversationRows(matching, { now: day });
  const dates = { today: sidebar.dateToday, yesterday: sidebar.dateYesterday,
    lastSevenDays: sidebar.dateLastSevenDays, older: sidebar.dateOlder };
  function historyButton(row: ChatHistoryRow, label = chatTitle(row, language), snippet?: string) {
    return <><button className="chat-history-title" type="button" disabled={busy || chat.sending || chat.writing} aria-current={chat.selected?.id === row.id ? "page" : undefined}
      title={label} onClick={() => void chat.open(row)}>
      {row.isLocked && <Lock size={13} aria-label={copy.locked} />}<span>{label}</span>
      {!snippet && (row.selectedModels?.length ?? 0) > 1 && <span className="chat-history-badge">
        {sidebar.modelCount.replace("{count}", String(row.selectedModels?.length))}</span>}
      {snippet && <small>{snippet}</small>}
    </button>{product === "chat" && <ChatConversationActions chat={chat} row={row} canModify={canModify} />}</>;
  }
  function group(title: string, rows: ChatHistoryRow[]) {
    if (!rows.length) return null;
    return <section key={title} className="chat-history-group" aria-label={title}>
      <h2>{title}</h2>
      <ul>{rows.map((row) => <li key={row.id}>{historyButton(row)}</li>)}</ul>
    </section>;
  }
  function filterButton(option: (typeof statusFilters)[number]) {
    return <button key={option.id} className="soft" type="button" aria-pressed={filter?.id === option.id}
      onClick={() => setFilter(filter?.id === option.id ? null : option.id)}>{option.label}</button>;
  }
  const hits = chat.hits.filter((hit) => byId.has(hit.conversationId));
  return <>
    <div className="chat-new-launcher">
      <button className="soft new-task" type="button" disabled={busy || chat.sending || chat.writing}
        onClick={() => void chat.open(null).then(() => requestAnimationFrame(() => {
          document.getElementById(`${product}-draft-input`)?.focus();
        }))}><Plus size={14} /> {product === "review" ? copy.newReview : mobileCopy[language].newChat}</button>
      {onImages && <button className="soft chat-new-image" type="button"
        aria-label={copy.imageWorkspace} title={copy.imageWorkspace} onClick={onImages}><ImagePlus size={16} aria-hidden="true" /></button>}
    </div>
    {onImport && <button type="button" className="chat-history-import" onClick={onImport}>
      <Folder size={15} aria-hidden="true" /> {importedLabel[language]}
    </button>}
    {(product === "chat" || chat.searching) && <label className="chat-history-search">
      <Search size={15} aria-hidden="true" />
      <input type="search" autoFocus={product === "review"} className="history-search" aria-label={copy.searchHistory}
        placeholder={sidebar.searchPlaceholder} value={chat.query} maxLength={80} onChange={(event) => chat.setQuery(event.currentTarget.value)} />
    </label>}
    {(product === "chat" || chat.rows.length > 0) && <div className="chat-organizer">
      <button type="button" className="chat-organizer-toggle" aria-expanded={expanded} aria-controls={`${product}-history-filters`}
        onClick={() => setExpanded(!expanded)}>
        <SlidersHorizontal size={16} aria-hidden="true" />
        <span><strong>{sidebar.organizerTools}</strong><small>{filter?.label ?? sidebar.organizerNoFilter}</small></span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div id={`${product}-history-filters`} className="chat-organizer-filters" hidden={!expanded}>
        <div role="group" aria-label={sidebar.conversationStates}>{statusFilters.map(filterButton)}</div>
        {modelFilters.length > 0 && <div role="group" aria-label={sidebar.modelFilterTitle}>{modelFilters.map(filterButton)}</div>}
        {product === "chat" && chat.projects && <ConversationProjects chat={chat} active={projectId} select={setProjectFilter} />}
      </div>
    </div>}
    <div className="projects chat-history">
      {chat.listStatus === "loading" && !chat.rows.length && <p role="status">{copy.loadingConversations}</p>}
      {chat.listStatus === "failed" && <button className="soft" type="button" onClick={chat.reload}>{copy.retryHistory}</button>}
      {chat.listStatus === "ready" && !chat.rows.length && <p>{copy.emptyHistory}</p>}
      {chat.listStatus === "ready" && chat.rows.length > 0 && matching.length === 0 && hits.length === 0 &&
        <p>{sidebar.noConversations}</p>}
      {group(sidebar.pinnedSection, pinned.sort((first, second) => (second.pinSeq ?? 0) - (first.pinSeq ?? 0)))}
      {filter || search ? <ul>{matching.filter((row) => !row.pinned).map((row) => <li key={row.id}>{historyButton(row)}</li>)}</ul>
        : groups.map(({ bucket, conversations }) => group(dates[bucket], conversations))}
      {hits.length > 0 && <section className="chat-history-group" aria-label={copy.matching}>
        <h2>{copy.matching}</h2>
        <ul>{hits.map((hit) => <li key={hit.id}>{historyButton(byId.get(hit.conversationId)!, hit.conversationTitle, hit.snippet)}</li>)}</ul>
      </section>}
      {chat.searchFailed && <p role="status">{copy.searchUnavailable}</p>}
    </div>
  </>;
}

function ConversationProjects({ chat, active, select }: { chat: History; active?: string; select(id?: string): void }) {
  const copy = sidebarCopy[chat.language];
  const common = reviewHandoffCopy[chat.language === "zh-Hant" ? "zhHant" : chat.language];
  const addLabel = chat.projects?.length ? copy.newProject : chatHelpCopy[chat.language].createProject;
  const [form, setForm] = useState<{ id?: string; name: string }>();
  const [remove, setRemove] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsReload, setNeedsReload] = useState(false);
  async function write(action: () => Promise<unknown>, failure: string) {
    if (busy || needsReload) return;
    setBusy(true); setError("");
    try {
      await action();
      setForm(undefined); setRemove(undefined);
    } catch {
      setError(failure);
      setNeedsReload(true);
    } finally {
      setBusy(false);
      chat.refreshProjects();
    }
  }
  return <details className="chat-history-projects">
    <summary>{copy.projects}</summary>
    <div aria-label={copy.projects}>
      {chat.projects?.map(project => <div key={project.id} className="chat-project-row">
        <button className="soft" type="button" aria-pressed={active === project.id} onClick={() => select(active === project.id ? undefined : project.id)}>
          {project.name}
        </button>
        <button className="soft" type="button" title={copy.renameProject} aria-label={copy.renameProject + " · " + project.name}
          disabled={busy} onClick={() => { setRemove(undefined); setForm(project); }}>✎</button>
        <button className="soft" type="button" title={copy.deleteProject} aria-label={copy.deleteProject + " · " + project.name} disabled={busy}
          onClick={() => { setForm(undefined); setRemove(project.id); }}>×</button>
        {remove === project.id && <div className="chat-project-confirm">
          <p>{copy.projectDeleteConfirm}</p>
          <button className="soft" type="button" disabled={busy} onClick={() => setRemove(undefined)}>{common.cancel}</button>
          <button className="soft" type="button" disabled={busy || needsReload} onClick={() => {
            void write(() => window.desktop.accountSettings<"removeProject">({ action: "removeProject", id: project.id }), copy.projectDeleteFailed);
          }}>{copy.deleteProjectArmed.replace("{project}", project.name)}</button>
        </div>}
      </div>)}
      {form ? <form className="chat-project-form" onSubmit={event => {
        event.preventDefault();
        if (!form.name.trim()) return;
        void write(() => form.id
          ? window.desktop.accountSettings<"renameProject">({ action: "renameProject", id: form.id, name: form.name })
          : window.desktop.accountSettings<"addProject">({ action: "addProject", name: form.name }), copy.projectRenameFailed);
      }}>
        <input autoFocus className="history-search" aria-label={copy.projectNamePlaceholder} required maxLength={32} value={form.name}
          onChange={event => setForm({ ...form, name: event.currentTarget.value })} />
        <button className="soft" type="button" disabled={busy} onClick={() => setForm(undefined)}>{common.cancel}</button>
        <button className="primary" type="submit" disabled={busy || needsReload || !form.name.trim()}>
          {form.id ? copy.renameProject : addLabel}
        </button>
      </form> : <button className="soft" type="button" disabled={busy} onClick={() => { setRemove(undefined); setForm({ name: "" }); }}>
        {addLabel}
      </button>}
      {error && <p role="alert">{error}</p>}
      {needsReload && <button className="soft" type="button" onClick={() => {
        setNeedsReload(false); setForm(undefined); setRemove(undefined); setError(""); chat.refreshProjects();
      }}>{desktopChatCopy[chat.language].retryHistory}</button>}
    </div>
  </details>;
}

export function chatTitle(row: ChatHistoryRow, language: Language) {
  return continuationDisplayTitle({ storedTitle: row.title || mobileCopy[language].newChat, isContinuation: row.surface === "continuation",
    sourceTitle: row.sourceTitle, fallback: desktopChatCopy[language].continuedChat });
}

export function ChatConversationActions({ chat, row, canModify = true }: { chat: History; row?: ChatHistoryRow; canModify?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [projectError, setProjectError] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const { language } = chat;
  const copy = desktopChatCopy[language];
  const handoff = reviewHandoffCopy[language === "zh-Hant" ? "zhHant" : language];
  const selected = row ?? chat.selected;
  if (!selected) return null;
  return <details ref={menu} className={row ? "chat-conversation-actions chat-row-actions" : "chat-conversation-actions"}>
    <summary className="icon" aria-label={row ? `${copy.conversationActions} · ${chatTitle(row, language)}` : copy.conversationActions}>
      <Ellipsis size={row ? 15 : 18} aria-hidden="true" />
    </summary>
    <div className="chat-action-menu">
      {draft === null ? <>
        <button type="button" disabled={chat.writing || chat.sending} onClick={() => { void chat.togglePin(selected); }}>
          {selected.pinned ? sidebarCopy[language].unpinChat : sidebarCopy[language].pinChat}
        </button>
        {canModify && !selected.isLocked && <><button type="button" disabled={chat.writing || chat.sending}
          onClick={() => setDraft(chatTitle(selected, language))}>{copy.rename}</button>
        <button type="button" disabled={chat.writing || chat.sending} onClick={() => {
          if (menu.current) menu.current.open = false;
          void chat.remove(selected).finally(() => menu.current?.querySelector("summary")?.focus());
        }}>{copy.deleteConversation}</button></>}
        {canModify && !selected.isLocked && !!chat.projects?.length && <label className="chat-project-move">
          {sidebarCopy[language].moveToProject}
          <select aria-label={sidebarCopy[language].moveToProject} value={selected.projectId ?? ""} disabled={chat.writing || chat.sending} onChange={event => {
            setProjectError(false);
            void chat.moveToProject(event.currentTarget.value || null, selected).catch(() => setProjectError(true));
          }}>
            <option value="">{sidebarCopy[language].uncategorizedProject}</option>
            {chat.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>}
        {projectError && <p role="alert">{desktopShellCopy[language].actionFailed}</p>}
      </> : <form onSubmit={(event) => {
        event.preventDefault();
        void chat.rename(draft, selected).then((saved) => {
          if (!saved) return;
          setDraft(null);
          if (menu.current) menu.current.open = false;
        });
      }}>
        <input className="history-search" autoFocus aria-label={copy.conversationName} value={draft}
          maxLength={CONVERSATION_TITLE_MAX_LENGTH} onChange={(event) => setDraft(event.currentTarget.value)} />
        <button className="soft" type="button" onClick={() => setDraft(null)}>{handoff.cancel}</button>
        <button className="primary" type="submit" disabled={!draft.trim() || chat.writing}>{copy.saveName}</button>
      </form>}
    </div>
  </details>;
}

export function ImportedSource({ id, language }: { id: string; language: Language }) {
  const copy = desktopChatCopy[language];
  const [timeline, setTimeline] = useState<ChatImportedSource | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState<number>();
  useEffect(() => {
    let current = true;
    void window.desktop.chatImportedSource({ id, offset }).then((page) => {
      if (!current) return;
      setTimeline((previous) => {
        if (previous?.source.status !== "available" || page.source.status !== "available") return page;
        const older = page.source.messages ?? [];
        const loaded = new Set(older.map((message) => message.id));
        return { ...page, source: { ...page.source, messages: [...older,
          ...(previous.source.messages ?? []).filter((message) => !loaded.has(message.id))] } };
      });
    }, () => { if (current) setError(true); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [id, offset]);

  const source = timeline?.source;
  return <section className="chat-imported-source" aria-label={copy.importedConversation}>
    <h3>{copy.importedConversation}{timeline && ` · ${timeline.provider}`}</h3>
    {loading && <p role="status">{copy.loadingImported}</p>}
    {error && <button className="soft" type="button" onClick={() => void window.desktop.openChatContinuation(id)}>{copy.openImportedWeb}</button>}
    {source?.status === "deleted" && <p>{copy.deletedImported}</p>}
    {source?.status === "locked" && <button className="soft" type="button"
      onClick={() => void window.desktop.openChatContinuation(id)}>{copy.unlockImportedWeb}</button>}
    {source?.status === "available" && <>
      {(source.offset ?? 0) > 0 && <button className="soft" type="button" disabled={loading} onClick={() => {
        setLoading(true);
        setError(false);
        setOffset(Math.max(0, (source.offset ?? 0) - 50));
      }}>{copy.earlierImported}</button>}
      <ol className="thread chat-thread">
        {source.messages?.filter((message) => message.role === "user" || message.role === "assistant").map((message) =>
          <li className={`entry entry--${message.role}`} key={message.id}><ChatMarkdown content={message.content} /></li>)}
      </ol>
    </>}
    <p className="chat-continuation-divider">{copy.continued}</p>
  </section>;
}

export function ChatWorkspace({ chat, chatWrite, autoOffered, onImport, onCompare, preferredModelId, starters, attachments, online, handoff, deviceFixture }: {
  chat: History; chatWrite: boolean; autoOffered: boolean; onImport?: () => void; onCompare?: (prompt: string, continuationId?: string) => void; starters?: ChatStarter[];
  preferredModelId?: string;
  attachments: DesktopAttachmentDraft;
  online: boolean;
  handoff?: WorkspaceHandoff;
  deviceFixture: boolean;
}) {
  const { language } = chat;
  const copy = desktopChatCopy[language];
  const shellCopy = desktopShellCopy[language];
  const effortLabels = { default: shellCopy.defaultEffort, low: shellCopy.lowEffort, high: shellCopy.highEffort };
  const starterCopy = workspaceWelcomeCopy[language].starter;
  const [models, setModels] = useState<ChatModel[]>([]);
  const [modelError, setModelError] = useState(false);
  const [picker, setPicker] = useState<{ id: string; mode: "auto" | "manual"; conversation?: string }>();
  const [effort, setEffort] = useState<ChatTurnInput["effort"]>("default");
  const activeId = chat.selected?.id;
  const location = useChatDraftLocation((chat.account ?? "") + ":" + (activeId ?? "new"));
  const draftExcerpt = activeId ? undefined : handoff;
  const availableAuto = chat.conversation?.autoSelection.offered ?? (!activeId && autoOffered);
  const currentPicker = picker?.conversation === activeId ? picker : undefined;
  const selectedModel = models.find(({ id }) => id === (currentPicker?.id ?? chat.conversation?.selectedModels[0] ?? (!activeId ? preferredModelId : undefined)))
    ?? models.find(({ id }) => id === "gpt-6-luna") ?? models[0];
  const mode = availableAuto ? currentPicker?.mode ?? chat.conversation?.selectionMode ?? "auto" : "manual";
  const effortEnabled = models.some((model) => model.reasoningEfforts !== undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const lastSeed = useRef<StarterSeedMemory | null>(null);
  const nearBottom = useRef(true);

  useEffect(() => {
    if (!chatWrite) return;
    let alive = true;
    let pending = false;
    function loadModels() {
      if (pending) return;
      pending = true;
      void window.desktop.chatModels().then((items) => {
        if (alive) { setModels(items); setModelError(!items.length); }
      }, () => { if (alive) setModelError(true); }).finally(() => { pending = false; });
    }
    loadModels();
    window.addEventListener("focus", loadModels);
    return () => { alive = false; window.removeEventListener("focus", loadModels); };
  }, [chat.account, chatWrite]);
  useLayoutEffect(() => {
    if (scroll.current && nearBottom.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [chat.live, chat.conversation]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chatWrite || !online || !selectedModel || (!chat.draft.trim() && !attachments.files.length && !draftExcerpt) || chat.sending || chat.writing) return;
    const attachmentUploadIds = await attachments.prepare();
    if (!attachmentUploadIds) return;
    const saved = await chat.send({ modelId: selectedModel.id, selectionMode: mode, effort: effortEnabled ? effort : "default", attachmentUploadIds,
      handoffId: draftExcerpt?.id, currentLocation: location.current() });
    location.remove();
    if (saved) attachments.clear();
  }

  const live = chat.live;
  const currentMessages = chat.conversation?.messages.flatMap((message) => {
    const { role } = message;
    return role === "user" || role === "assistant" ? [{ ...message, role } as const] : [];
  }) ?? [];
  const showComposer = !chat.selected?.isLocked && (!activeId || Boolean(chat.conversation));
  const actualModels = new Map(chat.conversation?.responseAttempts?.flatMap(({ assistantMessageId, actualModelId, provider }) =>
    assistantMessageId && actualModelId ? [[assistantMessageId, { id: actualModelId, provider }] as const] : []));
  return <div className="desktop-chat-workspace" data-thread={Boolean(chat.conversation || chat.sending)}>
    <div className="scroll" ref={scroll} onScroll={(event) => {
      const pane = event.currentTarget;
      nearBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 64;
    }}>
    <div className="content chat-content">
      {!chat.selected && !chat.sending && <section className="welcome chat-welcome">
        <h2>{copy.welcome}<br />{copy.welcomeHelp}</h2>
        {onImport && <button className="chat-import" type="button" onClick={onImport}>
          <FolderInput size={20} aria-hidden="true" /><span><strong>{copy.continueImported}</strong>
            <small>{copy.importDescription}</small></span><ArrowRight size={18} />
        </button>}
        {!!starters?.length && <section className="chat-starters" aria-label={copy.starterSuggestions}>
          <p>{starterCopy.hint}</p>
          <ul>{starters.map((item) => {
            const entry = chatStarters.find(({ id }) => id === item.id);
            const card = entry && language !== "en" ? starterCopy.cards[entry.labelKey.split(".")[2] as keyof typeof starterCopy.cards] ?? item : item;
            const descriptionId = `chat-starter-${item.id}-outcome`;
            const Icon = starterIcons.get(item.id) ?? Sparkles;
            const needsAttachment = entry?.seed.attachment === true;
            const openAttachment = chatWrite && needsAttachment && attachments.enabled;
            return <li key={item.id}>
              <button type="button" data-starter-id={item.id} onClick={() => {
                if (starterSeedMayWrite({ draft: chat.draft, memory: lastSeed.current })) {
                  chat.setDraft(card.seed);
                  lastSeed.current = { scope: "new", text: card.seed, restore: "off", applied: "off" };
                }
                composer.current?.focus();
                if (openAttachment) document.getElementById("chat-starter-attach")?.click();
              }} aria-describedby={descriptionId}><span className="chat-starter-icon"><Icon size={16} aria-hidden="true" /></span>
                <strong>{card.label}</strong>{openAttachment && <Paperclip size={13} aria-hidden="true" />}</button>
              <span id={descriptionId} hidden>{card.outcome}</span>
            </li>;
          })}</ul>
        </section>}
      </section>}
      {chat.opening && !chat.conversation && <p role="status">{copy.loadingConversation}</p>}
      {chat.notice && <p className="notice" role="status">{chat.notice}</p>}
      {chat.conversation?.surface === "continuation" && <ImportedSource key={chat.conversation.id} id={chat.conversation.id} language={language} />}
      {(chat.conversation || chat.sending || live) && <>
        <ol className={currentMessages.length > 40 ? "thread chat-thread long-thread" : "thread chat-thread"} aria-label={copy.transcript}>
          {currentMessages.map((message) => {
            const review = message.role === "assistant" && message.status === "normal"
              ? reviewSeedFromChat(currentMessages, message.id, copy.earlierQuestions) : null;
            return <li className={`entry entry--${message.role}`} key={message.id}>
              {message.role === "assistant" && <AnswerModel {...(actualModels.get(message.id) ?? { id: message.modelId })} />}
              <div className="chat-message-bubble">
                {message.role === "assistant" && <CopyAnswer content={message.content} language={language} />}
                <div data-handoff-content="chat">{message.role === "user"
                  ? <UserMessageContent content={message.content} language={language} /> : <ChatMarkdown content={message.content} language={language} />}</div>
                {message.role === "user" && <SavedAttachments message={message} language={language} />}
                <GeneratedFiles artifacts={message.artifacts} language={language} />
                {message.searchMetadata?.reasoningEffort && <small className="chat-effort">
                  {message.searchMetadata.reasoningEffort.applied && `${copy.reasoningEffort} · ${effortLabels[message.searchMetadata.reasoningEffort.applied]}`}
                  {message.searchMetadata.reasoningEffort.requested !== message.searchMetadata.reasoningEffort.applied &&
                    ` · ${copy.requested.replace("{effort}", effortLabels[message.searchMetadata.reasoningEffort.requested])}`}
                </small>}
                {message.role === "assistant" && message.memoryUsedCount && <small className="chat-effort">
                  {desktopPrivacyCopy(language).memoriesUsed.replace("{count}", message.memoryUsedCount.toLocaleString(language))}
                </small>}
                {review && chat.conversation && onCompare && <button className="chat-review-link" type="button" onClick={() =>
                  onCompare(review, chat.conversation?.surface === "continuation" ? chat.conversation.id : undefined)}>
                  {copy.compareReview}
                </button>}
              </div>
            </li>;
          })}
          {live?.savedPrompt && <li className="entry entry--user"><div className="chat-message-bubble">
            <UserMessageContent content={live.savedPrompt} language={language} />
          </div></li>}
          {live?.text && <li className="entry entry--assistant">
            <AnswerModel id={live.modelId} />
            <div className="chat-message-bubble"><ChatMarkdown content={live.text} language={language} />
            {live.applied && <small className="chat-effort">{copy.reasoningEffort} · {effortLabels[live.applied]}</small>}
            </div>
          </li>}
        </ol>
        {chat.sending && !live?.text && <p className="chat-effort" role="status">{copy.waiting}</p>}
        {chat.conversation?.messagePage.nextCursor && <button className="soft" type="button" disabled={chat.opening || chat.sending}
          onClick={() => void chat.more()}>{copy.loadMessages}</button>}
      </>}
    </div>
    </div>
    {showComposer && <div className="composer-slot chat-composer-slot">
      {!chatWrite && <p className="chat-compose-notice" role="status">{copy.sendUnavailable}</p>}
      {modelError && <p className="notice" role="alert">{copy.modelsUnavailable}</p>}
      <form className="composer chat-composer" onSubmit={submit} aria-label={copy.composer}>
        {draftExcerpt && <HandoffDraft handoff={draftExcerpt} busy={chat.sending} language={language} />}
        <AttachmentDraftStatus draft={attachments} busy={chat.sending} />
        <textarea ref={composer} id="chat-draft-input" aria-label={copy.message} value={chat.draft} disabled={chat.sending || attachments.uploading}
          onPaste={attachments.onPaste}
          placeholder={activeId ? copy.followUp : copy.ask}
          onChange={(event) => {
            lastSeed.current = null;
            chat.setDraft(event.currentTarget.value);
          }} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} />
        <div className="composer-actions">
          <AttachmentPicker draft={attachments} busy={chat.sending} id="chat-starter-attach" />
          <ChatDraftLocation location={location} language={language} draft={chat.draft} setDraft={chat.setDraft}
            deviceLocation={deviceFixture} disabled={chat.sending || attachments.uploading} />
          <span className="spacer" />
          <details className="model-menu">
            <summary aria-label={copy.modelEffort}>
              {mode === "auto" && <Sparkles size={15} />}
              {mode === "auto" ? "Smart Adaptive" : selectedModel?.name ?? shellCopy.model}
              {effortEnabled && effort !== "default" && ` · ${effortLabels[effort]}`} <ChevronDown size={15} />
            </summary>
            <div className="model-popover">
              <label>{shellCopy.model} <select aria-label={shellCopy.model} value={mode === "auto" ? "" : selectedModel?.id ?? ""} disabled={chat.sending || !selectedModel}
                onChange={(event) => setPicker({
                  id: event.currentTarget.value || selectedModel!.id,
                  mode: event.currentTarget.value ? "manual" : "auto", conversation: activeId,
                })}>
                {availableAuto && <option value="">Smart Adaptive</option>}
                {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select></label>
              {effortEnabled && <label>{copy.reasoningEffort} <select aria-label={copy.reasoningEffort} value={effort} disabled={chat.sending}
                onChange={(event) => setEffort(event.currentTarget.value as ChatTurnInput["effort"])}>
                {(["low", "default", "high"] as const).map((value) => <option key={value} value={value}>{effortLabels[value]}</option>)}
              </select></label>}
            </div>
          </details>
          {deviceFixture && <DraftDictation language={language} scope={"chat:" + (activeId ?? "new")}
            disabled={chat.sending || attachments.uploading} draft={chat.draft} setDraft={chat.setDraft} />}
          {chat.sending
            ? <button className="send stop" type="button" aria-label={copy.stop} onClick={() => void window.desktop.stopChat()}><Square size={17} /></button>
            : <button className="send" type="submit" aria-label={copy.send}
              disabled={!chatWrite || !online || !selectedModel || (!chat.draft.trim() && !attachments.files.length && !draftExcerpt) || chat.writing || attachments.uploading}><ArrowUp size={18} /></button>}
        </div>
      </form>
    </div>}
  </div>;
}
