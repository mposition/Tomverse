import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "@/components/LanguageProvider";
import { StudioAnswerAnalysis } from "@/components/chat/StudioAnswerAnalysis";
import "@/components/chat/review-studio.css";

function Fixture() {
  const [revision, setRevision] = useState(0);
  const [identity, setIdentity] = useState("account-a");
  const [guest, setGuest] = useState(false);
  return <LanguageProvider initialLang="ko" forceInitialLang>
    <div data-review-appearance="studio" style={{ display: "grid", gridTemplateColumns: "72px 370px 1fr", gap: 20 }}>
      <nav style={{ background: "#151b2d", borderRadius: 24, color: "white", padding: "24px 12px" }}>T</nav>
      <aside style={{ padding: 24, background: "var(--review-surface)", borderRadius: 24 }}>
        <h1 style={{ fontSize: 25, fontWeight: 700, marginBottom: 32 }}>Review</h1><h2>무엇을 비교할까요?</h2>
        <textarea aria-label="질문" defaultValue="세 답변에서 배포 우선순위가 어떻게 다른가요?" style={{ width: "100%", height: 170, marginTop: 20, padding: 16, border: "1px solid #bcc5db", borderRadius: 18 }} />
        <StudioAnswerAnalysis enabled ready scope={JSON.stringify([identity, guest, revision])} conversationId="qa-conversation"
          identityKey={identity} isGuest={guest} access={guest ? { kind: "guestTrial", trialLimit: 2, trialRemaining: 1 } : { kind: "account" }}
          getGuestSource={() => ({ question: "Compare these approaches", language: "ko", responses: [{ messageId: "a", modelId: "a", content: `Answer ${revision}` }, { messageId: "b", modelId: "b", content: "Second answer" }] })} />
        <div style={{ marginTop: 100 }}><button onClick={() => setRevision((value) => value + 1)}>New answer</button><br />
          <button onClick={() => setIdentity((value) => value === "account-a" ? "account-b" : "account-a")}>Switch identity</button><br />
          <button onClick={() => setGuest(true)}>Guest mode</button></div>
      </aside>
      <main style={{ background: "var(--review-canvas)", borderRadius: 24, padding: 30 }}><h2 style={{ marginBottom: 24 }}>모델 답변</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>{["GPT", "Claude", "Gemini"].map((model) => <article key={model} style={{ background: "var(--review-surface)", borderRadius: 20, padding: 24, minHeight: 500 }}><h3>{model}</h3><p style={{ marginTop: 30 }}>원본 답변은 그대로 유지됩니다.</p></article>)}</div>
      </main>
    </div>
  </LanguageProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
