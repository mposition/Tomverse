import { randomUUID } from "node:crypto";

/**
 * Injectable runtime ports for Research engine v2: the clock (so a 60-minute
 * logical run is tested without sleeping), private evidence storage, and the
 * model/search/fetch/funding adapters the executor calls. Production values
 * are installed by lib/researchEngineAdapters.ts; tests install fakes.
 */

export type ResearchClock = { now(): Date };
let clock: ResearchClock = { now: () => new Date() };
export const researchNow = () => clock.now();
export const setResearchClock = (next: ResearchClock | null) => { clock = next ?? { now: () => new Date() }; };

/** A controllable clock for tests. `advance` moves logical time only. */
export function createFakeResearchClock(start = new Date("2026-11-23T00:00:00.000Z")) {
  let current = start.getTime();
  return { now: () => new Date(current), advance: (ms: number) => { current += ms; }, set: (date: Date) => { current = date.getTime(); } };
}

/** Owner-scoped private storage for extracted evidence text. */
export type ResearchEvidenceStore = {
  put(key: string, text: string): Promise<void>;
  get(key: string, maxBytes: number): Promise<string>;
  delete(key: string): Promise<void>;
};

export const researchEvidenceObjectKey = (input: { userId: string; runId: string; versionId: string }) => {
  for (const part of [input.userId, input.runId, input.versionId]) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(part)) throw new Error("RESEARCH_EVIDENCE_KEY_INVALID");
  }
  return `research-evidence/${input.userId}/${input.runId}/${input.versionId}-${randomUUID()}.txt`;
};

export const researchEvidenceKeyOwner = (key: string) => /^research-evidence\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\//u.exec(key);

export function createMemoryEvidenceStore() {
  const objects = new Map<string, string>();
  const store: ResearchEvidenceStore & { objects: Map<string, string> } = {
    objects,
    async put(key, text) { objects.set(key, text); },
    async get(key, maxBytes) {
      const value = objects.get(key);
      if (value === undefined) throw new Error("RESEARCH_EVIDENCE_OBJECT_MISSING");
      if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error("RESEARCH_EVIDENCE_OBJECT_TOO_LARGE");
      return value;
    },
    async delete(key) { objects.delete(key); },
  };
  return store;
}

let evidenceStore: ResearchEvidenceStore | null = null;
export const setResearchEvidenceStore = (store: ResearchEvidenceStore | null) => { evidenceStore = store; };
export async function researchEvidenceStore(): Promise<ResearchEvidenceStore> {
  if (evidenceStore) return evidenceStore;
  const r2 = await import("./r2");
  evidenceStore = {
    put: (key, text) => r2.writeR2Object(key, Buffer.from(text, "utf8"), "text/plain; charset=utf-8"),
    get: async (key, maxBytes) => (await r2.readOwnR2ObjectBytes(key, { maxBytes })).toString("utf8"),
    delete: (key) => r2.deleteR2Object(key),
  };
  return evidenceStore;
}
