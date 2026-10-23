import type { ChatTransport, Conversation } from "./chatTransport";

/** Synthetic transport. Imported only by the explicitly selected development demo. */
export function createDemoTransport(): ChatTransport {
  const key = "tomverse-native-synthetic-demo";
  let signedIn = localStorage.getItem(key + ":session") === "signed-in";
  const read = (): Conversation[] => JSON.parse(localStorage.getItem(key) ?? "[]");
  const write = (items: Conversation[]) => localStorage.setItem(key, JSON.stringify(items));
  return {
    account: async () => ({ id: "synthetic-demo", email: "demo@example.invalid", actionsEnabled: false }),
    exportAccount: async () => { throw Error("Demo only"); },
    deleteAccount: async () => { throw Error("Demo only"); },
    downloadArtifact: async () => {},
    session: async () => signedIn,
    signIn: async () => { signedIn = true; localStorage.setItem(key + ":session", "signed-in"); },
    signOut: async () => { signedIn = false; localStorage.removeItem(key + ":session"); localStorage.removeItem(key); },
    list: async () => read().map(({ id, title }) => ({ id, title })),
    load: async (id) => { const item = read().find((c) => c.id === id); if (!item) throw Error("Conversation unavailable"); return item; },
    create: async () => {
      const item: Conversation = { id: crypto.randomUUID(), title: "New chat", selectedModels: ["Demo"], messages: [] };
      write([item, ...read()]); return item;
    },
    models: async () => [{ id: "demo", name: "Local demo", provider: "Synthetic", minimumPlan: "Demo" }],
    capabilities: async () => ({ offered: false }),
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
      item.messages.push({ id: crypto.randomUUID(), role: "assistant", content: answer });
      write(read().map((c) => c.id === item.id ? item : c));
    },
    upload: async (file) => ({ uploadId: crypto.randomUUID(), key: "synthetic", name: file.name, mediaType: file.type, size: file.size }),
    transcribe: async () => "Hello, 안녕하세요. This is a synthetic voice transcript.",
  };
}
