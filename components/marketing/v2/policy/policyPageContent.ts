import type { Language } from "@/lib/language";
import { policyPageTranslations } from "./policyPageContent.i18n";

/**
 * Interface copy for the V2 policy pages (/safety, /privacy, /terms, /refund;
 * approved concept, owner 2026-11-20).
 *
 * None of this is policy text. What the documents say comes from
 * components/marketing/marketingInfoContent.ts (safety, terms, refund) and the
 * `privacyPolicy` locale bundles, and is rendered exactly as written there. The
 * safety page's diagram and examples only restate facts `infoPages.safety`
 * already states -- model access, usage limits and file checks; the provider
 * that writes an answer processes what it needs, and Auto chooses it; a locked
 * conversation needs its password to open, share or download, and locking does
 * not encrypt it or close an existing share link; a share link shows the text as
 * it was created, expires automatically and is deleted when sharing is turned
 * off -- and add no claim of their own.
 *
 * Korean is the source wording; English and the six other locales follow its
 * meaning. `{n}` is a number the page computes and `{privacy}` is replaced with
 * a link to the privacy policy.
 */
export type PolicyDocument = "safety" | "privacy" | "terms" | "refund";

export type PolicyPageCopy = {
  /** Breadcrumb label for the policy pages. */
  crumb: string;
  tabsLabel: string;
  tabs: Record<PolicyDocument, string>;
  /** Eyebrow of the privacy policy, which has none of its own. */
  privacyEyebrow: string;
  sectionCount: string;
  readingTime: string;
  jumpTo: string;
  contents: string;
  askSupport: string;
  support: string;
  motionOff: string;
  motionOn: string;
  providerSearch: { label: string; placeholder: string; empty: string; count: string };
  safety: {
    flowLabel: string;
    /** You, Tomverse, the AI provider, the answer. */
    flow: Array<{ k: string; title: string; note: string }>;
    guardChips: [string, string, string];
    flowNote: string;
    pillarsEyebrow: string;
    pillarsTitle: string;
    tryEyebrow: string;
    tryTitle: string;
    tryLabel: string;
    /** [title, one-line description] for the file, lock and share examples. */
    tryTabs: [[string, string], [string, string], [string, string]];
    file: { heading: string; rows: Array<[ext: string, name: string, note: string, verdict: string]> };
    lock: { heading: string; chat: [string, string, string]; veilTitle: string; veilNote: string; on: string; off: string; caveat: string };
    share: { heading: string; chat: [string, string]; on: string; off: string; linkTag: string; note: string };
    sampleNote: string;
    docsEyebrow: string;
    docsTitle: string;
    closing: [string, string];
    review: string;
  };
};

const ko: PolicyPageCopy = {
  crumb: "정책",
  tabsLabel: "정책 문서",
  tabs: { safety: "안전과 데이터 처리", privacy: "개인정보 처리방침", terms: "이용약관", refund: "환불 정책" },
  privacyEyebrow: "개인정보",
  sectionCount: "조항 {n}개",
  readingTime: "읽는 시간 약 {n}분",
  jumpTo: "조항 바로가기",
  contents: "목차",
  askSupport: "궁금한 점은 지원팀에 문의해 주세요.",
  support: "고객 지원",
  motionOff: "애니메이션 멈추기",
  motionOn: "애니메이션 다시 재생",
  providerSearch: {
    label: "공급자 찾기",
    placeholder: "공급자나 국가로 찾기",
    empty: "찾는 공급자가 표에 없습니다.",
    count: "공급자 {n}곳 표시 중",
  },
  safety: {
    flowLabel: "질문이 답변이 되기까지",
    flow: [
      { k: "나", title: "질문과 자료", note: "보내는 질문과 답변에 필요한 자료" },
      { k: "Tomverse", title: "보호 기능", note: "사용할 수 있는 기능과 제한을 안내합니다" },
      { k: "AI 공급자", title: "답변을 만드는 공급자", note: "답변에 필요한 질문과 자료를 처리합니다. Auto를 쓰면 Tomverse가 공급자를 고릅니다." },
      { k: "답변", title: "원문과 출처로 확인", note: "틀리거나 빠진 내용이 있을 수 있습니다" },
    ],
    guardChips: ["모델 이용 범위", "사용량", "파일 형식·용량 검사"],
    flowNote: "공급자와 국가, 보관과 삭제는 {privacy}에서 확인하세요.",
    pillarsEyebrow: "세 가지 안내",
    pillarsTitle: "보호, 처리, 그리고 한계.",
    tryEyebrow: "눌러서 보기",
    tryTitle: "보호 기능이 하는 일.",
    tryLabel: "보호 기능 예시",
    tryTabs: [
      ["파일 형식·용량 검사", "지원되지 않는 파일은 이유를 확인할 수 있습니다"],
      ["잠금", "비밀번호를 입력해야 열고 공유·다운로드할 수 있습니다"],
      ["공유 링크", "만든 시점의 대화 텍스트를 보여 줍니다"],
    ],
    file: {
      heading: "첨부 파일 확인",
      rows: [
        ["PDF", "분기 보고서.pdf", "읽을 수 있는 형식", "첨부됨"],
        ["DOCX", "계약서 초안.docx", "읽을 수 있는 형식", "첨부됨"],
        ["?", "설계도.xyz", "지원되지 않는 형식 · 읽을 수 있는 형식으로 다시 준비하세요", "지원 안 됨"],
      ],
    },
    lock: {
      heading: "저장된 대화",
      chat: ["다음 달 이사 일정 정리해 줘", "이사 2주 전, 1주 전, 당일로 나눠 정리했습니다…", "관리비 정산도 넣어 줘"],
      veilTitle: "잠긴 대화",
      veilNote: "비밀번호를 입력해야 열 수 있습니다",
      on: "이 대화 잠그기",
      off: "잠금 풀기",
      caveat: "잠금은 대화를 암호화하지 않으며, 이미 만든 공유 링크를 닫지 않습니다.",
    },
    share: {
      heading: "공유 링크",
      chat: ["여행 준비물 목록 만들어 줘", "옷, 서류, 전자기기, 상비약으로 나눴습니다…"],
      on: "공유 링크 만들기",
      off: "공유 끄기",
      linkTag: "만든 시점의 텍스트",
      note: "공유 링크는 일정 기간 뒤 자동으로 만료되고, 공유를 끄면 삭제됩니다.",
    },
    sampleNote: "설명을 위한 예시 화면입니다.",
    docsEyebrow: "정책 문서",
    docsTitle: "자세한 내용은 문서에 있습니다.",
    closing: ["중요한 답변은", "원문과 출처로 확인하세요."],
    review: "답변 비교 알아보기",
  },
};

const en: PolicyPageCopy = {
  crumb: "Policies",
  tabsLabel: "Policy documents",
  tabs: { safety: "Safety and data handling", privacy: "Privacy Policy", terms: "Terms and Conditions", refund: "Refund Policy" },
  privacyEyebrow: "Privacy",
  sectionCount: "{n} sections",
  readingTime: "About {n} min read",
  jumpTo: "Jump to a section",
  contents: "Contents",
  askSupport: "Questions? Contact our support team.",
  support: "Contact support",
  motionOff: "Pause animation",
  motionOn: "Resume animation",
  providerSearch: {
    label: "Find a provider",
    placeholder: "Search by provider or country",
    empty: "No provider in the table matches.",
    count: "Showing {n} providers",
  },
  safety: {
    flowLabel: "From question to answer",
    flow: [
      { k: "You", title: "Question and material", note: "What you send and the material the answer needs" },
      { k: "Tomverse", title: "Controls", note: "Shows what is supported and where the limits are" },
      { k: "AI provider", title: "The provider that writes the answer", note: "Processes the question and material needed for it. With Auto, Tomverse chooses the provider." },
      { k: "Answer", title: "Check the original and sources", note: "It can be wrong or incomplete" },
    ],
    guardChips: ["Model access", "Usage limits", "File checks"],
    flowNote: "Read the {privacy} for providers, countries, retention and deletion.",
    pillarsEyebrow: "Three things to know",
    pillarsTitle: "Protection, processing and limits.",
    tryEyebrow: "Try it",
    tryTitle: "What the controls do.",
    tryLabel: "Control examples",
    tryTabs: [
      ["File checks", "If a file is not supported, you can see why"],
      ["Lock", "Its password is needed to open, share or download it"],
      ["Share link", "Shows the conversation’s text as it was when you created it"],
    ],
    file: {
      heading: "Attachment check",
      rows: [
        ["PDF", "Quarterly report.pdf", "Readable format", "Attached"],
        ["DOCX", "Contract draft.docx", "Readable format", "Attached"],
        ["?", "Blueprint.xyz", "Not supported · prepare a readable version", "Not supported"],
      ],
    },
    lock: {
      heading: "Saved conversation",
      chat: ["Plan my move next month", "I split it into two weeks before, one week before and moving day…", "Add settling the building fees too"],
      veilTitle: "Locked conversation",
      veilNote: "Its password is needed to open it",
      on: "Lock this conversation",
      off: "Unlock",
      caveat: "Locking does not encrypt the conversation or close a share link that already exists.",
    },
    share: {
      heading: "Share link",
      chat: ["Make a packing list for my trip", "I grouped it into clothes, documents, electronics and medicine…"],
      on: "Create a share link",
      off: "Turn sharing off",
      linkTag: "Text as created",
      note: "A share link expires automatically and is deleted when you turn sharing off.",
    },
    sampleNote: "Example screens for illustration.",
    docsEyebrow: "Policy documents",
    docsTitle: "The details are in the documents.",
    closing: ["Check important answers", "against the original and sources."],
    review: "Learn about answer comparison",
  },
};

export const policyPageContent: Record<Language, PolicyPageCopy> = {
  ko,
  en,
  ...policyPageTranslations,
};
