// Defense against literal, split-part and separator-obfuscated credential
// echoes. Registered credential recipients still require operator trust; no
// textual filter can prevent an intentionally malicious peer's covert encoding.
export function containsMcpCredential(value: unknown, token: string | null): boolean {
  if (!token) return false;
  const strings: string[] = [], textParts: string[] = [], keys: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") { strings.push(v); return; }
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v && typeof v === "object") for (const [key, child] of Object.entries(v)) {
      keys.push(key);
      if (key === "text" && typeof child === "string") textParts.push(child);
      visit(child);
    }
  };
  visit(value);
  const joined = strings.join("") + textParts.join("") + keys.join("");
  if (joined.includes(token)) return true;
  const canonical = (text: string) => text.normalize("NFKC").replace(/[^A-Za-z0-9]/g, "");
  const secret = canonical(token), content = canonical(joined);
  if (secret && content.includes(secret)) return true;
  if (secret.length < 16) return false;
  return [0.25, 0.5, 0.75].some(fraction => {
    const start = Math.min(secret.length - 8, Math.floor(secret.length * fraction));
    return content.includes(secret.slice(start, start + 8));
  });
}
