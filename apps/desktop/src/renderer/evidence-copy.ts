import type { Language } from "../../../../lib/language";

export function formatEvidence(template: string, language: Language, values: Record<string, number | string>) {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
    const value = values[key];
    return typeof value === "number" ? value.toLocaleString(language) : value ?? placeholder;
  });
}
