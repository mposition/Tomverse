import type { AdminRole } from "@/lib/adminAuthCore";
import type { AdminLocale } from "@/lib/adminLocale";
import {
  ADMIN_DETAIL_ROUTES,
  ADMIN_NAVIGATION,
  ADMIN_UNLISTED_PAGES,
  adminNavigationFor,
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
 * `tests/adminLocale.test.mjs` fails when an entry, tab, group,
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
  Home: "홈",
  "Customers & Revenue": "고객·매출",
  "AI Platform": "AI 플랫폼",
  "AI Agents": "AI 에이전트",
  Development: "개발",
  System: "시스템",
  Messaging: "메시징",
  Governance: "거버넌스",
};

export const ADMIN_NAV_ITEMS_KO: Readonly<Record<string, LocalizedItem>> = {
  overview: {
    label: "오늘",
    description: "운영 스냅샷, 확인 필요 항목, 최근 활동",
    aliases: [
      "홈",
      "개요",
      "대시보드",
      "상태",
      "현황",
      "상태 점수",
      "점수",
      "환경변수",
      "환경 설정",
    ],
    tabs: {
      summary: {
        label: "요약",
        description: "운영 스냅샷, 확인 필요 항목, 최근 활동",
      },
      health: {
        label: "건강 점수",
        description: "점수가 어떻게 나왔고 각 항목에 무엇을 해야 하는지",
      },
    },
  },
  "work-queue": {
    label: "결정함",
    description: "사람의 결정을 기다리는 모든 항목, 분야별",
    aliases: ["작업 대기열", "대기열", "할 일", "대기", "승인", "결정"],
    tabs: {
      all: { label: "전체", description: "사람을 기다리는 모든 항목, 오래된 순" },
      customers: { label: "고객·매출", description: "지원, 환불, 개인정보 요청, 결제 결정" },
      agents: { label: "에이전트", description: "AI 에이전트가 사람을 기다리는 일" },
      development: { label: "개발", description: "아이디어 승인, 계획 승인, 에스컬레이션, 정지" },
      system: { label: "시스템", description: "확인이 필요한 웹훅, 예약 작업, 알림 발송" },
    },
  },
  analytics: {
    label: "지표",
    description: "활성 사용자, 사용량, 모델 점유율, 제품 퍼널, AI Review, 가져오기·메모리 지표",
    aliases: [
      "분석",
      "사용 현황",
      "활성 사용자",
      "사용자 수",
      "모델 점유율",
      "지역",
      "언어",
      "퍼널",
      "활성화",
      "전환",
      "제품 분석",
      "메모리",
      "가져오기",
      "교차검토",
    ],
    tabs: {
      usage: { label: "사용량", description: "활성 사용자, 메시지, 모델 점유율, 사용 시간대와 지역" },
      product: { label: "제품·퍼널", description: "유입, 활성화, 매출 퍼널" },
      "ai-review": { label: "AI Review", description: "신뢰성, 채택, 검토자 쌍 근거" },
      imports: { label: "가져오기·메모리", description: "외부 대화 가져오기와 메모리 지표" },
    },
  },
  users: {
    label: "사용자",
    description: "계정, 사용량, 플랜, 계정 제어",
    aliases: ["고객", "계정", "회원", "구독자", "이메일"],
  },
  support: {
    label: "지원",
    description: "문의, 자동 수정 검토, 개인정보 권리 요청",
    aliases: ["피드백", "수신함", "문의", "자동 수정", "개인정보", "정보주체 권리", "불만", "고객 지원"],
    tabs: {
      feedback: { label: "문의", description: "제품에서 접수된 신고와 요청" },
      autofix: { label: "자동 수정 검토", description: "검증된 신고에서 자동화가 제안한 수정, 사람의 검토 대기" },
      privacy: { label: "개인정보 요청", description: "내보내기와 삭제 요청" },
    },
  },
  billing: {
    label: "플랜·가격",
    description: "플랜, 가격 카탈로그, 프로모션, 프로모션 진단",
    aliases: ["결제", "플랜", "가격", "구독", "카탈로그", "프로모션", "쿠폰", "할인", "위험", "진단"],
    tabs: {
      plans: { label: "플랜", description: "플랜 카탈로그, Stripe ID, 수명주기 카운터" },
      prices: { label: "가격", description: "플랜과 통화별 현지화 가격" },
      promotions: { label: "프로모션", description: "프로모션 코드와 악용 신호" },
      diagnostics: { label: "진단", description: "프로모션 코드별 읽기 전용 점검" },
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
    description: "가용성, 지출, 장애, 대체 정책",
    aliases: ["장애", "사고", "대체", "fallback", "사용량", "비용", "지출", "잔액", "예산"],
    tabs: {
      health: { label: "상태", description: "가용성, 키, 모델별 지표" },
      "usage-cost": { label: "사용량·비용", description: "공급자 사용량 대조와 이미지 지출" },
      incidents: { label: "장애·대체", description: "준비 테스트, 장애 모드, 복구" },
    },
  },
  models: {
    label: "모델",
    description: "모델 레지스트리, 발견된 모델, 기본 모델",
    aliases: ["레지스트리", "카탈로그", "발견", "후보", "수명주기", "백로그", "기본 모델", "게스트 라인업", "대체 모델"],
    tabs: {
      registry: { label: "레지스트리", description: "가용성, 가격 override, API 구성" },
      discovery: { label: "발견", description: "공급자가 공개했지만 아직 결정되지 않은 모델" },
      defaults: { label: "기본 모델", description: "대체 모델, 게스트 라인업, 계정 기본값" },
      catalog: { label: "이미지·코딩 카탈로그", description: "이미지·코딩 모델의 켜기·보류, 가격 이력, LLM 초안, Code용 스냅샷" },
    },
  },
  routing: {
    label: "라우팅",
    description: "자동 라우터, 최적화, 섀도 비교, 통계",
    aliases: ["자동", "자동 라우터", "라우터", "최적화", "섀도", "통계", "작업 프로필", "후보"],
    tabs: {
      auto: { label: "자동 라우터", description: "자동 모델 라우터의 모드와 조정값" },
      optimizer: { label: "최적화", description: "라우터와 재작성 최적화 권고" },
      shadow: { label: "섀도 비교", description: "라우터가 골랐을 모델과 실제 실행 비교" },
      stats: { label: "통계", description: "적응형 라우팅 통계" },
    },
  },
  office: {
    label: "에이전트 홈",
    description: "에이전트 팀 현황과 팀별 기록 화면 링크",
    aliases: ["에이전트", "오피스", "에이전트 팀", "픽셀 오피스", "라이브 오피스", "팀 현황", "팀 보드"],
    tabs: {
      dashboard: { label: "팀 보드", description: "팀 현황판, digest 브리핑과 팀별 기록 링크" },
      live: { label: "라이브 오피스", description: "오피스 바닥과 운영자 지시창" },
    },
  },
  marketing: {
    label: "마케팅",
    description: "초안 승인, 게시된 글, 브랜드 계정, 자동화가 남긴 보고",
    aliases: ["소셜", "게시물", "링크드인", "제르니오", "캠페인", "브랜드 계정", "초안 대기열", "승인", "경쟁사", "자산", "가드"],
    tabs: {
      overview: { label: "개요", description: "모드, 스위치, 마지막 실행, 대기 중인 일" },
      queue: { label: "승인 대기", description: "사람을 기다리는 초안과 Guard가 각각에 대해 말한 것" },
      published: {
        label: "게시 현황",
        description: "승인된 모든 글 — 대기, 전송 중, 게시됨, 실패, 결과 불명",
      },
      accounts: { label: "계정", description: "브랜드 계정과 모드, 정지된 계정이 왜 정지됐는지" },
      reports: { label: "리포트·경쟁사", description: "주간 요약, 경쟁사 사실, 사람이 공식으로 승인한 host" },
      settings: { label: "설정", description: "마케팅 자동화의 스위치와 웹훅 배선" },
    },
  },
  "product-research": {
    label: "제품 리서치",
    description: "Scout가 공개 페이지·생성 파일·카탈로그에서 찾은 개선 제안과 실행·비용",
    aliases: ["스카우트", "개선 제안", "제안", "제품 리서치", "관측", "이슈 백로그", "회차"],
    tabs: {
      suggestions: { label: "제안", description: "대상별로 묶은 열린 제안. 거절하거나 AMUX로 보냅니다" },
      runs: { label: "실행·비용", description: "Scout가 돌았는지, owner가 정한 모델과 하루 상한, 최근 7일" },
      observations: { label: "이슈 관찰", description: "관측 회차, 가장 최근 회차의 행, staging·production 창 계산값" },
    },
  },
  "engineering-agent": {
    label: "엔지니어링",
    description: "엔지니어링 에이전트의 기록 — 결정 대기, run, pull request, 모드",
    aliases: [
      "엔지니어링 에이전트",
      "에이전트",
      "T2 초안",
      "패치",
      "풀 리퀘스트",
      "게시 서비스",
      "러너",
      "동결",
    ],
    tabs: {
      overview: { label: "개요", description: "모드, 스위치, 마지막 실행, 대기 중인 일" },
      queue: { label: "결정 대기", description: "사람을 기다리는 T2 초안, 결정, 상태 불일치" },
      runs: { label: "실행·PR", description: "각 실행과 에이전트가 결속한 pull request, 그 결과" },
      settings: { label: "설정", description: "모드, 동결, kill switch, 상한 대비 소유자 대기열" },
    },
  },
  "sre-ops": {
    label: "SRE",
    description: "ops observer의 상태 체인, 신뢰 판정, 일일 보고, 소유자의 genesis",
    aliases: ["SRE", "SRE 에이전트", "ops observer", "genesis", "신뢰", "상태 체인", "호출", "일일 보고"],
    tabs: {
      overview: { label: "개요", description: "상태 체인, 신뢰 판정, 소유자의 genesis" },
      daily: { label: "일일 보고", description: "ops observer가 날마다 보고한 내용" },
      settings: { label: "설정", description: "ops observer의 모드와 스위치" },
    },
  },
  "finance-agent": {
    label: "결제·재무",
    description: "가격 검증 기한 일일 digest, 에이전트 스위치, monitor 확인",
    aliases: ["재무", "결제 에이전트", "가격 검증 기한", "가격 마감", "digest", "미확정 가격"],
    tabs: {
      overview: { label: "개요", description: "에이전트 스위치, monitor 확인, 최근 digest" },
      report: { label: "가격 마감 보고", description: "미확정 가격 마감 일일 보고" },
      settings: { label: "설정", description: "결제·재무 에이전트의 모드와 스위치" },
    },
  },
  "amux-backlog": {
    label: "아이디어",
    description: "아이디어 입력, 카드 목록, 포트폴리오 평가",
    aliases: ["백로그", "아이디어", "아이디어 분석", "등록", "카드 등록", "우선순위", "비용 추정", "포트폴리오", "평가"],
    tabs: {
      ideas: { label: "아이디어", description: "아이디어를 넣고 실행과 계획을 승인" },
      list: { label: "카드 목록", description: "백로그 카드번호, 생성일, 한줄 설명과 저장된 점수" },
      portfolio: { label: "포트폴리오", description: "카드별 전략 평가와 점수" },
    },
  },
  "amux-execution": {
    label: "실행 보드",
    description: "AMUX 카드와 실행 상태, 내 확인 대기, 진단",
    aliases: ["실행", "보드", "카드", "시도", "배정", "에스컬레이션", "사람 검토", "검토", "검토 큐", "내 확인 대기", "워커 질문", "진단", "워커 성과", "결정 로그", "사고", "프로세스 분석"],
    tabs: {
      cards: { label: "보드", description: "Tomverse에 저장된 모든 AMUX 카드와 실행 상태" },
      review: { label: "내 확인 대기", description: "사람이 결정해야 멈춰 있는 카드를 한곳에서 차례로 처리해요" },
      diagnostics: { label: "진단", description: "워커 성과와 결정 로그" },
      "process-audit": { label: "프로세스 분석", description: "AMUX가 멈추는 지점, 과한 제약, 불필요한 단계를 정기적으로 분석한 보고서" },
    },
  },
  release: {
    label: "릴리스",
    description: "develop 병합부터 production까지: 병합 레인, 릴리스 열차, CI 대기열",
    aliases: ["QA", "릴리스", "릴리스 준비", "병합 레인", "릴리스 열차", "제어 revision", "CI 입장", "CI 대기열", "러너"],
    tabs: {
      qa: { label: "QA·릴리스", description: "확인할 일, production과 main, 병합 레인, 릴리스 열차" },
      ci: { label: "CI 대기열", description: "러너를 기다리는 PR, 그 순서와 실시간 러너 사용량" },
    },
  },
  "amux-settings": {
    label: "AMUX 설정",
    description: "AMUX 자동 편입, 워커, Decision Maker 제어, 분석 예산",
    aliases: ["설정", "워커", "등록부", "워커 등록부", "자동 편입", "Decision Maker", "결정 도우미", "킬 스위치", "분석 설정", "분석 예산", "비용 카탈로그"],
    tabs: {
      "automatic-admission": {
        label: "자동 편입",
        description: "준비된 Task를 담당 없는 Todo에 편입하는 owner 승인",
      },
      workers: { label: "워커", description: "AI 워커를 등록하고, 할 수 있는 일을 정하고, 켜고 끕니다" },
      "decision-maker": { label: "Decision Maker", description: "Decision Maker kill switch와 인스턴스별 모드" },
      analysis: { label: "분석 예산·모델", description: "분석 월 예산과 승인된 분석 모델" },
    },
  },
  "amux-recovery": {
    label: "안전·복구",
    description: "실행 안전과 정지, 예약 복구, 은퇴한 AMUX 도구",
    aliases: ["안전", "복구", "정지", "해제", "자동 복구", "결과 불명", "확인할 쓰기", "예약", "claim", "레거시", "카탈로그 이관", "이관", "재조정", "소스 개정", "메타데이터", "승격", "추천 풀", "자동 승격"],
    tabs: {
      safety: { label: "실행 안전", description: "자동 복구, 확인할 증거와 운영자 정지 해제 판단" },
      reservations: { label: "예약·claim 복구", description: "쓰이지 않은 분석 예약과 결정이 필요한 claim" },
      legacy: { label: "레거시 도구", description: "카탈로그 이관, 소스 재조정, 카드 메타데이터, 카드 승격" },
    },
  },
  infrastructure: {
    label: "인프라",
    description: "Railway, R2, 데이터베이스, Prisma 운영",
    aliases: ["데이터베이스", "호스팅", "스토리지", "저장소"],
  },
  automation: {
    label: "자동화",
    description: "예약 작업, 웹훅 전송, 운영 리포트",
    aliases: ["크론", "작업", "스케줄러", "웹훅", "재전송", "보고서", "리포트"],
    tabs: {
      jobs: { label: "예약 작업", description: "cron 상태, 실행 이력, 멈춘 실행" },
      webhooks: { label: "웹훅", description: "결제 이벤트 전송과 재전송" },
      reports: { label: "리포트", description: "운영 리포트와 배포 대상" },
    },
  },
  platform: {
    label: "기능 플래그",
    description: "긴급 차단, 기능 스위치, 계정 기본값",
    aliases: ["플랫폼 설정", "설정", "기본값", "기능 플래그", "킬 스위치", "긴급", "스위치", "게스트 기본"],
    tabs: {
      emergency: { label: "긴급 차단", description: "채팅, 첨부, 공개 공유의 kill switch" },
      features: { label: "기능 스위치", description: "제품 기능의 출시 스위치" },
      "account-defaults": { label: "계정 기본값", description: "새 계정과 기존 계정이 시작하는 기본값" },
    },
  },
  "email-campaigns": {
    label: "이메일 캠페인",
    description: "캠페인 초안, 각 캠페인이 기다리는 것, 발송 예정 wave",
    aliases: ["캠페인", "웨이브", "리마인더", "은퇴 안내", "대량 메일", "공지", "확인", "캠페인 승인", "새 캠페인"],
    tabs: {
      campaigns: { label: "캠페인", description: "모든 캠페인과 상태, 발송을 막고 있는 것" },
      schedule: { label: "일정", description: "예정 시각순 wave, 지연된 항목 먼저" },
      new: { label: "새 캠페인", description: "캠페인이나 정책 변경 안내 작성" },
    },
  },
  "email-delivery": {
    label: "고객 메일 발송",
    description: "누구에게 무엇을 보냈는지, 무엇이 거절됐는지, 어떤 주소가 차단됐는지",
    aliases: ["이메일 전송", "발신함", "전송 로그", "발송 기록", "반송", "스팸 신고", "수신 차단", "수신 거부", "포기", "도착 안 함", "받지 못함", "메일 이력"],
    tabs: {
      deliveries: { label: "발송 기록", description: "모든 메시지와 그 결과" },
      suppressions: { label: "수신 거부", description: "메일을 보내지 않는 주소와 그 이유" },
    },
  },
  alerts: {
    label: "운영자 알림",
    description: "알림 임계값, 템플릿, 발송 기록, 메일 경로 시험",
    aliases: ["알림", "슬랙", "디스코드", "임계값", "호출", "시험", "프로브"],
    tabs: {
      policy: { label: "정책", description: "예산과 장애 임계값" },
      templates: { label: "템플릿", description: "메시지 템플릿과 전송 테스트" },
      deliveries: { label: "발송 기록", description: "무엇을 어디로 보냈고 도착했는지" },
      "mail-test": { label: "메일 경로 시험", description: "메일 경로로 시험 운영자 알림 보내기" },
    },
  },
  "email-policy": {
    label: "이메일 정책",
    description: "발신 메일의 관할 지역 프로필과 현재 적용 중인 버전",
    aliases: ["이메일", "관할권", "관할 지역", "수신 거부", "마케팅", "푸터", "제목 접두어", "야간 발송 제한", "동의", "발송 도메인", "전달성"],
    tabs: {
      jurisdictions: { label: "관할 지역", description: "프로필 버전과 현재 적용 중인 버전" },
      domains: { label: "발송 도메인", description: "도메인 인증과 DNS 레코드 상태" },
    },
  },
  audit: {
    label: "감사 로그",
    description: "관리자 활동(수행자와 대상 포함)과 로그 무결성 검사",
    aliases: ["로그", "이력", "활동", "기록", "누가 변경", "무결성", "변조"],
    tabs: {
      log: { label: "기록", description: "관리자 활동, 수행자와 대상 포함" },
      integrity: { label: "무결성 검사", description: "감사 로그의 변조 탐지" },
    },
  },
  retention: {
    label: "보존·삭제",
    description: "보존 기간과 파괴적 정리 작업",
    aliases: ["보존", "정리", "영구 삭제", "삭제", "데이터 수명주기"],
  },
  "admin-access": {
    label: "관리자 권한",
    description: "관리자 역할과 만료, 운영 준비 상태",
    aliases: ["관리자 접근", "역할", "권한", "관리자", "준비 상태"],
    tabs: {
      administrators: { label: "관리자", description: "구성된 계정, 역할, 만료" },
      readiness: { label: "운영 준비", description: "운영자가 확인해야 하는 점검 항목" },
    },
  },
};

export const ADMIN_DETAIL_ROUTES_KO: Readonly<
  Record<
    (typeof ADMIN_DETAIL_ROUTES)[number]["id"],
    { label: string; description: string; tabs?: Readonly<Record<string, LocalizedTab>> }
  >
> = {
  "amux-u21-test-card": {
    label: "AMUX U21 테스트 카드",
    description: "소유자 전용 합성 후보 수신 진단",
  },
  "prompt-refiner-shadow": {
    label: "Prompt Refiner shadow 실행",
    description: "동결된 합성 shadow run의 owner 전용 승인과 실행",
  },
  "user-detail": {
    label: "고객 상세",
    description: "계정 타임라인, 결제, 크레딧, 보안 제어",
    tabs: {
      overview: { label: "개요", description: "고객이 누구인지, 플랜과 최근 활동" },
      billing: { label: "결제", description: "구독, 크레딧, 환불, 청구서" },
      security: { label: "보안", description: "로그인 방법, 세션, 계정 잠금" },
      conversations: { label: "대화", description: "고객의 대화와 그 안에서 실행된 것" },
      notes: { label: "메모·타임라인", description: "운영자 메모와 계정 타임라인" },
    },
  },
  "sre-ops-item": {
    label: "운영 감시 메시지",
    description: "page 메시지 하나가 무엇에 관한 것이었는지: 신호, 메시지 종류, 시각",
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
  "agent-digests": {
    label: "신뢰·안전 digest",
    description: "페이지를 열 때 센 DSR 기한과 신뢰·안전 관측 스위치",
    aliases: ["신뢰", "안전", "신뢰와 안전", "정보주체 권리", "개인정보 기한", "digest", "관측"],
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
  locale: AdminLocale,
  role?: AdminRole | null
): AdminPageMeta => {
  const meta = resolveAdminPageMeta(pathname, role);
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
  locale: AdminLocale,
  /**
   * The viewer's role. A page restricted to other roles is left out, and so
   * is every restricted page when the role is not known: the palette must not
   * offer a page that answers 404.
   */
  role?: AdminRole | null
): LocalizedAdminSearchablePage[] => [
  // The entries this role's sidebar lists, so the two cannot disagree.
  ...adminNavigationFor(role).map((item) => {
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
      href: "openHref" in page ? page.openHref : page.href,
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
