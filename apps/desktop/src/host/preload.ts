import { contextBridge, ipcRenderer } from "electron";
import type { BrowserState, ElementPick } from "../browser-contract";
import type { WebViewState } from "../web-view-contract";
import type { TerminalEvent } from "../terminal-contract";
import type { DesktopApi, FollowUpTarget, Snapshot } from "../contract";
import type { BillingState } from "../billing-contract";
import type { ChatTurnProgress, DesktopTextProduct, ReviewTurnProgress } from "../chat-contract";
import type { DesktopLoginState, LoginApi } from "../login-contract";

const trustedWindow = location.pathname === "/approval";
if (trustedWindow) {
  contextBridge.exposeInMainWorld("approvalHost", {
    approval: () => ipcRenderer.invoke("approval:read"),
    decide: (input: Parameters<DesktopApi["decide"]>[0]) => ipcRenderer.invoke("approval:decide", input),
  } satisfies Pick<DesktopApi, "approval" | "decide">);
} else if (location.pathname === "/login") {
  contextBridge.exposeInMainWorld("loginHost", {
    state: () => ipcRenderer.invoke("login:state"),
    subscribe(listener: (state: DesktopLoginState) => void) {
      const onState = (_event: Electron.IpcRendererEvent, state: DesktopLoginState) => listener(state);
      ipcRenderer.on("login:changed", onState);
      return () => ipcRenderer.removeListener("login:changed", onState);
    },
    provider: (provider: Parameters<LoginApi["provider"]>[0]) => ipcRenderer.invoke("login:provider", provider),
    email: (input: Parameters<LoginApi["email"]>[0]) => ipcRenderer.invoke("login:email", input),
    cancel: () => ipcRenderer.invoke("login:cancel"),
    quit: () => ipcRenderer.invoke("login:quit"),
  } satisfies LoginApi);
} else {
  contextBridge.exposeInMainWorld("desktop", {
    state: () => ipcRenderer.invoke("desktop:state"),
    setLanguage: (language: Parameters<DesktopApi["setLanguage"]>[0]) => ipcRenderer.invoke("desktop:language", language),
    setCodeExecutionPreference: (mode: Parameters<DesktopApi["setCodeExecutionPreference"]>[0]) =>
      ipcRenderer.invoke("desktop:code-execution-preference", mode),
    updateCodeFallback: (input: Parameters<DesktopApi["updateCodeFallback"]>[0]) => ipcRenderer.invoke("desktop:update-code-fallback", input),
    chooseCliPath: (provider?: Parameters<DesktopApi["chooseCliPath"]>[0]) => ipcRenderer.invoke("desktop:choose-cli-path", provider),
    saveCliPath: (input: Parameters<DesktopApi["saveCliPath"]>[0]) => ipcRenderer.invoke("desktop:save-cli-path", input),
    removeCliPath: (provider: Parameters<DesktopApi["removeCliPath"]>[0]) => ipcRenderer.invoke("desktop:remove-cli-path", provider),
    checkCliAccount: (provider: Parameters<DesktopApi["checkCliAccount"]>[0]) => ipcRenderer.invoke("desktop:check-cli-account", provider),
    openCliAuthGuide: (provider: Parameters<DesktopApi["openCliAuthGuide"]>[0]) => ipcRenderer.invoke("desktop:open-cli-auth-guide", provider),
    checkCliProtocol: (provider: Parameters<DesktopApi["checkCliProtocol"]>[0]) => ipcRenderer.invoke("desktop:check-cli-protocol", provider),
    cancelCliCheck: (kind: Parameters<DesktopApi["cancelCliCheck"]>[0]) => ipcRenderer.invoke("desktop:cancel-cli-check", kind),
    subscribe(listener: (snapshot: Snapshot) => void) {
      const onState = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => listener(snapshot);
      ipcRenderer.on("desktop:changed", onState);
      return () => ipcRenderer.removeListener("desktop:changed", onState);
    },
    armChatLocation: () => ipcRenderer.invoke("desktop:location-arm"),
    armDictation: () => ipcRenderer.invoke("desktop:dictation-arm"),
    cancelDictation: (id: string) => ipcRenderer.invoke("desktop:dictation-cancel", id),
    transcribeDictation: (input: Parameters<DesktopApi["transcribeDictation"]>[0]) => ipcRenderer.invoke("desktop:dictation-transcribe", input),
    subscribeDictationStop(listener: () => void) {
      const onStop = () => listener();
      ipcRenderer.on("desktop:dictation-stop", onStop);
      return () => ipcRenderer.removeListener("desktop:dictation-stop", onStop);
    },
    taskPulls: (command: Parameters<DesktopApi["taskPulls"]>[0]) => ipcRenderer.invoke("desktop:task-pulls", command),
    codeBrowser: (command: Parameters<DesktopApi["codeBrowser"]>[0]) => ipcRenderer.invoke("desktop:code-browser", command),
    subscribeCodeBrowser(listener: (state: BrowserState) => void) {
      const onState = (_event: Electron.IpcRendererEvent, state: BrowserState) => listener(state);
      ipcRenderer.on("desktop:code-browser-state", onState);
      return () => ipcRenderer.removeListener("desktop:code-browser-state", onState);
    },
    subscribeCodeBrowserPick(listener: (pick: ElementPick) => void) {
      const onPick = (_event: Electron.IpcRendererEvent, pick: ElementPick) => listener(pick);
      ipcRenderer.on("desktop:code-browser-pick", onPick);
      return () => ipcRenderer.removeListener("desktop:code-browser-pick", onPick);
    },
    codeTerminal: (command: Parameters<DesktopApi["codeTerminal"]>[0]) => ipcRenderer.invoke("desktop:code-terminal", command),
    subscribeCodeTerminal(listener: (event: TerminalEvent) => void) {
      const onEvent = (_event: Electron.IpcRendererEvent, event: TerminalEvent) => listener(event);
      ipcRenderer.on("desktop:code-terminal-event", onEvent);
      return () => ipcRenderer.removeListener("desktop:code-terminal-event", onEvent);
    },
    webView: (command: Parameters<DesktopApi["webView"]>[0]) => ipcRenderer.invoke("desktop:web-view", command),
    subscribeWebView(listener: (state: WebViewState | null) => void) {
      const onState = (_event: Electron.IpcRendererEvent, state: WebViewState | null) => listener(state);
      ipcRenderer.on("desktop:web-view-state", onState);
      return () => ipcRenderer.removeListener("desktop:web-view-state", onState);
    },
    chooseRoot: () => ipcRenderer.invoke("desktop:choose-root"),
    retryCodeCatalog: () => ipcRenderer.invoke("desktop:retry-code-catalog"),
    chooseCodeReferences: (kind: Parameters<DesktopApi["chooseCodeReferences"]>[0]) => ipcRenderer.invoke("desktop:choose-code-references", kind),
    removeCodeReference: (id: string) => ipcRenderer.invoke("desktop:remove-code-reference", id),
    newTask: () => ipcRenderer.invoke("desktop:new-task"),
    confirmHandoff: (input: Parameters<DesktopApi["confirmHandoff"]>[0]) => ipcRenderer.invoke("desktop:confirm-handoff", input),
    removeHandoff: (id: string) => ipcRenderer.invoke("desktop:remove-handoff", id),
    start: (input: Parameters<DesktopApi["start"]>[0]) => ipcRenderer.invoke("desktop:start", input),
    stop: () => ipcRenderer.invoke("desktop:stop"),
    openHistory: (id: string) => ipcRenderer.invoke("desktop:history", id),
    deleteHistory: (id: string) => ipcRenderer.invoke("desktop:delete-history", id),
    moreHistory: () => ipcRenderer.invoke("desktop:more-history"),
    readChange: (id: string) => ipcRenderer.invoke("desktop:read-change", id),
    undoChange: (id: string) => ipcRenderer.invoke("desktop:undo-change", id),
    review: (input) => ipcRenderer.invoke("desktop:review", input),
    rewindTurn: (id: string, turn: number) => ipcRenderer.invoke("desktop:rewind-turn", { id, turn }),
    forkTurn: (id: string, turn: number) => ipcRenderer.invoke("desktop:fork-turn", { id, turn }),
    readCommand: (id: string) => ipcRenderer.invoke("desktop:read-command", id),
    checkRecovery: (id: string) => ipcRenderer.invoke("desktop:check-recovery", id),
    resume: (id: string) => ipcRenderer.invoke("desktop:resume", id),
    queueMessage: (id: string, operation: Parameters<DesktopApi["queueMessage"]>[1]) => ipcRenderer.invoke("desktop:queue", { id, operation }),
    compactTask: (id: string) => ipcRenderer.invoke("desktop:compact-task", id),
    stopBackground: (id: string, handle: string) => ipcRenderer.invoke("desktop:stop-background", { id, handle }),
    codeMemory: (input: Parameters<DesktopApi["codeMemory"]>[0]) => ipcRenderer.invoke("desktop:code-memory", input),
    codeExtensions: (input: Parameters<DesktopApi["codeExtensions"]>[0]) => ipcRenderer.invoke("desktop:code-extensions", input),
    followUp: (id: FollowUpTarget, text: string) => ipcRenderer.invoke("desktop:follow-up", { id, text }),
    exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics"),
    copyDiagnostics: () => ipcRenderer.invoke("desktop:copy-diagnostics"),
    accountSettings: (input: Parameters<DesktopApi["accountSettings"]>[0]) =>
      ipcRenderer.invoke("desktop:account-settings", input),
    accountData: (input: Parameters<DesktopApi["accountData"]>[0]) => ipcRenderer.invoke("desktop:account-data", input),
    assistantImport: (input: Parameters<DesktopApi["assistantImport"]>[0]) => ipcRenderer.invoke("desktop:assistant-import", input),
    billing: (input: Parameters<DesktopApi["billing"]>[0]) => ipcRenderer.invoke("desktop:billing", input),
    subscribeBilling(listener: (state: BillingState) => void) {
      const onState = (_event: Electron.IpcRendererEvent, state: BillingState) => listener(state);
      ipcRenderer.on("desktop:billing-state", onState);
      return () => ipcRenderer.removeListener("desktop:billing-state", onState);
    },
    chatExtras: (input: Parameters<DesktopApi["chatExtras"]>[0]) => ipcRenderer.invoke("desktop:chat-extras", input),
    exportReviewAnalysis: (input: Parameters<DesktopApi["exportReviewAnalysis"]>[0]) => ipcRenderer.invoke("desktop:review-export", input),
    projects: (input) => ipcRenderer.invoke("desktop:projects", input),
    research: (input) => ipcRenderer.invoke("desktop:research", input),
    checkUpdate: () => ipcRenderer.invoke("desktop:check-update"),
    installUpdate: () => ipcRenderer.invoke("desktop:install-update"),
    setProjectPermissionProfile: (profile: Parameters<DesktopApi["setProjectPermissionProfile"]>[0]) =>
      ipcRenderer.invoke("desktop:permission-profile", profile),
    permissions: (command: Parameters<DesktopApi["permissions"]>[0]) => ipcRenderer.invoke("desktop:permissions", command),
    setCodeNotifications: (enabled: boolean) => ipcRenderer.invoke("desktop:code-notifications", enabled),
    signIn: () => ipcRenderer.invoke("desktop:sign-in"),
    signOut: () => ipcRenderer.invoke("desktop:sign-out"),
    connectCopiedCodeKey: () => ipcRenderer.invoke("desktop:connect-copied-code-key"),
    cancelSignIn: () => ipcRenderer.invoke("desktop:cancel-sign-in"),
    pluginInventory: () => ipcRenderer.invoke("desktop:plugin-inventory"),
    connectorInventory: () => ipcRenderer.invoke("desktop:connector-inventory"),
    connectorAction: (input: Parameters<DesktopApi["connectorAction"]>[0]) => ipcRenderer.invoke("desktop:connector-action", input),
    chatHistory: (product?: DesktopTextProduct) => ipcRenderer.invoke("chat:history", product),
    chatSearch: (query: string, product?: DesktopTextProduct) => ipcRenderer.invoke("chat:search", { query, product }),
    chatConversation: (input: Parameters<DesktopApi["chatConversation"]>[0]) => ipcRenderer.invoke("chat:conversation", input),
    chatImportedSource: (input: Parameters<DesktopApi["chatImportedSource"]>[0]) => ipcRenderer.invoke("chat:imported-source", input),
    chatUnlockImportedSource: (input: Parameters<DesktopApi["chatUnlockImportedSource"]>[0]) => ipcRenderer.invoke("chat:unlock-imported-source", input),
    renameChat: (input: Parameters<DesktopApi["renameChat"]>[0]) => ipcRenderer.invoke("chat:rename", input),
    removeChat: (id: string) => ipcRenderer.invoke("chat:remove", id),
    chatModels: () => ipcRenderer.invoke("chat:models"),
    copyChatText: (text: string) => ipcRenderer.invoke("chat:copy-text", text),
    exportChat: (input) => ipcRenderer.invoke("chat:export", input),
    sendChat: (input: Parameters<DesktopApi["sendChat"]>[0]) => ipcRenderer.invoke("chat:send", input),
    stopChat: () => ipcRenderer.invoke("chat:stop"),
    subscribeChat(listener: (progress: ChatTurnProgress) => void) {
      const onProgress = (_event: Electron.IpcRendererEvent, progress: ChatTurnProgress) => listener(progress);
      ipcRenderer.on("chat:progress", onProgress);
      return () => ipcRenderer.removeListener("chat:progress", onProgress);
    },
    sendReview: (input: Parameters<DesktopApi["sendReview"]>[0]) => ipcRenderer.invoke("review:send", input),
    prepareReviewAnalysis: (id: string) => ipcRenderer.invoke("review:analysis-setup", id),
    runReviewAnalysis: (input) => ipcRenderer.invoke("review:analysis-run", input),
    subscribeReview(listener: (progress: ReviewTurnProgress) => void) {
      const onProgress = (_event: Electron.IpcRendererEvent, progress: ReviewTurnProgress) => listener(progress);
      ipcRenderer.on("review:progress", onProgress);
      return () => ipcRenderer.removeListener("review:progress", onProgress);
    },
    imageConversations: () => ipcRenderer.invoke("image:conversations"),
    imageHistory: (id: string) => ipcRenderer.invoke("image:history", id),
    imageGroup: (id: string) => ipcRenderer.invoke("image:group", id),
    generateImages: (input: Parameters<DesktopApi["generateImages"]>[0]) => ipcRenderer.invoke("image:generate", input),
    previewImage: (id: string) => ipcRenderer.invoke("image:preview", id),
    saveImage: (input: Parameters<DesktopApi["saveImage"]>[0]) => ipcRenderer.invoke("image:save", input),
    saveArtifact: (input: Parameters<DesktopApi["saveArtifact"]>[0]) => ipcRenderer.invoke("artifact:save", input),
    importDriveAttachments: (input: Parameters<DesktopApi["importDriveAttachments"]>[0]) => ipcRenderer.invoke("attachment:drive", input),
    checkDeepResearch: (id: string) => ipcRenderer.invoke("chat:research-status", id),
    uploadAttachment: (input: Parameters<DesktopApi["uploadAttachment"]>[0]) => ipcRenderer.invoke("attachment:upload", input),
    cancelAttachmentUpload: (requestId: string) => ipcRenderer.invoke("attachment:cancel", requestId),
    discardAttachment: (uploadId: string) => ipcRenderer.invoke("attachment:discard", uploadId),
  } satisfies Omit<DesktopApi, "approval" | "decide">);
}
