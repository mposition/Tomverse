import type { ComparisonReview, ReviewSetup } from "../packages/chat-core/src/review";

export type StudioAnalysisEntry = {
  phase: "checking" | "ready" | "running" | "done" | "error";
  setup?: ReviewSetup;
  review?: ComparisonReview;
  executionStarted?: boolean;
};

/** A terminal server refusal is distinct from an unknown network outcome. */
export class StudioAnalysisKnownFailure extends Error {}

/** Component-owned session. Dismissal and tabs never own or cancel a request. */
export class StudioAnswerAnalysisSession {
  private entries = new Map<string, StudioAnalysisEntry>();
  private preparations = new Map<string, Promise<ReviewSetup>>();
  private openings = new Map<string, Promise<void>>();
  private analyses = new Map<string, Promise<ComparisonReview>>();
  private listeners = new Set<() => void>();
  private version = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.version;
  get(scope: string) { return this.entries.get(scope); }
  private put(scope: string, value: StudioAnalysisEntry) {
    this.entries.set(scope, value);
    this.version++;
    this.listeners.forEach((listener) => listener());
  }
  prepare(scope: string, load: () => Promise<ReviewSetup>): Promise<ReviewSetup> {
    const pending = this.preparations.get(scope);
    if (pending) return pending;
    const entry = this.get(scope);
    if (entry?.setup && entry.phase !== "error") return Promise.resolve(entry.setup);
    this.put(scope, { phase: "checking" });
    const job = Promise.resolve().then(load).then((setup) => {
      this.put(scope, { setup, review: setup.storedReview, phase: setup.storedReview ? "done" : "ready" });
      return setup;
    }).catch((error) => {
      this.put(scope, { phase: "error" });
      throw error;
    }).finally(() => this.preparations.delete(scope));
    this.preparations.set(scope, job);
    return job;
  }
  open(
    scope: string,
    load: () => Promise<ReviewSetup>,
    execute: (setup: ReviewSetup, publish: (review: ComparisonReview) => void) => Promise<ComparisonReview>,
  ): Promise<void> {
    const pending = this.openings.get(scope);
    if (pending) return pending;
    if (this.get(scope)?.review) return Promise.resolve();
    const job = this.prepare(scope, load).then(async (setup) => {
      if (setup.storedReview) return;
      if (!setup.available || !setup.source || setup.source.responses.length < 2) {
        throw new Error("Analysis is unavailable");
      }
      // Include the actual question/answers, not just labels or a conversation id.
      // A changed answer must never reuse the old analysis. Identity is scoped
      // by the owner of this session; the server independently validates its hash.
      const input = JSON.stringify({ source: setup.source, prompt: setup.promptMessageId, ids: setup.assistantMessageIds });
      this.put(scope, { phase: "running", setup, executionStarted: true });
      let analysis = this.analyses.get(input);
      if (!analysis) {
        analysis = Promise.resolve().then(() => execute(setup, (review) => {
          // Useful output is visible immediately; only the final response is
          // saved/shareable. Dismissal keeps this component-owned request alive.
          this.put(scope, { phase: "running", setup, executionStarted: true, review: { ...review, persisted: false } });
        }));
        this.analyses.set(input, analysis);
        void analysis.catch(() => this.analyses.delete(input));
      }
      const review = await analysis;
      this.put(scope, { phase: "done", setup, review });
    }).catch((error) => {
      this.put(scope, { ...this.get(scope), phase: "error",
        executionStarted: error instanceof StudioAnalysisKnownFailure ? false : this.get(scope)?.executionStarted });
    }).finally(() => this.openings.delete(scope));
    this.openings.set(scope, job);
    return job;
  }

  /** An interrupted stream may still finish on the server. Never rerun it. */
  async recover(scope: string, load: () => Promise<ReviewSetup>) {
    const previous = this.get(scope);
    if (this.openings.has(scope)) return;
    this.put(scope, { ...previous, phase: "checking" });
    try {
      const setup = await load();
      this.put(scope, setup.storedReview
        ? { phase: "done", setup, review: setup.storedReview }
        : { ...previous, phase: "error" });
    } catch { this.put(scope, { ...previous, phase: "error" }); }
  }
}
