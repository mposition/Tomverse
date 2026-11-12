import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the semantic retrieval (Cohere) switches on Admin › Feature flags. */
export const adminSemanticRetrievalMessages = defineAdminMessages({
  en: {
    title: "Semantic search (Cohere)",
    description:
      "Rerank and embedding calls that find knowledge files and memories by meaning. Every switch is off by default, and lexical search keeps working when one is off or a call fails.",
    dataNotice:
      "Turning a switch on sends account memory and knowledge file text to an outside provider, Cohere.",
    costNote:
      "The cost comes from the retrieval provider budget, not from user credits.",
    features: {
      knowledgeRerank: {
        label: "Knowledge rerank",
        description: "Re-sorts knowledge file candidates by how relevant they are to the question.",
      },
      knowledgeEmbed: {
        label: "Knowledge embeddings",
        description: "Searches knowledge files by meaning, so a different wording still finds them.",
      },
      knowledgeImagePages: {
        label: "Scanned PDF image pages",
        description: "Indexes the image pages of scanned PDFs.",
      },
      memoryRerank: {
        label: "Memory rerank",
        description: "Chooses memory candidates by how relevant they are to the question.",
      },
      memoryDuplicates: {
        label: "Duplicate memories by meaning",
        description: "Treats a memory with the same meaning as a duplicate when it is saved.",
      },
    },
    notConfigured: "Not ready: privacy notice or environment variables",
    keyLabel: "API key",
    budgetLabel: "Provider budget",
    privacyNoticeLabel: "Privacy notice",
    published: "Published",
    notPublished: "Not published",
    set: "Set",
    missing: "Missing",
    problemsLabel: "Set but unusable:",
    save: "Save",
    saving: "Saving...",
    saved: "Saved.",
    loadFailed: "Could not load the settings.",
    saveFailed: "Could not save the settings.",
  },
  ko: {
    title: "의미 검색 (Cohere)",
    description:
      "지식 파일과 메모리를 뜻으로 찾는 rerank·embedding 호출입니다. 스위치는 모두 기본이 꺼져 있고, 꺼져 있거나 호출이 실패해도 단어 기반 검색은 그대로 동작합니다.",
    dataNotice:
      "켜면 계정 메모리·지식 파일 내용이 외부 제공자 Cohere로 전송됩니다.",
    costNote:
      "비용은 사용자 크레딧이 아니라 검색 제공자 예산에서 나갑니다.",
    features: {
      knowledgeRerank: {
        label: "지식 rerank",
        description: "지식 파일 후보를 질문과의 관련도로 다시 정렬합니다.",
      },
      knowledgeEmbed: {
        label: "지식 embedding",
        description: "지식 파일을 의미로 검색합니다. 단어가 달라도 찾습니다.",
      },
      knowledgeImagePages: {
        label: "스캔 PDF 이미지 페이지",
        description: "스캔 PDF의 이미지 페이지를 색인합니다.",
      },
      memoryRerank: {
        label: "메모리 rerank",
        description: "메모리 후보를 질문과의 관련도로 선택합니다.",
      },
      memoryDuplicates: {
        label: "뜻이 같은 메모리 중복 처리",
        description: "뜻이 같은 메모리를 저장할 때 중복으로 처리합니다.",
      },
    },
    notConfigured: "준비 안 됨: 개인정보 고지 또는 환경 변수",
    keyLabel: "API 키",
    budgetLabel: "제공자 예산",
    privacyNoticeLabel: "개인정보 고지",
    published: "게시됨",
    notPublished: "게시 전",
    set: "설정됨",
    missing: "없음",
    problemsLabel: "설정은 했지만 쓸 수 없는 값:",
    save: "저장",
    saving: "저장 중...",
    saved: "저장했습니다.",
    loadFailed: "설정을 불러오지 못했습니다.",
    saveFailed: "설정을 저장하지 못했습니다.",
  },
});
