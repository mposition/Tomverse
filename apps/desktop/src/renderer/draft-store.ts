const drafts = new Map<string, string>();
const accountPrefix = (account: string) => `tomverse.desktopDraft:${account}:`;
const draftKey = (account: string, scope: string) => accountPrefix(account) + scope;

export function readDesktopDraft(account: string | undefined, scope: string) {
  if (!account) return "";
  const key = draftKey(account, scope);
  if (drafts.has(key)) return drafts.get(key) ?? "";
  try { return localStorage.getItem(key) ?? ""; }
  catch { return ""; }
}

export function writeDesktopDraft(account: string | undefined, scope: string, value: string) {
  if (!account) return;
  const key = draftKey(account, scope);
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
    drafts.delete(key);
  } catch {
    drafts.set(key, value);
  }
}

export function readCodeDraft(account: string | undefined, project: string) {
  const scope = `code:${project}`;
  const value = readDesktopDraft(account, scope);
  if (value || !account) return value;
  try {
    const legacyKey = `tomverse.draft:${project}`;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy) {
      writeDesktopDraft(account, scope, legacy);
      localStorage.removeItem(legacyKey);
    }
    return legacy ?? "";
  } catch {
    return "";
  }
}

export function clearDesktopDrafts(account: string) {
  const prefix = accountPrefix(account);
  for (const key of drafts.keys()) if (key.startsWith(prefix)) drafts.delete(key);
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // The renderer may be closing or storage may be unavailable.
  }
}
