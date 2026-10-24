import type { ChatTransport, Conversation, UserPreferences, MemoryPreferences, HistoryProject, ChatSummary } from "./chatTransport";

/** Synthetic transport. Imported only by the explicitly selected development demo. */
export function createDemoTransport(): ChatTransport {
  const key = "tomverse-native-synthetic-demo";
  let signedIn = localStorage.getItem(key + ":session") === "signed-in";
  const read = (): Conversation[] => JSON.parse(localStorage.getItem(key) ?? "[]");
  const write = (items: Conversation[]) => localStorage.setItem(key, JSON.stringify(items));
  const projects = (): HistoryProject[] => JSON.parse(localStorage.getItem(key + ':projects') ?? '[]');
  const passwords = new Map<string, string>(); const unlocked = new Set<string>();
  const patch = async (id: string, data: object) => { write(read().map(item => item.id === id ? { ...item, ...data } : item)); };
  const catalog = [
    { id: "demo", name: "Local demo A", provider: "Synthetic A", minimumPlan: "Free" as const },
    { id: "demo-b", name: "Local demo B", provider: "Synthetic B", minimumPlan: "Free" as const },
    { id: "demo-c", name: "Local demo C", provider: "Synthetic C", minimumPlan: "Free" as const },
  ];
  const preferences = (): UserPreferences => JSON.parse(localStorage.getItem(key + ":preferences") ?? JSON.stringify({ theme: "system", language: "en", defaultModel: "demo", timeZone: "UTC", imageHandoffAutoGenerate: false, reviewEasyEffectiveProviders: ["Synthetic A", "Synthetic B", "Synthetic C"], reviewEasyProviderOptions: ["Synthetic A", "Synthetic B", "Synthetic C"], reviewEasyMaxProviders: 3 }));
  const memory = (): MemoryPreferences => JSON.parse(localStorage.getItem(key + ":memory") ?? JSON.stringify({ masterEnabled: true, styleEnabled: true, defaultConversationMode: "on" }));
  return {
    history: {
      projects: async () => projects(),
      saveProject: async (id, name) => { const rows = projects(); localStorage.setItem(key + ':projects', JSON.stringify(id ? rows.map(row => row.id === id ? { ...row, name } : row) : [...rows, { id: crypto.randomUUID(), name }])); },
      deleteProject: async id => { localStorage.setItem(key + ':projects', JSON.stringify(projects().filter(row => row.id !== id))); write(read().map(item => (item as ChatSummary).projectId === id ? { ...item, projectId: null } : item)); },
      search: async query => ({ results: read().filter(item => !(item as ChatSummary).isLocked || unlocked.has(item.id)).flatMap(item => item.messages.filter(message => message.content.toLowerCase().includes(query.toLowerCase())).map(message => ({ id: message.id, kind: 'native', conversationId: item.id, conversationTitle: item.title, snippet: message.content.slice(0, 180) }))), sourceSearch: 'ok' }),
      rename: (id, title) => patch(id, { title }), pin: (chat, pinned) => patch(chat.id, { pinned, pinSeq: Date.now() }), move: (id, projectId) => patch(id, { projectId }),
      share: async id => { await patch(id, { shareEnabled: true }); return { url: `https://tomverse.app/share/fixture-${id}` }; }, revokeShare: id => patch(id, { shareEnabled: false }),
      export: async (id, title, includeSource) => { const { saveMobileResponse } = await import('./fileSave'); await saveMobileResponse(new Response((includeSource ? 'Original fixture\n' : '') + read().find(item => item.id === id)!.messages.map(message => message.content).join('\n\n')), `${title}.txt`); },
      remove: async id => { write(read().filter(item => item.id !== id)); passwords.delete(id); unlocked.delete(id); },
      password: async (id, password, currentPassword) => { if (password === null && passwords.get(id) !== currentPassword) throw { status: 403 }; if (password) passwords.set(id, password); else passwords.delete(id); unlocked.delete(id); await patch(id, { isLocked: password !== null }); },
      unlock: async (id, password) => { if (passwords.get(id) !== password) throw { status: 403 }; unlocked.add(id); }, unlocked: id => unlocked.has(id),
    },
    mobileCapabilities: async () => ({ historyActions: true, historyFeatures: { sharing: true, downloads: true }, reviewEasy: true, maxModels: 3, assistants: true, plan: "Max" }),
    preferences: async () => preferences(),
    savePreferences: async input => { localStorage.setItem(key + ":preferences", JSON.stringify({ ...preferences(), ...input })); },
    memoryPreferences: async () => memory(),
    saveMemoryPreferences: async input => { localStorage.setItem(key + ":memory", JSON.stringify(input)); },
    assistants: async () => [{ id: "demo-assistant", name: "Synthetic writing assistant" }],
    configureTools: async (id, input) => { const items = read(); const item = items.find(value => value.id === id)!; Object.assign(item, input); write(items); return item; },
    listReview: async () => read().filter(item => item.surface === "workspace"),
    createReview: async models => { const item: Conversation = { id: crypto.randomUUID(), title: "New Review", selectedModels: models, selectionMode: "manual", surface: "workspace", messages: [] }; write([item, ...read()]); return item; },
    configureReview: async (id, models) => { const items = read(); const item = items.find(value => value.id === id)!; item.selectedModels = models; write(items); return item; },
    routeReview: async input => ({ kind: "text", preset: "standard", choices: input.providers.map(provider => ({ provider, modelId: catalog.find(model => model.provider === provider)?.id ?? null })) }),
    sendReview: async (conversation, text, files, signal, progress) => {
      const item = read().find(value => value.id === conversation.id)!;
      item.title = text.slice(0,48); item.messages.push({ id: crypto.randomUUID(), role: "user", content: text }); write(read().map(value => value.id === item.id ? item : value));
      await Promise.all(item.selectedModels.map(async modelId => {
        const answer = `## ${catalog.find(model => model.id === modelId)?.name}\n\nA synthetic perspective on “${text}”.\n\n- One saved question\n- An independent response\n- Restore this comparison after reopening the app`;
        for (let index=0;index<answer.length;index+=12) { if(signal.aborted) throw new DOMException("Stopped", "AbortError"); progress(modelId,answer.slice(0,index)); await new Promise(resolve=>setTimeout(resolve,15)); }
        progress(modelId,answer); item.messages.push({ id: crypto.randomUUID(), role: "assistant", modelId, content: answer, status: "normal" });
        write(read().map(value=>value.id===item.id?item:value));
      }));
      return { failedModelIds: [] };
    },
    usage: async () => ({ plan: "Max", usage: { creditsMonth: 25 }, limits: { creditsMonth: 100 } }),
    account: async () => ({ name: "Demo User", id: "synthetic-demo", email: "demo@example.invalid", actionsEnabled: false }),
    exportAccount: async () => { throw Error("Demo only"); },
    deleteAccount: async () => { throw Error("Demo only"); },
    downloadArtifact: async () => {},
    session: async () => signedIn,
    signIn: async () => { signedIn = true; localStorage.setItem(key + ":session", "signed-in"); },
    signOut: async () => { signedIn = false; localStorage.removeItem(key + ":session"); localStorage.removeItem(key); },
    list: async () => read().filter(item => item.surface !== "workspace"),
    load: async (id) => { const item = read().find((c) => c.id === id); if (!item) throw Error("Conversation unavailable"); return item; },
    create: async () => {
      const item: Conversation = { id: crypto.randomUUID(), title: "New chat", selectedModels: ["demo"], selectionMode: "auto", autoSelection: { offered: true }, surface: "chat", messages: [] };
      write([item, ...read()]); return item;
    },
    models: async () => catalog,
    capabilities: async () => ({ offered: true }),
    configure: async (id, modelId, auto) => {
      const items = read(); const item = items.find((c) => c.id === id)!;
      item.selectedModels = [modelId]; item.selectionMode = auto ? "auto" : "manual"; write(items); return item;
    },
    send: async (conversation, text, files, signal, progress) => {
      const item = read().find((c) => c.id === conversation.id)!;
      item.messages.push({ id: crypto.randomUUID(), role: "user", content: text, attachments: files.map((file) => ({ id: file.uploadId, uploadId: file.uploadId, name: file.name, mediaType: file.mediaType, size: file.size, kind: "file" })) });
      item.title = text.slice(0, 48) || files[0]?.name || item.title;
      write(read().map((c) => c.id === item.id ? item : c));
      const answer = `This is a local demo response to “${text}”.\n\nYour conversation is saved. You can ask a follow-up or reopen this app to continue.${files.length ? " A synthetic attachment was included." : ""}`;
      for (let i = 0; i <= answer.length; i += 8) {
        if (signal.aborted) throw new DOMException("Stopped", "AbortError");
        progress(answer.slice(0, i));
        await new Promise((resolve) => setTimeout(resolve, 18));
      }
      progress(answer);
      item.messages.push({ id: crypto.randomUUID(), role: "assistant", modelId: item.selectedModels[0], content: answer });
      write(read().map((c) => c.id === item.id ? item : c));
    },
    upload: async (file) => ({ uploadId: crypto.randomUUID(), key: "synthetic", name: file.name, mediaType: file.type, size: file.size }),
    transcribe: async () => "Hello, 안녕하세요. This is a synthetic voice transcript.",
  };
}
