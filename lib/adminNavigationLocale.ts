import type { AdminLocale } from "@/lib/adminLocale";
import {
  ADMIN_DETAIL_ROUTES,
  ADMIN_NAVIGATION,
  ADMIN_UNLISTED_PAGES,
  findAdminNavItem,
  resolveAdminPageMeta,
  type AdminNavGroup,
  type AdminNavItem,
  type AdminNavTab,
  type AdminPageMeta,
} from "@/lib/adminNavigation";

/**
 * The navigation table in Korean.
 *
 * Contract: docs/ui-contracts/admin-console-ia.md, "Language".
 *
 * Kept beside `lib/adminNavigation.ts` rather than inside it. The English table
 * is the route table -- ids, hrefs, write roles, badges, redirects -- and its
 * labels are what the English console, the E2E suite and every runbook already
 * name. This file adds a second rendering of the same entries, keyed by the
 * same ids, and never decides a route, a tab or a permission.
 *
 * `tests/adminNavigationLocale.test.mjs` fails when an entry, tab, group,
 * detail route or unlisted page has no Korean copy, so adding one to the route
 * table without translating it cannot ship.
 */

type LocalizedTab = { label: string; description: string };

type LocalizedItem = {
  label: string;
  description: string;
  /** Korean search terms, matched in addition to the English aliases. */
  aliases: readonly string[];
  tabs?: Readonly<Record<string, LocalizedTab>>;
};

export const ADMIN_NAV_GROUP_LABELS_KO: Readonly<Record<AdminNavGroup, string>> = {
  "Command Center": "운영 현황",
  Customers: "고객",
  Revenue: "매출",
  "AI Platform": "AI 플랫폼",
  Operations: "운영",
  Governance: "거버넌스",
};

export const ADMIN_NAV_ITEMS_KO: Readonly<Record<string, LocalizedItem>> = {
  overview: {
    label: "개요",
    description: "운영 스냅샷, 확인 필요 항목, 최근 활동",
    aliases: ["홈", "대시보드", "상태", "현황"],
  },
  "work-queue": {
    label: "작업 대기열",
    description: "운영자 조치를 기다리는 모든 항목, 오래된 순",
    aliases: ["대기열", "할 일", "대기", "승인"],
    tabs: {
      queue: { label: "대기열", description: "우선순위와 경과 시간순으로 정렬한 미처리 항목" },
      approvals: { label: "승인", description: "2인 승인 요청" },
    },
  },
  analytics: {
    label: "분석",
    description: "제품 퍼널, 활성화, 가져오기·메모리 지표",
    aliases: ["퍼널", "활성화", "전환", "제품 분석", "메모리", "가져오기", "교차검토"],
    tabs: {
      product: { label: "제품 분석", description: "유입, 활성화, 매출 퍼널" },
      imports: { label: "가져오기·메모리", description: "외부 대화 가져오기와 메모리 지표" },
    },
  },
  users: {
    label: "사용자",
    description: "계정, 사용량, 플랜, 계정 제어",
    aliases: ["고객", "계정", "회원", "구독자", "이메일"],
  },
  support: {
    label: "고객 지원",
    description: "피드백 수신함과 개인정보 권리 요청 대기열",
    aliases: ["피드백", "수신함", "문의", "개인정보", "정보주체 권리", "불만"],
    tabs: {
      feedback: { label: "피드백", description: "제품에서 접수된 신고와 요청" },
      privacy: { label: "개인정보 요청", description: "내보내기와 삭제 요청" },
    },
  },
  billing: {
    label: "결제",
    description: "플랜, 가격 카탈로그, 프로모션, 프로모션 위험",
    aliases: ["플랜", "가격", "구독", "카탈로그", "프로모션", "쿠폰", "할인", "위험"],
    tabs: {
      plans: { label: "플랜·가격", description: "플랜 카탈로그, Stripe ID, 수명주기 카운터" },
      promotions: { label: "프로모션·위험", description: "프로모션 코드와 악용 신호" },
    },
  },
  refunds: {
    label: "환불",
    description: "환불 검토 대기열과 검토 완료 요청",
    aliases: ["취소", "지불 거절", "분쟁", "환급"],
  },
  "credit-ledger": {
    label: "크레딧 원장",
    description: "크레딧 지급, 정산, 미결제 부채",
    aliases: ["크레딧", "원장", "지급", "정산", "부채"],
  },
  providers: {
    label: "공급자",
    description: "가용성, 지출, 장애, fallback 정책",
    aliases: ["장애", "사고", "대체", "사용량", "비용", "지출", "잔액", "예산"],
    tabs: {
      health: { label: "상태", description: "가용성, 키, 모델별 지표" },
      "usage-cost": { label: "사용량·비용", description: "공급자 사용량 대조와 이미지 지출" },
      incidents: { label: "장애·fallback", description: "준비 테스트, 장애 모드, 복구" },
    },
  },
  models: {
    label: "모델",
    description: "모델 레지스트리, 가용성, 발견된 모델",
    aliases: ["레지스트리", "카탈로그", "발견", "후보", "수명주기", "백로그"],
    tabs: {
      registry: { label: "레지스트리", description: "가용성, 가격 override, API 구성" },
      discovery: { label: "발견", description: "공급자가 공개했지만 아직 결정되지 않은 모델" },
    },
  },
  routing: {
    label: "라우팅",
    description: "Shadow Auto Router 결정과 실제 실행 결과 비교",
    aliases: ["자동", "라우터", "섀도", "작업 프로필", "후보"],
  },
  infrastructure: {
    label: "인프라",
    description: "Railway, R2, 데이터베이스, Prisma 운영",
    aliases: ["데이터베이스", "호스팅", "스토리지", "저장소"],
  },
  automation: {
    label: "자동화",
    description: "예약 작업, webhook 전송, 운영 보고서",
    aliases: ["크론", "작업", "스케줄러", "웹훅", "재전송", "보고서"],
    tabs: {
      jobs: { label: "예약 작업", description: "cron 상태, 실행 이력, 멈춘 실행" },
      webhooks: { label: "Webhook", description: "결제 이벤트 전송과 재전송" },
      reports: { label: "보고서", description: "운영 보고서와 배포 대상" },
    },
  },
  alerts: {
    label: "알림",
    description: "알림 임계값, 템플릿, 전송 로그",
    aliases: ["알림", "슬랙", "디스코드", "임계값", "호출"],
    tabs: {
      policy: { label: "정책", description: "예산과 장애 임계값" },
      templates: { label: "템플릿", description: "메시지 템플릿과 전송 테스트" },
      deliveries: { label: "전송 로그", description: "무엇을 어디로 보냈고 도착했는지" },
    },
  },
  "email-campaigns": {
    label: "이메일 캠페인",
    description: "캠페인 초안, 각 캠페인이 기다리는 것, 발송 예정 wave",
    aliases: ["캠페인", "웨이브", "리마인더", "은퇴 안내", "대량 메일", "공지", "확인", "캠페인 승인"],
    tabs: {
      campaigns: { label: "캠페인", description: "모든 캠페인과 상태, 발송을 막고 있는 것" },
      schedule: { label: "일정", description: "예정 시각순 wave, 지연된 항목 먼저" },
    },
  },
  "email-delivery": {
    label: "이메일 전송",
    description: "누구에게 무엇을 보냈는지, 무엇이 거절됐는지, 어떤 주소가 차단됐는지",
    aliases: ["발신함", "전송 로그", "반송", "스팸 신고", "수신 차단", "포기", "도착 안 함", "받지 못함", "메일 이력"],
    tabs: {
      deliveries: { label: "전송", description: "모든 메시지와 그 결과" },
      suppressions: { label: "수신 차단", description: "메일을 보내지 않는 주소와 그 이유" },
    },
  },
  platform: {
    label: "플랫폼 설정",
    description: "제품 기본값과 긴급 기능 제어",
    aliases: ["설정", "기본값", "기능 플래그", "킬 스위치", "게스트 기본"],
  },
  "email-policy": {
    label: "이메일 정책",
    description: "발신 메일의 관할권 프로필과 현재 적용 중인 버전",
    aliases: ["이메일", "관할권", "수신 거부", "마케팅", "푸터", "제목 접두어", "야간 발송 제한", "동의", "발송 도메인", "전달성"],
    tabs: {
      jurisdictions: { label: "관할권", description: "프로필 버전과 현재 적용 중인 버전" },
      domains: { label: "발송 도메인", description: "도메인 인증과 DNS 레코드 상태" },
    },
  },
  audit: {
    label: "감사 로그",
    description: "관리자 활동, 수행자와 대상 포함",
    aliases: ["로그", "이력", "활동", "기록", "누가 변경"],
  },
  retention: {
    label: "보존",
    description: "보존 기간과 파괴적 정리 작업",
    aliases: ["정리", "영구 삭제", "삭제", "데이터 수명주기"],
  },
  "admin-access": {
    label: "관리자 접근",
    description: "역할, 만료, 운영 준비 상태, 감사 무결성",
    aliases: ["역할", "권한", "관리자", "준비 상태", "무결성"],
    tabs: {
      administrators: { label: "관리자", description: "구성된 계정, 역할, 만료" },
      readiness: { label: "운영 준비 상태", description: "운영자가 확인해야 하는 점검 항목" },
      integrity: { label: "감사 무결성", description: "감사 로그의 변조 탐지" },
    },
  },
};

export const ADMIN_DETAIL_ROUTES_KO: Readonly<
  Record<(typeof ADMIN_DETAIL_ROUTES)[number]["id"], { label: string; description: string }>
> = {
  "user-detail": {
    label: "고객 상세",
    description: "계정 타임라인, 결제, 크레딧, 보안 제어",
  },
  "campaign-detail": {
    label: "캠페인 상세",
    description: "이 캠페인이 보내는 문구, 누가 무엇을 확인했는지, 발송 가능 여부",
  },
  "provider-detail": {
    label: "공급자 상세",
    description: "사용량 진단, 결제, fallback, 최근 오류",
  },
};

export const ADMIN_UNLISTED_PAGES_KO: Readonly<
  Record<(typeof ADMIN_UNLISTED_PAGES)[number]["id"], LocalizedItem>
> = {
  search: {
    label: "전체 검색",
    description: "콘솔 전체에서 고객, 환불, trace, 감사 이벤트 검색",
    aliases: ["찾기", "조회", "검색", "전체"],
  },
};

const UNKNOWN_PAGE_KO = {
  label: "Admin Console",
  description: "이 경로는 콘솔 내비게이션에 포함되어 있지 않습니다.",
};

export const adminNavGroupLabel = (group: AdminNavGroup, locale: AdminLocale) =>
  locale === "ko" ? ADMIN_NAV_GROUP_LABELS_KO[group] : group;

/** An entry with its label, description and tabs in the given locale. */
export const localizeAdminNavItem = (
  item: AdminNavItem,
  locale: AdminLocale
): AdminNavItem => {
  if (locale !== "ko") return item;
  const ko = ADMIN_NAV_ITEMS_KO[item.id];
  if (!ko) return item;
  return {
    ...item,
    label: ko.label,
    description: ko.description,
    tabs: item.tabs ? localizeAdminTabs(item.id, item.tabs, locale) : item.tabs,
  };
};

export const localizeAdminTabs = <T extends AdminNavTab>(
  itemId: string,
  tabs: readonly T[],
  locale: AdminLocale
): T[] =>
  tabs.map((tab) => {
    const ko = locale === "ko" ? ADMIN_NAV_ITEMS_KO[itemId]?.tabs?.[tab.id] : undefined;
    return ko ? { ...tab, label: ko.label, description: ko.description } : tab;
  });

/** `resolveAdminPageMeta`, with the heading and breadcrumb in the given locale. */
export const localizeAdminPageMeta = (
  pathname: string,
  locale: AdminLocale
): AdminPageMeta => {
  const meta = resolveAdminPageMeta(pathname);
  if (locale !== "ko") return meta;
  if (!meta.isKnown) return { ...meta, ...UNKNOWN_PAGE_KO };

  const detail = ADMIN_DETAIL_ROUTES.find((route) => route.pattern.test(pathname));
  if (detail) {
    const parent = findAdminNavItem(detail.parentHref);
    return {
      ...meta,
      ...ADMIN_DETAIL_ROUTES_KO[detail.id],
      parentLabel: parent ? localizeAdminNavItem(parent, locale).label : meta.parentLabel,
    };
  }

  const unlisted = ADMIN_UNLISTED_PAGES.find((page) => page.href === meta.href);
  if (unlisted) {
    const ko = ADMIN_UNLISTED_PAGES_KO[unlisted.id];
    return { ...meta, label: ko.label, description: ko.description };
  }

  const item = ADMIN_NAVIGATION.find((entry) => entry.href === meta.href);
  if (!item) return meta;
  const localized = localizeAdminNavItem(item, locale);
  return { ...meta, label: localized.label, description: localized.description };
};

export type LocalizedAdminSearchablePage = {
  id: string;
  label: string;
  href: string;
  description: string;
  group: AdminNavGroup | null;
  groupLabel: string | null;
  /** Every term the palette matches on, in both languages. */
  terms: readonly string[];
};

/**
 * Every page the command palette can open, displayed in the given locale and
 * matched in both.
 *
 * Matching both is deliberate: an operator reading the Korean console who
 * types "refund" -- because that is the word in a runbook, a Slack thread or
 * the URL -- should still find the page, and so should one reading the English
 * console who types "환불".
 */
export const localizedAdminSearchablePages = (
  locale: AdminLocale
): LocalizedAdminSearchablePage[] => [
  ...ADMIN_NAVIGATION.map((item) => {
    const ko = ADMIN_NAV_ITEMS_KO[item.id];
    const shown = localizeAdminNavItem(item, locale);
    return {
      id: item.id,
      label: shown.label,
      href: item.href,
      description: shown.description,
      group: item.group as AdminNavGroup | null,
      groupLabel: adminNavGroupLabel(item.group, locale),
      terms: [
        item.label,
        item.description,
        item.group,
        ...item.aliases,
        ...(ko
          ? [ko.label, ko.description, ADMIN_NAV_GROUP_LABELS_KO[item.group], ...ko.aliases]
          : []),
      ],
    };
  }),
  ...ADMIN_UNLISTED_PAGES.map((page) => {
    const ko = ADMIN_UNLISTED_PAGES_KO[page.id];
    return {
      id: page.id,
      label: locale === "ko" ? ko.label : page.label,
      href: page.href,
      description: locale === "ko" ? ko.description : page.description,
      group: null,
      groupLabel: null,
      terms: [
        page.label,
        page.description,
        ...page.aliases,
        ko.label,
        ko.description,
        ...ko.aliases,
      ],
    };
  }),
];

export const matchLocalizedAdminPages = (
  query: string,
  pages: readonly LocalizedAdminSearchablePage[]
): LocalizedAdminSearchablePage[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return pages.filter((page) =>
    page.terms.join(" ").toLowerCase().includes(normalized)
  );
};
