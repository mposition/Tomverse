import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Overview page's pinned-pages panel. */
export const adminQuickAccessMessages = defineAdminMessages({
  en: {
    title: "Quick access",
    pinnedCount: (count: number, limit: number) =>
      `${count}/${limit} pinned · also shown in the sidebar and the command palette`,
    description:
      "Pin any Admin Console page from its own header, or from the pin control beside its sidebar entry.",
    emptyBefore: "Nothing is pinned. Open a page and choose ",
    emptyAction: "Pin page",
    emptyAfter: " to add it here.",
    unpin: (label: string) => `Unpin ${label} from quick access`,
    full: "Quick access is full. Unpin a page to add another.",
  },
  ko: {
    title: "빠른 접근",
    pinnedCount: (count: number, limit: number) =>
      `${count}/${limit}개 고정됨 · 사이드바와 명령 팔레트에도 표시됩니다`,
    description:
      "Admin Console의 어느 페이지든 해당 페이지 헤더나 사이드바 항목 옆의 고정 버튼으로 고정할 수 있습니다.",
    emptyBefore: "고정된 페이지가 없습니다. 페이지를 열고 ",
    emptyAction: "페이지 고정",
    emptyAfter: "을 선택하면 여기에 추가됩니다.",
    unpin: (label: string) => `빠른 접근에서 ${label} 고정 해제`,
    full: "빠른 접근이 가득 찼습니다. 다른 페이지를 추가하려면 먼저 고정을 해제하세요.",
  },
});
