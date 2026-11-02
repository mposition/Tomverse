# 마케팅 자동화 에이전트 정책

상태: **승인됨 — 구현 없음.** 작성 2026-09-16, 승인 2026-09-17.
approvedBy: mposition · approvedAt: 2026-10-18 · 정책 버전: 5

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | 2026-09-17 mposition | 최초 승인 |
| 2 | 2026-09-17 mposition | webhook 검증 위치를 S0 로컬 도구에서 **S2 staging 수신 route**로 옮기고, 그 검증 전에는 webhook 이벤트를 게시 상태 판정에 쓰지 않는다. 검증용 shadow 처리와 운영 활성화를 나누고 통과 기준·범위 강제·기록·재검증 범위를 정함(§6.1, §8.1, §8.1.1, §8.3, §14). **O15**: API로 게시를 내릴 수 없는 Instagram·TikTok은 항상 승인 모드(§1, §6.1, §8.2, §15) |
| 3 | 2026-09-21 mposition | §7.1의 문장 해석 규칙 9개와 `rule.free-wording`을 거절기가 아닌 잠정 언어 진단으로 한정한다. 진단은 `provisional_language_flag` 하나와 세부 rule id를 남겨 사람에게 보내며, 입력 위생·claim/asset·provenance 거절은 그대로 둔다(§7.1, §7.2). 열세 번의 독립 검토가 이 판정기를 양방향으로 틀린 것으로 확인했고, 답은 패턴을 더하는 것이 아니라 tokeniser·형태소로 교체하는 것이다. 그 교체 전까지 거절 권한은 돌아오지 않는다. |
| 4 | 2026-10-16 mposition | §9.2: 졸업 후 `marketing-agent/to-develop/<topic>` PR에도 auto-merge를 켜지 않는다(**2026-11-02 운영자 결정으로 이 줄은 낡았다: 졸업한 SEO 코드 PR에 한해 기본 꺼진 스위치 뒤의 develop auto-merge를 허용한다, §9.2**). 2026-10-02부터 `Auto PR to Develop`은 PR을 열기만 하고, 병합은 운영자가 실행하는 merge train(`npm run merge-train`)이나 사람이 한다. 졸업이 바꾸는 것은 사람 검토 없이 병합 대기열에 들어갈 수 있다는 것이지 auto-merge가 아니다. **(2026-10-16 운영자 결정, S3 계획 D1·D2·D7)** 마케팅 LLM 비용 원장 `MarketingLlmCall`을 다섯 번째 마케팅 전용 표로 더한다(§1 O1, §5, §12.2). 생성 서비스의 임시 전용 키 공급사는 OpenAI이고(O14), 월 상한은 US$100이다(§5) |
| 5 | 2026-10-18 mposition | **(2026-10-17 운영자 결정: 경쟁사는 상수가 아니라 DB 등록부와 사람의 승인, 사실은 사람이 승인한 고정 페이지에서, 웹 검색은 신규 경쟁사 탐색에만)** 경쟁사 등록부 `MarketingCompetitor`를 여섯 번째 마케팅 전용 표로 더한다(§1 O1, §5, §12.2). A3의 출처 규칙(§4.1)을 정한다. 이 표와 그 위의 고정 페이지 추출(A3 실행)은 버전 4 아래에서 정책 버전 증가 없이 먼저 구현됐다(공개 PR #2646·#2647·#2649·#2653·#2656, develop만, production 미배포). 작성자의 절차 누락이며, 이 판이 승인되기 전에는 그 코드를 production release에 넣지 않았다 |

운영자 결정(아래 §1)은 운영자가 대화 세션에서 내린 것이고, 나머지 계약은 Claude가 설계하고
Codex가 11회에 걸쳐 독립 검토한 설계(최종 판정 approve-with-changes, 요구 변경 반영)를 옮긴 것이다.

운영자 `mposition`이 2026-09-17에 이 문서를 승인했다(버전 1, 같은 날 버전 2 변경 승인). 이제 이 문서는 마케팅 자동화 구현의
규범 근거다. **승인은 단계별 착수 조건을 없애지 않는다** — §14의 순서와 완료 기준, §8의 "S0 채널별 복구 계약
확정 전 자율 게시 불가", 각 단계의 교차 검토는 그대로 적용된다. 되돌릴 수 없는 결정(AGENTS.md의 승인 목록)을 바꿀 때만 운영자 승인이 필요하고, 그 밖의 구현 세부는 운영자가 대화로 정해 코드 PR에 한 줄로 기록한다(2026-10-19).
`AGENTS.md` 포인터는 첫 구현 PR에서 대상 경로와 함께 추가한다.

이 문서는 마케팅 자동화 — SNS 게시, 랜딩 문구 실험, SEO 코드 변경, 시장 정보 수집, 성과 측정 —
를 건드리기 전에 읽는 단일 기준이다. 이메일 마케팅은 범위 밖이며
`docs/policy/email-notifications.md`가 계속 유일한 기준이다.

## 0. 이 문서가 막으려는 것

사람 검토 없이 공개되는 문장은 **회수할 수 없다.** 캡처·색인·재공유가 삭제보다 빠르다.
그래서 이 정책의 모든 조항은 세 질문 중 하나에 답한다.

1. 사람이 보지 않은 문장이 공개될 수 있는가, 있다면 그 문장은 어디서 왔는가.
2. 사실이 아닌 주장(가격·기능·모델·비교)이 자동 경로를 통과할 수 있는가.
3. 자동화가 스스로의 게이트·권한·감사 기록을 바꿀 수 있는가.

## 1. 운영자 결정

변경은 운영자만 한다. 설계는 이것을 입력으로 따른다.

| # | 결정 |
|---|---|
| O1 | 범위: 에이전트 5개, 마케팅 전용 테이블 6개(버전 4에서 LLM 비용 원장, 버전 5에서 경쟁사 등록부 추가), Admin Console 관리 화면 |
| O2 | 소셜 게시·랜딩 문구 실험·SEO 코드 모두 **첫 1주 승인 → 졸업 후 자율**(D5). 단 Instagram·TikTok 계정은 제외(O15) |
| O3 | 졸업 조건(계정·표면 단위, 모두 충족): 첫 실행 성공 후 7일(서버가 기록한 불변 시각) · 승인 3건 이상 · 수정률 1/3 이하(분모에 거절 포함) · 운영자 확인 1회 |
| O4 | 자율 모드의 문구는 **승인된 템플릿·문구 라이브러리만**. 새 문구는 모드와 무관하게 승인 큐 |
| O5 | 게시 인프라는 Zernio, 교체 가능한 어댑터 뒤. 계정·게시·오류 상태의 원장은 Tomverse DB |
| O6 | 연결 계정 9개: LinkedIn 1, X 1, Facebook 1, YouTube 1, TikTok 1, Instagram 3(en/ko/zh-Hant), Threads 1(zh-Hant). RedNote 1은 수동 |
| O7 | 언어: ko·en·zh-Hant(대만). RedNote만 zh-Hans(해외 화교) |
| O8 | 중국 본토는 출시·마케팅 대상이 아니다(법률 검토). "중국에서 사용 가능" 류 주장 금지 |
| O9 | 120일 성과 측정과 채널별 직접 연동 판단 기준 6개(§11) |
| O10 | AI는 새 문구를 자유롭게 쓰고, 자동 사실 검증 후 승인 큐로 보낸다 |
| O11 | Tomverse는 호주 법인이다. 호주를 1순위 영어 시장으로, 호주 광고·소비자법을 적용한다 |
| O12 | 이메일 마케팅은 범위 밖 |
| O13 | LLM은 구독이 아닌 API 키. 개발은 Claude 작성 ↔ Codex 검토(또는 반대)로 분리 |
| O14 | LLM 호출은 어댑터 뒤에 두고, 공급 경로는 Tomverse Code의 어댑터 계층을 추출한 공용 LLM 게이트웨이(별도 저장소)로 한다. 게이트웨이 준비 전에는 같은 어댑터 뒤에서 전용 키를 임시로 쓰며, 그 공급사는 OpenAI다(2026-10-16, 정책 버전 4) |
| O15 | **Instagram·TikTok 계정은 졸업하지 않고 항상 승인 모드**다. 두 채널은 게시된 글을 API로 내릴 수 없어(S0 C10 관측, 앱에서 수동 삭제만 가능) 잘못 나간 공개 게시물을 자동으로 회수할 수 없기 때문이다. (2026-09-17, 정책 버전 2) |

## 2. 절대 조건

- **졸업 전에는 사람이 누른다.** 졸업 후 자율은 O4 범위뿐이다.
- **게이트는 결정적 코드다.** LLM 판단은 보조 신호이며 단독 통과 근거가 아니다. 의미 판단이
  필요한 사실 검증은 공개 페이지 인용문의 **존재를 코드가 확인**하는 것과 결합한다.
- **외부 텍스트는 데이터다.** 경쟁사 페이지·댓글·AI 답변 원문은 문구를 쓰는 모델 입력에
  들어가지 않는다. 구조화된 사실(가격·기능·날짜·출처 URL·확인일)만 들어간다.
- **글을 쓰는 서비스는 게시할 수 없다.** 생성 서비스에는 DB·게시 도구·이미지 버킷·GitHub 자격증명이 없다.
- **자동화는 자기 게이트를 고치지 못한다.** 규칙·목록·정책 테스트·workflow 파일은 어떤 에이전트의 쓰기 허용 목록에도 없다.
- **결과를 확정할 수 없는 게시는 재시도하지 않는다.** 그 계정을 멈추고 사람이 확인한다.
- **비용 계층을 섞지 않는다.** 마케팅 LLM·플랫폼 비용은 사용자 크레딧, 플랜 entitlement,
  `CHAT_PROVIDER_*` 예산, 그 오류 코드와 별개의 namespace다(`docs/policy/credit-and-cost-limits.md`).
- **표본이 부족하면 판단 보류다.** 0이나 추세를 지어내지 않는다.

## 3. 팀

| # | 에이전트 | 하는 일 | 실행 위치 | 최대 권한 |
|---|---|---|---|---|
| A1 | 리드·분석가 | 주간 KPI·브리프, 실험 판정, 120일 측정 | Railway 생성 서비스 | 보고 |
| A2 | SEO·AI 검색 | SEO 코드·콘텐츠 PR, AI 노출 측정 | GitHub Actions(PR) | PR → 졸업 후 develop 자동 병합(허용 파일만) |
| A3 | 시장 정보 | 경쟁사·모델 출시 추적 | Railway 생성 서비스 | 보고(게시 권한 없음) |
| A4 | 랜딩 실험 | 문구 변형·실험 설계·결과 분석 | Railway 생성 서비스 + PR | 초안 → 졸업 후 실험 자율 시작 |
| A5 | 콘텐츠·소셜 | 계정별 게시물, RedNote 패키지, 댓글 위험 요약 | Railway 생성 서비스 | 초안 → 졸업 계정만 템플릿 자율 게시 |

그 위에 결정적 게이트(Guard, §7)가 있다. Guard는 에이전트가 아니다.

## 4. 구성과 신뢰 경계

```
marketing-generator (Railway)  ── LLM 키, 제출용 secret만
   │ private network, 구조화 초안(64KB·20건 상한, idempotency key, provenance HMAC)
   ▼
Tomverse 본 앱 ── Guard 재실행(생성기 결과를 신뢰하는 분기 없음) ── 저장
   │                                    │
   ▼                                    ▼
Admin Console 승인 큐             marketing-publisher (Railway cron)
                                        │ 본 앱 게시 route 호출
                                        ▼
                                  Zernio 어댑터 (Zernio 키·이미지 버킷 자격증명은 본 앱에만)
```

- 내부 route 인증은 기존 maintenance cron의 규율을 따른다: 32자 이상 secret, Bearer,
  SHA-256 후 constant-time 비교, POST, `no-store`, 타임아웃, 실패 시 구조화 incident 로그.
  근거: `scripts/run-maintenance.mjs`, `app/api/internal/maintenance/cleanup/route.ts`.
- Zernio 형식은 어댑터 밖으로 나가지 않는다. 어댑터 표면은 게시·상태·취소(지원 여부 반환)·
  webhook 해석·댓글 조회·채널별 capability다.
- 플랫폼 OAuth 토큰은 Zernio가 보관한다. Tomverse는 저장하지 않는다.
- 댓글 모니터 서비스(S4d, §12.1)는 생성기와 같은 자격(LLM 키·제출 secret)만 가진 별도 Railway cron이다. 댓글 조회·기록·판정은 본 앱이 한다.
- 마케팅 이미지는 기존 private R2 버킷과 **분리된 전용 공개 버킷**과 전용 자격증명을 쓴다.

### 4.1 시장 정보(A3)의 출처 (버전 5)

경쟁사 페이지와 웹 검색 결과는 외부 텍스트다(§0의 질문 2). A3는 그것을 구조화 사실이나 제안으로만 바꾸며, 어느 쪽도 사람의 결정 없이는 출처가 되지 않는다.

- **추적 대상은 사람이 정한다.** 경쟁사 등록부(§5 `MarketingCompetitor`)의 `approved` 행만 추적 대상이다.
  - A3는 등록부에 `proposed` 행을 제안할 수만 있다. 이미 있는 id(거절·은퇴 포함)는 다시 열지 않는다.
  - 승인·거절·은퇴·추가는 `marketing:write`를 가진 사람의 감사 행이 있어야 한다. DB가 그 행의 action·대상·직전 결정과, 승인이면 이름·host·추적 페이지까지 대조한다.
  - 행은 지우지 않고 은퇴시킨다.
- **사실은 승인된 경쟁사의 공식 host에서만 나온다**(운영자 결정 2026-10-19: 페이지를 직접 읽는 대신 LLM 웹 검색).
  - A3는 승인된 경쟁사마다 웹 검색을 한 번 하며, 검색은 그 행의 공식 host로 제한된다. 사실의 출처는 공급사가 같은 응답에서 인용하거나 검색으로 돌려준 URL이면서 공식 host 위여야 한다(서비스가 대조한다).
  - 앱은 보고서를 기록하는 트랜잭션 안에서 승인 host를 다시 읽어, 그 밖의 출처를 가진 사실은 저장하지 않고 센다.
  - 검색 결과는 A3의 추출 요청에만 데이터로 들어가며, A5 프롬프트·게시물·로그에 닿지 않는다. A3가 남긴 구조화 사실과 기능 이름(공식·검색된 페이지의 것만)은 같은 실행의 시장 분석 호출에도 데이터로 들어간다(2026-11-01 운영자, §4.2). 추적 페이지 열(`trackedPages`)은 남아 있지만 읽히지 않는다.
- **신규 경쟁사는 실행당 한 번의 제한 없는 웹 검색으로 찾고, 제안만 만든다.** 이 검색으로는 사실을 만들지 않는다.
  - 호출당 검색 횟수 상한이 있고, 그 최대 비용은 §5의 비용 원장 안에서 예약한다(다른 A3 호출과 같은 web-search profile).
  - 제안에는 근거 URL이 1~5개 있어야 하며, 모두 같은 응답이 인용하거나 돌려준 URL과 문자열로 정확히 같아야 한다(서비스가 대조하고, 앱은 근거 없는 제안을 거절한다). 등록부가 이미 아는 id는 상태와 무관하게 다시 제안하지 않는다.
  - Admin은 근거를 새 탭·`rel="noopener noreferrer nofollow"` 링크로 보인다. 사람이 그 근거를 열어 보고 승인·거절한다.

### 4.2 시장 분석과 주간 브리프 (2026-11-01 운영자)

- Admin 마케팅 화면의 스위치(`marketing.analysisEnabled`, 기본 꺼짐)가 켜져 있을 때만, 생성기는 A3 다음에 텍스트 호출 두 번을 기존 `brief` 목적으로 원장에 예약해 쓴다. 원장은 스위치가 꺼져 있으면 `brief` 예약을 거절한다(`purpose_disabled`). 월 상한은 그대로다.
  - 1번: Tomverse 공개 문구(홈·About·FAQ)와 저장된 플랜 값을 객관적으로 분석한다.
  - 2번: 그 분석, 우리 플랜, A3가 이번 실행에 남긴 경쟁사 사실·기능 이름, 등록된 claim으로 가격 위치·앞서는 점·뒤처지는 점·이번 주 메시지를 쓰고, 이번 주 주제(topic id)와 claim id 1~5개를 고른다.
- 결과는 `brief` 보고서 하나로 기록되고, 분석 본문은 `MarketingAnalysis`에 같은 트랜잭션으로 저장된다. 사람은 보고서 탭에서 읽는다. 모델이 쓴 출처는 https이면서 승인된 경쟁사 공식 host일 때만 링크로, 그 밖은 텍스트로 보인다.
- A5는 brief의 topic id·claim id와 claim의 문장(페이지 문자열)·가격 값만 받는다. 분석 본문과 경쟁사 사실은 받지 않는다. 생성기는 맥락에 없는 claim id를 brief에서 빼고, 추적 중인 경쟁사 이름이 들어간 topic은 버린다. 앱은 레지스트리에 없는 claim을 담은 brief를 거절한다.
- claim은 코드(`lib/marketingClaims.ts`)에 사람이 등록한다. 모델 출력은 claim을 만들거나 승인하지 않는다.

## 5. 데이터 (마케팅 전용 테이블 8개)

사용자 콘텐츠를 담는 컬럼은 없다.

| 테이블 | 담는 것 | 핵심 규칙 |
|---|---|---|
| `MarketingChannel` | **계정 단위** 연결·모드·졸업 | 재연결·scope·정책 버전 변경 시 승인 모드로 복귀하고 졸업 epoch 증가. 졸업 통계는 현재 epoch만 |
| `MarketingPost` | 초안·승인·예약·게시·결과 단일 원장 | 고정 논리 키로 중복 차단, 승인·게시 직전 envelope digest 일치, lease·CAS 원자 claim, 일·주 슬롯 원자 예약, append-only history(버전 CAS) |
| `MarketingReport` | 보고서·경쟁사 사실·실험 결과·댓글 알림·보유 실행 기록·webhook shadow 기록(§8.1.1) | 집계와 구조화 사실만 |
| `AiVisibilityRun` | AI 답변 노출 측정 | 답변 본문 미저장, digest·인용 URL·플래그만 |
| `MarketingLlmCall` | 마케팅 LLM 호출의 예약·정산(비용 원장, 버전 4) | 호출 **전에** 그 호출의 최대 비용을 예약하고, 이번 달(UTC) 합계에 새 예약을 더해 상한을 넘으면 예약을 거절해 호출하지 않는다. 합계는 정산된 호출을 보고된 토큰과 pin 단가, 과금될 수 있는 검색 수로(예약액 이하) 세고, 열린 호출과 결과를 모르는 호출은 예약액으로 센다(2026-10-23 운영자). 결과를 모르는 호출은 재시도하지 않는다. 프롬프트·응답 본문을 저장하지 않는다(공급사·모델·토큰·비용·run id만). 사용자 크레딧·플랜·`CHAT_PROVIDER_*` 예산과 별개 namespace다. 월 상한(코드 상한 US$100)과 생성기 모델은 운영자가 Admin Console에서 정하며(2026-10-19 운영자, 이전에는 환경변수; 모델은 Tomverse 모델 카탈로그에서 가격이 확인된 OpenAI 모델 중 고른다, 2026-10-23), 예약은 같은 트랜잭션에서 그 값을 읽는다. 상한이 없거나 고른 모델이 아니면 접수·예약을 거절한다 |
| `MarketingCompetitor` | A3가 추적하는 경쟁사와 그 공식 host·추적 페이지(경쟁사 등록부, 버전 5) | 상태는 `proposed`·`approved`·`rejected`·`retired`. 생성기는 `proposed`만 만들고, 결정은 사람의 감사 행과 DB가 대조한다(§4.1). 제안의 내용(근거·이유)은 고칠 수 없고, 이름·host·페이지는 승인으로만 바뀐다. 행은 삭제하지 않는다. 사용자 콘텐츠와 개인정보를 담지 않는다(공개 회사 정보와 공개 URL) |
| `MarketingAnalysis` | brief 하나의 근거가 된 시장 분석(§4.2, 2026-11-01 운영자) | brief 보고서와 같은 트랜잭션에서 한 번 쓰고 고치지 않는다. 보고서와 같은 24개월 뒤 보존 작업만 지운다. 우리 공개 문구, 공개 경쟁사 사실과 그에 대한 모델의 분석이며 사용자 콘텐츠와 개인정보가 없다 |
| `MarketingAsset` | 미디어 CLI가 만든 이미지·영상의 등록부 항목(출처·채널별 AI 표시·locale별 대체 텍스트)과 R2 파일 위치(2026-10-31 운영자) | 상태는 `submitted`·`approved`·`retired`. CLI는 `submitted`만 만들고 업로드 확인은 한 번이며, 승인·은퇴는 사람의 감사 행이 있어야 한다(승인은 정확히 그 파일의 sha256). 승인된 것만 Guard·생성기·게시기가 읽는 등록부에 들어가고, 승인·은퇴마다 등록부 버전이 오른다. 삭제하지 않고 은퇴시킨다 |

- 유입 기록은 새 테이블이 아니라 기존 분석 이벤트에 `marketing_touch`를 추가한다(§10).
- §6.1의 기능별 스위치와 랜딩 실험 활성화 설정 등 **마케팅이 쓰는 모든 `AppSetting` key**는 이름이 한곳에 선언되고
  (스위치는 `lib/appSettings.ts`가 읽고 `lib/marketingAutomationAccess.ts`가 이름을 가지며, LLM 설정은
  `lib/marketingLlmBudgetCore.ts`, 랜딩 실험 설정·카운터·사용 id 기록은 `lib/marketingExperimentContract.ts`),
  각 key가 감사 기록을 남기는 writer 또는 명시적 read-only 사유를 가진다. 스위치 key는
  `tests/appSettingWriters.test.mjs`가, 랜딩 실험 key는 `tests/marketingExperimentWriters.test.mjs`가 검사한다
  (`lib/appSettings.ts`는 Prompt Refiner 실행 closure라 새 key를 거기 두지 않는다 — 2026-11-01 서술 정정).

## 6. 승인·권한·감사

- **마케팅 승인은 `AdminActionApproval`을 쓰지 않는다.** 스키마의 요청자 컬럼은 nullable이지만, 현재 생성 route는
  사람 요청자를 기록하고 `lib/adminApprovalCore.ts`의 검토 판정은 null이 아니면서 검토자와 다른 요청자를 요구한다.
  그래서 시스템이 만든 초안의 승인을 이 모델로 표현할 수 없다. 마케팅 승인은
  "사람 1명이 시스템 초안을 승인"하는 별도 계약이다. `lib/adminSoleApproverCore.ts`의 예외 목록은 바꾸지 않는다.
- **권한:** 새 admin 권한 `marketing:write`를 `lib/adminAuthCore.ts`의 권한 union과 역할 판정에 추가하고
  `owner`·`ops`에만 준다. 모든 변경 route가 권한과 최근 인증(step-up)을 **route 안에서 직접** 검사한다.
- **승인 원자성:** 상태·digest 조건부 UPDATE가 정확히 1행일 때만 성공과 감사 기록을 남긴다.
  편집 후 승인은 서버가 다시 렌더·Guard를 통과시킨 새 digest로 한다.
- **감사:** 사람 행위와 시스템 행위 모두 `lib/adminAudit.ts`의 **기존 해시 체인**에 같은 트랜잭션으로
  기록한다. 시스템 actor용 writer는 기존 writer와 체인 잠금·해시 계산 경로를 공유한다.
  감사 테이블 직접 insert는 금지다.
- **Admin Console:** `docs/ui-contracts/admin-console-ia.md`를 따른다. 대기 건수 badge는
  `lib/adminNavigationCounts.ts` 규율(실패 시 미표시), 로케일은 `tests/adminLocale.test.mjs` 검사 대상이다.
  알림은 링크만 보내고 승인 행위는 Admin Console에서만 한다.

### 6.1 기능별 스위치

하나의 on/off가 아니라 기능별로 판정한다. 입력 중 하나라도 읽기에 실패하면 그 기능은 꺼짐이다.
패턴은 `lib/chatStarterAccess.ts`의 저장값 + 환경변수 kill switch 합성을 따른다.

| 기능 | 필요한 입력 |
|---|---|
| 기록 열람 | 관리자 인증(스위치 무관) |
| 초안 접수 | 초안 스위치 · kill switch 아님 · LLM 생성 예산 이내 · 생성기 인증 |
| 시장 분석·주간 브리프(§4.2) | 분석 스위치(`marketing:write` + step-up으로 켬, 기본 꺼짐) · kill switch 아님 · LLM 생성 예산 이내(원장이 `brief` 예약 때 스위치를 다시 읽음) |
| 수동 승인 | `marketing:write` + step-up · 초안 스위치 · kill switch 아님 (LLM 예산과 무관) |
| 승인 모드 게시 | 게시 스위치 · kill switch 아님 · 계정이 승인/자율 모드 · 어댑터 health · 채널 복구 계약 존재 · 플랫폼 예산 이내 |
| 자율 게시 | 승인 모드 게시 조건 · 자율 스위치 · 계정 자율 모드 · 댓글 모니터링 동작 · 채널이 API 게시 취소 가능(Instagram·TikTok 제외, O15) |
| 졸업 | `marketing:write` + step-up · O3 · 댓글 모니터링 동작 · 채널이 O15 대상 아님 |
| 실험 활성화 | 실험 스위치 · kill switch 아님 · 캐시·CSP 스파이크 통과 기록 · (승인 모드) `marketing:write` + step-up / (자율) 표면 졸업 |
| SEO 자동 병합 | 에이전트 스위치 · `MARKETING_SEO_AUTO_MERGE=true`(기본 꺼짐) · kill switch 아님 · 졸업 기록(`MARKETING_SEO_AUTO_PR=true`) · 게시 단계와 같은 서명·tree·허용 4개 파일 재검증 · PR이 develop 기준·열림·draft 아님·검증한 commit 그대로 (§9.2) |
| webhook shadow 처리 | shadow 스위치 · staging 환경 · kill switch 아님 · 서명 검증 통과 (§8.1.1) |
| webhook 상태 반영 | 상태 반영 스위치 · kill switch 아님 · 이벤트가 스위치의 허용 event type·채널 범위 안 · 운영자 서명된 §8.1.1 기록이 있고 그 뒤 해당 코드·설정·스키마 변경 없음 |

kill switch 환경변수는 기록 열람을 제외한 전부를 끈다.

## 7. Guard

### 7.1 잠정 언어 진단과 입력 위생

아래 아홉 문장 해석 범주는 **잠정 진단**이다. 규칙 하나 이상이 감지되면 Guard는
`provisional_language_flag` 승인 코드 하나와 감지한 세부 rule id를 모두 남기고 사람에게 보낸다.
이 진단만으로 `reject`하지 않으며 `banned_claim`을 만들지 않는다. §7.2의 `rule.free-wording`도
같은 계약을 적용해 `free_wording_without_condition`을 만들지 않는다. 사람은 독립된 입력 위생·
claim/asset·provenance 거절이 없는 경우에만 이 언어 플래그가 붙은 문구를 승인할 수 있다.

- 저장소 계약의 금지어(better·best·optimal·smartest와 번역), 최상급·보장·"#1".
- AI Review 계약: 사실 검증·보장, 모델 합의, "서로 다른 provider", 출처 일치도를 정확도로 표현.
- 반례가 확인된 우월 주장: 유일한/최초의 다중 모델 비교·교차검토, 유일한 다중 모델 이미지·영상 비교,
  HWP를 읽는 유일한 AI, 사실 검증은 우리만, 2차 출처 경쟁사 가격.
- 중국: 본토 이용 가능, 본토 결제·가입 유도.
- 호주: 가짜 긴급성("오늘만", 카운트다운), 16세 미만을 겨냥한 표현.

이 잠정 진단에 다시 거절 권한을 주려면 정규식 패턴을 더하는 것이 아니라 tokeniser와 형태소 분석으로
교체하고 정책 테스트를 변경해 검토받아야 한다. 배포 설정이나 `AppSetting`은 이 권한을 바꿀 수 없다.

입력 위생은 언어 판단이 아니다. 제어문자·양방향 제어문자·zero-width 문자·멘션·URL-like token·
Markdown/HTML link markup·prompt-injection marker는 byte/구조 사실이므로 계속 거절한다.

### 7.2 사실 검증 (새 문구마다, 템플릿은 템플릿 승인 시)
1. 초안의 사실 주장을 유형별로 구조화 추출한다(가격·플랜·모델·기능·비교·이용 가능 지역).
2. **가격:** localized 카탈로그는 `lib/billingPriceCatalog.ts`의 메타 포함 reader에서 `source`가 저장값일 때만 허용한다.
   USD 플랜은 현재 `lib/billingConfig.ts`의 reader가 저장 행과 코드 기본값을 병합하고, 연간가가 비어 있으면
   공식으로 계산하면서 출처를 반환하지 않는다. 그래서 **필드마다 `stored | compiled_default | derived_formula`를
   반환하는 읽기 전용 metadata reader를 새로 구현**하고, 게시에 쓰는 모든 가격 필드가 `stored`일 때만 통과시킨다.
   하나라도 아니면 거절하고 운영자에게 경보한다.
3. **호주 대상 가격:** AUD, GST 포함 총액만. 세무 확인 전에는 호주 대상 가격 게시 자체가 승인 범주다.
4. **"무료":** 같은 게시물의 조건(크레딧 한도) 문구 누락은 잠정 언어 진단이다. 누락 시
   `provisional_language_flag`와 `rule.free-wording`으로 승인 큐에 보내며 그 자체로 거절하지 않는다.
5. **모델:** 운영 registry에서 카탈로그 삭제되지 않은 행을 읽고 `lib/models.ts`의 `isPubliclySelectableModel()`을
   재사용한다. 최소 플랜 표기를 대조한다.
6. **기능·이용 가능성:** 검증 모델이 Tomverse 공개 페이지의 근거 문장을 인용하고, 코드가 그 인용문의 존재를
   확인한다. production에 공개되지 않은 기능은 거절한다.
7. **비교:** 항상 승인 범주. 근거 URL과 비교 범위를 함께 저장한다.
8. 추출 실패·검증 불가는 승인 큐로 간다.

### 7.3 링크·자산
- 모델은 URL을 쓰지 않는다. 승인된 경로 목록의 id만 고르고, 서버가 URL API로 조립해
  origin을 확인한 뒤 UTM을 붙인다.
- 캡션 링크를 걸 수 없는 채널(Instagram·TikTok)은 계정별 고정 프로필 링크 UTM을 쓴다.
- 자산은 승인된 자산 목록의 id만 쓴다. 출처(캡처·운영자 업로드·AI 생성·AI 변형)와 채널별 AI 표시 결정을 함께 둔다.
  AI 생성 이미지·영상으로 제품 UI를 흉내내지 않는다.
- 승인된 자산 목록은 사람이 쓰는 `docs/marketing/asset-registry.json`과, 미디어 CLI(AMUX 박스의 Claude Code)가 제출하고
  사람이 Admin에서 승인한 `MarketingAsset` 행을 합친 것이다(2026-10-31 운영자). CLI는 파일을 R2에 올리고 제출만 하며,
  게시 키를 갖지 않는다. 영상·이미지가 말하는 것(locale별 대본·화면 문구)은 제출과 함께 오고, 행을 만들기 전에 초안 접수와
  같은 Guard를 거친다. 거절이면 저장하지 않는다. 대본 표나 별도 승인 화면은 없고, 사람은 Admin에서 파일과 대본을 함께 본다.

### 7.4 항상 승인
새 문구, 새 claim·자산의 첫 사용, 경쟁사 이름·비교, 가격·프로모션·할인·"무료", 장애·보안·사건,
사용자 사례·후기, 법률·정책 안내, RedNote 전체, 호주 대상 가격 게시물.

### 7.5 자동화 금지
댓글 답글, DM, 팔로우, 좋아요, 멘션, 광고 집행, 타 계정 재게시, UI 자동화·scraping, 인플루언서 게시.

### 7.6 채널별 초기값
| 채널·계정 | 언어 | 필수 형식 | 일/주 상한 |
|---|---|---|---|
| LinkedIn | en(ko 보조) | 텍스트(±이미지) | 1/3 |
| X | en | 텍스트(±이미지) | 2/10 |
| Facebook | en + zh-Hant | 텍스트(±이미지) | 1/5 |
| YouTube | en(제목·설명·자막 ko·zh-Hant) | 영상 | 1/2 |
| TikTok | en(자막 3언어) | 영상 | 1/5 |
| Instagram ×3 | en / ko / zh-Hant | 이미지·영상 | 1/4 |
| Threads | zh-Hant | 텍스트(±이미지) | 2/7 |
| RedNote | zh-Hans | 이미지+텍스트 | 수동 |

상한은 코드 상수이고 운영 설정으로는 **내리기만** 한다. 게시 시간창은 대상 시장 현지 09:00~20:00,
같은 claim은 계정당 14일 안에 다시 쓰지 않는다.

## 8. 게시와 상태

### 8.1 게시
- 게시기는 대상 행을 lease·claim token으로 원자적으로 잡고, 같은 트랜잭션에서 계정 슬롯을 예약한다.
- 게시 직전 kill switch·계정 모드·빈도·claim/asset 유효기간·digest·승인 만료를 다시 확인한다.
- 요청 키는 논리 키로 고정한다. 응답이 확정되면 게시됨, 확정할 수 없으면 `outcome_unknown`과 계정 정지.
- 공개 여부는 상태 조회로 확인하고, 아래 webhook 검증을 통과한 뒤에는 서명 검증된 webhook을 추가 출처로 대조한다.
  로그인 벽이 있는 채널은 주 1회 표본을 사람이 확인한다.
- **webhook은 받는 곳에서 검증한다.** 수신 route는 Railway의 본 앱에 두며, **S2에서 staging의 실제 수신 route로** 검증한다
  (S0 check C9를 이관). 그 검증이 통과하기 전에는 webhook 이벤트를 게시 상태·공개 여부·자동 정지 판정의 근거로 쓰지 않고,
  상태 조회와 요청 키 lookup만 쓴다.
- 채널별 중복·복구 계약(native idempotency / exact lookup / recovery 불가)은 S0 검증에서 확정하며, 확정 전에는 자율 게시 불가.
  승인 모드의 복구 계약은 "결과를 모르는 게시물은 사람이 해결하고 계정은 멈추지 않는다"이며, §6.1의 플랫폼 예산은 §7.6 채널별 일/주
  상한이다(2026-10-31 운영자).

#### 8.1.1 webhook 검증과 활성화
webhook 소비는 **두 기능으로 나누고 둘 다 기본 꺼짐**이다(§6.1).
- **shadow 처리(staging 검증용):** 서명 검증을 통과한 이벤트를 event id 중복 제거·저장·상태 매핑까지 **실제 코드 경로 그대로**
  처리하되, 결과를 게시 원장·계정 모드·공개 여부·자동 정지와 **분리된 shadow 기록**(`MarketingReport`의 전용 유형)에만 쓴다.
  shadow 기록에는 event id digest, event type, 채널, 도출 상태, 상태 조회 대조 결과만 두고 raw body·게시 본문·댓글·계정 handle은
  저장하지 않는다. 90일 뒤 삭제한다(§12.2). 게시 상태에는 어떤 경우에도
  영향을 주지 않는다. **staging에서만** 켤 수 있고, production에서는 환경 판정으로 거절한다. 아래 조건 3–5는 이 기록으로 관측한다.
- **상태 반영(운영 활성화):** 검증된 이벤트를 상태 판정의 추가 출처로 쓴다. 운영자가 아래 기록을 확인한 뒤에만 켠다.
  스위치 값에 **허용 event type 목록과 채널 범위**를 함께 저장하고, 목록 밖의 이벤트는 켜진 뒤에도 판정에 쓰지 않는다.
  켜기·범위 변경·끄기는 `marketing:write` + step-up으로만 하고, 같은 트랜잭션에서 **운영자를 actor로** 기존 해시 체인 감사 기록에
  남긴다(검증 기록 참조, 허용 범위, 배포 SHA 포함). 시스템 actor writer로 기록하지 않는다.
  kill switch는 이 기능도 끈다.

**범위.** 허용 범위는 운영자가 서명한 검증 기록에 **실제로 관측된 `event type × MarketingChannel` 조합의 부분집합**이다.
검증하지 않은 채널·계정이나 event type으로 통과를 넓히지 않는다. 넓히려면 그 조합을 새로 검증해 기록한다.

**통과 조건 — 활성화할 범위의 event type마다 아래가 모두 staging에서 관측될 것:**
1. 유효 서명(`X-Zernio-Signature`, raw body HMAC-SHA256)의 Zernio 이벤트는 수락되고 shadow 기록에 남는다.
2. 서명이 없거나 틀린 요청, body를 한 바이트 바꾼 요청은 **파싱·기록 전에** 거절되고 shadow 기록도 바꾸지 않는다.
3. **이미 처리한** event id를 다시 받으면(Zernio redeliver 포함) shadow 상태를 두 번 바꾸지 않는다.
4. **처리가 확정되지 않은** event(수신 후 저장 전에 실패시킨 경우)를 Zernio가 재전송하면 **정확히 한 번** 처리된다.
   3과 4는 같은 성공 event를 두 번 보내는 것으로 동시에 통과시킬 수 없다.
5. 같은 게시물에 대해 shadow가 도출한 상태와 상태 조회 결과가 일치한다.

**기록.** 검증 실행자는 staging 배포 commit SHA, 검증한 event type·채널, 조건 1–5의 관측과 증거를
운영 검증 기록(`docs/ops/` 아래 marketing webhook 검증 기록)에 남기고, **판정과 서명은 운영자**가 한다.
**조건 1–5의 결과에 영향을 주는 코드·설정·스키마**(수신 route, 서명 검증, event id 중복 제거, 저장 트랜잭션, 상태 매핑,
상태 조회 대조)가 바뀌면 기록은 그 SHA까지만 유효하고, 상태 반영 기능은 재검증 전까지 판정에 쓰지 않는다.

### 8.2 계정 모드
| 현재 | 사건 | 다음 |
|---|---|---|
| 연결 대기 | 어댑터 연결 확인 | 승인 모드(시작 시각 기록) |
| 승인 모드 | O3 충족 + 운영자 확인 (Instagram·TikTok 계정은 해당 없음, O15) | 자율 모드(졸업 스냅샷 고정) |
| 어느 모드든 | kill switch·자동 정지 | 정지(이전 모드 기록) |
| 정지 | 운영자 재개 | **승인 모드**가 기본. 자율 복귀는 운영자의 명시 선택과 사유가 있고, **정지 직전 자율 모드였던 O15 대상이 아닌 계정**에만 가능 |
| 어느 모드든 | 재연결·scope·정책 버전 변경 | 승인 모드 |
| 정지 중 지난 예약 | 재개 | 자동 게시하지 않고 승인 만료로 전환 |

**S4b 구현 상태(2026-11-01).** 졸업은 Admin 계정 화면의 "자율 게시로 졸업" 버튼(`marketing:write` + 재인증,
감사 `marketing_account.graduate`)이 `graduateMarketingChannel()`을 부르는 것이 유일한 경로다. 서버가 계정 행 잠금 아래에서
O3를 다시 계산한다: 현재 승인 기간(`approvalStartedAt` 이후)에서 첫 게시 성공 후 7일, 승인 3건 이상, 수정 비율
(수정된 승인 ÷ (승인 + 운영자 반려)) 1/3 이하, 댓글 모니터링 정상, Instagram·TikTok 아님. 미충족 사유는 모두 한 번에 화면에 보인다.
스냅샷(`graduationSnapshot`)에는 건수와 비율만 고정한다. 댓글 모니터링(S4c)이 없는 동안 `comments_monitor_unhealthy`로 모든 계정의 졸업이
거절된다. 자율 게시 스위치는 졸업이 건드리지 않는다.

### 8.3 자동 정지 (구현된 트리거만 안전장치로 계산)
| 트리거 | 출처 | 범위 |
|---|---|---|
| Guard 거절률 30% 초과(최근 20건) | 게시 원장 | 계정 |
| 연속 실패 3회, `outcome_unknown` 1회 | 게시 원장 | 계정 |
| 운영자의 삭제·문제 표시 | Admin Console | 계정 |
| 플랫폼 제거·정책 경고 | 1시간 상태 조회(3시간 무응답 시 정지). webhook은 §8.1.1 상태 반영 기능이 켜진 뒤에만 추가 출처 | 계정 |
| 위험 댓글 알림 24시간 미처리 | 1시간 댓글 조회 | 계정 |
| 게시 직접 의존성(DB·어댑터) 실패 | 게시 전 점검 | 전체 |
| claim·자산 목록 버전 변경 | 목록 버전 | 해당 claim을 쓴 초안만 무효 |
| 가격 카탈로그 변경 | 저장 행 갱신 시각 | 가격 claim 무효 |
| 본토 접근 차단 해제 감지 | 주 1회 조회(설정 무변경) | RedNote 패키지 생성 중단 |

`/api/ready` 전체 상태는 트리거로 쓰지 않는다.

**S4a 구현 상태(2026-11-01).** Guard 거절률(최근 20건 중 7건 이상, 20건 미만이어도 분모 20)·연속 실패 3회·플랫폼
제거(`removed_by_platform`)는 승인·자율 두 모드 모두 계정을 정지한다. 게시기가 계정을 claim하기 전과 Guard 거절 draft를
기록한 같은 트랜잭션에서 `evaluateMarketingAutoPause()`가 채널 잠금 → 상태 변경 → 시스템 감사
(`marketing_account.auto_paused`, 사유 코드는 `pauseReasonCode`)를 한 번에 한다. 증거는 계정의 마지막 "새 출발"
(승인 모드 시작, 직전 자동 정지·재개 감사 시각 중 늦은 것) 이후만 센다. 운영자 재개는 사유 코드를 보지 않는다.
`outcome_unknown`은 기존대로 자율 모드만 정지한다(운영자 결정 D3). 운영자 삭제·문제 표시는 기존 `operator_problem_report`
정지를 쓴다. 댓글 24시간 미처리 정지는 S4c, 1시간 상태 조회 무응답·본토 차단 해제 감지는 아직 없다.

## 9. 랜딩 실험과 SEO 코드

### 9.1 랜딩 실험
- 마케팅·locale 레이아웃은 정적 렌더(`force-static`, `revalidate=false`)이고 랜딩 문구는 7개 locale 정적 계약
  테스트(`tests/landingContent.test.mjs`)를 받는다. 그래서 **변형 문구는 버전 고정 코드 번들**이며 수정은 새 버전이다.
- 각 변형은 빌드 시 별도 정적 경로(`noindex`, sitemap 제외)로 prerender하고, 요청 경계(proxy)에서 원 URL을
  변형 경로로 rewrite한다. 정적 CSP 해시(`lib/staticMarketingCsp.ts`)는 rewrite 대상 경로 기준으로 계산한다.
- 배정 쿠키와 노출 이벤트는 분석 동의·고지 조건이 참일 때만. 거짓이면 항상 기본 문구이고 측정에서 제외한다.
- 실험 중인 경로는 사용자 간 캐시가 섞이지 않도록 private·no-store와 캐시 우회 규칙을 쓴다.
- 활성화 설정에는 문구가 없다(실험 id·변형 버전·배정 비율 50% 이하·기간·중단 규칙). 읽기 실패 시 기본 문구.
- 대상 표면: 홈·검색 intent 페이지의 헤드라인·부제·CTA. 가격·결제·약관·개인정보·환불·Auto·starter·AI Review 설명은 제외.
- 사전 등록(가설·주 지표·최소 표본·고정 기간·중단 규칙) 없이는 시작하지 않는다. 승자의 영구 반영은 PR.
- 구현 전 캐시·CSP·rewrite 스파이크를 E2E로 통과해야 하며, 실패하면 실험은 연기한다.

**현재 구현 (2026-11-01, 운영자 지시로 정함 — 구현 설명이며 위 구속 조건을 바꾸지 않는다)**
- 스파이크: `tests/e2e/landing-experiment-spike.spec.ts`(동의 없음→기본 문구·쿠키 없음, 동의+배정→변형, 사용자 간 캐시 혼입 0건, CSP 해시·위반 0건). 통과 기록은 `lib/marketingExperimentCore.ts`의 `MARKETING_EXPERIMENT_SPIKE`이고, 시험이 그 E2E 파일의 존재를 확인한다.
- proxy는 DB를 읽지 않는다. 배정 쿠키(`tv_exp=<실험id>.<번들id>.<arm>.<언어들>`, 언어는 사전 등록된 언어를 붙여 쓴 `enko`)가 rewrite의 유일한 근거이며, 쿠키는 배정 route가 분석 동의(동의 provider와 같은 규칙: 수락, 또는 미결정이면서 notice_opt_out 국가)와 활성 실험을 확인했을 때만 발급한다. 문서 요청(`Accept: text/html`, Flight 요청 제외)의 홈(`/`, `/{locale}`)만 rewrite하고, 대상 HTML이 이 빌드에 없으면 기본 페이지를 낸다. 규칙은 `lib/marketingRoutes.ts`에 있다(proxy가 새 로컬 import를 얻으면 Prompt Refiner 실행 closure가 커지기 때문).
- 모든 랜딩 화면의 beacon(`components/marketing/LandingExperimentBeacon.tsx`)이 쿠키를 다시 확인한다. 실험이 멈췄거나 동의가 사라졌거나 다른 실험의 쿠키면 route가 쿠키를 지우고 변형 화면은 한 번 다시 불러 기본 문구로 돌아간다. 즉 중단·동의 철회는 방문자의 **다음 랜딩 화면**에서 효력이 생기고, kill switch 환경변수는 proxy에서 즉시 rewrite를 끈다.
- 변형 화면의 beacon이 활성 실험 상태를 읽지 못했다는 답(503; 상태 조회 앞의 속도 제한 DB 호출이 실패한 경우도 같다)을 받으면, 배정 쿠키는 그대로 두고(저장소가 회복돼도 다른 arm으로 다시 뽑히지 않게) 짧은 보류 쿠키 `tv_exp_hold`(5분, 값 `1`)를 심고 한 번 다시 불러 기본 문구를 낸다. 보류 쿠키가 있는 동안 proxy는 rewrite하지 않고 직접 변형 경로 요청도 홈으로 보낸다. 보류 쿠키도 동의 철회 때 배정 쿠키와 함께 지운다.
- 집계 요청이 서버의 확정 거절(읽기 실패 503, 집계 실패 500, 속도 제한 429)로 끝나면 beacon은 세션의 노출·전환 표시를 되돌려 다음 방문이 다시 센다. 응답 자체가 없는 실패는 집계됐는지 알 수 없으므로 되돌리지 않는다.
- 첫 화면은 어느 arm이든 기본 문구이며 집계하지 않는다(대조군만 집계하면 대조군에 유리해진다). 노출은 쿠키가 이미 있던 화면에서, 렌더된 arm이 쿠키의 arm과 같을 때만 브라우저 세션당 한 번 센다. 전환은 주 CTA 클릭 한 번(세션당)이다. 집계는 `AppSetting`의 원자적 증가 행이며 페이지 세션 수이지 방문자 수가 아니다.
- 사전 등록의 중단 규칙은 집계에서 평가한다. 조건이 처음 충족된 것을 본 요청이 "충족 기록" 행(`marketingAutomation.experimentTripped.<id>`)을 한 번만(`ON CONFLICT DO NOTHING`) 남기고, 그 뒤 실험은 비활성으로 읽힌다 — 집계가 계속 움직여도(늦게 도착한 클릭 등) 되살아나지 않는다. 이 행은 집계에서 파생된 사실이고 운영자 결정이 아니므로 카운터와 같은 종류의 기록(감사 행 없음)이며, 사람이 Stop을 누를 때 감사 기록과 보고서가 남는다. 안전한 방향(기본 문구로 복귀)으로만 작동한다.
- 분석 동의는 브라우저가 알리는 값(localStorage의 동의 키)을 서버가 국가별 동의 정책(`resolveAnalyticsConsentPolicy`)과 맞춰 보는 방식이며, 분석 이벤트 입력 route와 같은 신뢰 수준이다. 교차 출처 POST는 proxy의 변경 요청 출처 검사가 막으므로 다른 사이트가 쿠키를 심을 수 없다. 방문자의 활성 실험 조회는 인스턴스별로 15초 캐시된다(Admin 중단·충족 기록은 그 안에 반영).
- 쿠키와 집계는 방문자가 읽고 조작할 수 있는 클라이언트 증거다. 속도 제한(IP당 분 60·일 2,000) 안에서 자기 arm을 바꾸거나 노출·클릭을 되풀이해 결과에 편향을 줄 수 있으며, 그래서 Admin 화면과 보고서는 이 증거 수준("브라우저가 세고 서버가 기록")을 그대로 적고 서명된 사실로 쓰지 않는다. 저장소를 읽지 못한 요청은 쿠키를 지우지 않고(재배정으로 arm이 바뀌는 것을 막는다) 아무것도 세지 않는다.
- 시작·중단은 Admin(`marketing:write`+step-up)이며 사람 감사 기록을 같은 트랜잭션에 남긴다. 중단은 두 arm의 `experiment_result` 보고서를 쓴다. 한 번에 실험 하나. 실험 id는 시작할 때 남기는 영구 기록 행(`marketingAutomation.experimentUsed.<id>`)으로 재사용을 막는다(이전 실행의 쿠키가 새 실행의 배정으로 인정되면 결과가 섞이기 때문).
- 캐시: 변형 응답은 `private, no-store`와 `X-Robots-Tag: noindex`다(Next가 `Vary`를 자기 값으로 덮어쓰므로 `Vary: Cookie`에 기대지 않는다). 공유 캐시(Cloudflare)에서 `tv_exp` 쿠키가 있는 `/`·`/{locale}` 요청을 캐시 우회하는 규칙은 코드 밖 설정이며, 실험을 켜기 전 운영자가 적용해야 한다(없으면 쿠키 방문자도 캐시된 기본 페이지를 받을 뿐 변형이 섞이지는 않는다).

### 9.2 SEO 코드
- LLM 단계: 저장소 읽기 권한과 LLM 키만, 도구는 읽기·편집만, 저장소 설정·MCP·hook 미로드, 버전·무결성 고정, 턴·예산 상한.
  이 줄은 SEO 코드 단계에만 적용한다. 이미지·영상을 만드는 미디어 CLI는 플러그인과 MCP를 쓸 수 있고, 결과는 §7.3의 제출과 사람 승인을 거친다(2026-10-31 운영자).
- 검증 단계: 허용 파일 정확히 4개(`lib/seo.ts`, `components/seo/StructuredData.tsx`, `app/sitemap.ts`, `app/llms.txt/route.ts` — 마지막은 환경변수 `LLMS_TXT_ENABLED=true`일 때만 응답하는 기본 꺼진 실험 route이고, 문구·링크는 `tests/llmsTxtRoute.test.mjs`가 판정한다)
  밖의 변경·rename·삭제·바이너리·symlink·mode 변경 거부, 500줄 이하, lint·typecheck·테스트, **base 커밋의 정책 테스트로** 판정.
  판정 테스트는 사람 소유 파일이며 허용 목록에 없다.
- PR 생성: 이 저장소 전용 GitHub App 토큰, 검증 산출 tree hash와 push 내용 일치 시에만.
- 브랜치: 졸업 전 `marketing-agent/<topic>`(자동화 권한 없음, 사람 병합). 졸업 후
  `marketing-agent/to-develop/<topic>`으로 표준 `Auto PR to Develop`이 PR을 만든다
  (`scripts/auto-pr-branch-policy.mjs`). develop까지만. 졸업 전 PR은 auto-merge 없이 사람이 병합한다.
  **졸업 후 PR의 auto-merge(2026-11-02 운영자 결정, 정책 버전 변경 없음):** 기본 꺼진 스위치 `MARKETING_SEO_AUTO_MERGE=true`일 때만,
  게시 단계 뒤(또는 `--phase arm`) 실행기가 GitHub의 auto-merge(`enablePullRequestAutoMerge`, merge commit)를 그 PR 하나에 켠다. 병합은 GitHub가
  develop의 required check가 통과한 뒤에 한다. 켜는 조건은 모두 결정적 코드이고 하나라도 틀리면 켜지 않는다: 에이전트 스위치 켜짐 · kill switch 비어 있음 ·
  졸업 기록(아래) · 게시 단계와 같은 재검증(서명, base가 원격 develop 위, tree·부모·diff를 git에서 다시 계산, 허용 4개 파일) · PR이 이 저장소의
  열린 PR이고(fork 제외) head 이름이 정확히 `marketing-agent/to-develop/<topic>`이며 **base가 정확히 `develop`**이고(main·release·그 밖의 base는 어떤 경우에도
  켜지 않는다) head commit이 검증한 commit과 같고(GitHub 호출도 `expectedHeadOid`로 묶는다) draft가 아닐 것. 같은 head 이름의 열린 PR이 둘이면 켜지 않는다.
  **켜 둔 채로 자리를 비우지 않는다**: GitHub는 쓰기 권한자가 commit을 더 push해도 auto-merge를 그대로 두므로, 켠 PR은 실행기가 20초 간격으로 지켜보고
  head가 검증한 commit이 아니게 되거나 base가 develop이 아니게 되면 끈다(required check는 새 head에서 다시 돌아야 하므로 이 간격이면 병합보다 먼저 본다).
  감시 창(`--wait-minutes`, 기본·최대 45분, 최소 1. 설치 토큰은 한 시간이고 해제에도 그 토큰이 필요하므로 마감은 토큰 만료 시각(GitHub 응답 헤더 또는 운영자가 주는 `MARKETING_SEO_GITHUB_APP_TOKEN_EXPIRES_AT` 중 이른 쪽)에서 10분을 뺀 절대 시각으로 줄고, 그 시각을 알 수 없거나 창이 1분보다 짧으면 push 전에 시작하지 않으며, 남은 창이 1분 안이면 켜지 않는다. 더 기다리려면 새 토큰으로 다시 실행한다)이 끝나거나, PR을 읽지 못하거나(연속 5회), 병합·닫힘 말고 어떤 이유로든 실행이 끝나거나, 오류·SIGINT/SIGTERM이 나면
  이 실행이 켠 auto-merge는 끈다(사람이 켠 것은 지켜보며 head·base가 어긋날 때만 끄고, 창이 끝났다고 끄지 않는다). PR 목록은 열린 것과 끝난 것을 따로 읽고 열린 쪽이 한 쪽(20개)을 넘으면 읽지 못한 것으로 본다. 켜는 요청은 보내기 전에 해제 대상으로 기록하므로 응답이 유실돼도 같은 경로로 끄고(해제는 세 번까지 다시 묻는다),
  켠 직후 PR을 다시 읽어 base·head가 검증한 그대로인지 확인한다. 프로세스가 강제로 죽었거나 해제 요청이 세 번 모두 실패한 경우(실행기는 오류로 끝난다)에만 사람이 PR 화면에서 끈다.
  **남는 위험**: GitHub에는 auto-merge를 특정 base에만 허용하는 설정이 없어 base 제한은 위 재확인과 감시가 하는 것이고, 쓰기 권한자가 이미 검사를 통과한
  commit으로 head를 되돌리거나 base를 바꾸는 순간부터 감시가 보기까지의 20초 안에는 GitHub가 먼저 병합할 수 있다. 쓰기 권한자는 원래 직접 병합할 수 있으므로 그 이상의 권한은 아니다.
  **한 실행에서 한 번만 켠다**: 켠 뒤 auto-merge가 다시 꺼져 있으면 사람이나 GitHub가 끈 것이고 다시 켜지 않는다(PR #1256의 교훈).
  draft는 GitHub가 auto-merge를 받지 않으므로, CI 입장 관리가 ready로 올릴 때까지 1분 간격으로 보며 기다린다(켜기 전에는 아무것도 켜 두지 않는다).
  창이 끝난 뒤에는 `--phase arm`을 다시 실행하는 것이 운영자의 행위다. kill switch는 새로 켜는 것을 막는다. 이것은 auto-merge를 켜지 않는다는
  `Auto PR to Develop`의 규칙(AGENTS.md)과 별개의 예외이며, workflow는 여전히 아무것도 켜지 않는다. 여러 PR이 연달아 병합되면 develop 배포가 겹칠 수 있다는
  2026-10-02 결정의 비용은 이 경로에 한해 운영자가 받아들였다.
  **졸업 기록**: SEO 표면에는 계정 행이 없어, 운영자가 O3를 확인한 뒤 설정하는 저장소 변수 `MARKETING_SEO_AUTO_PR`(정확히 `true`)이 졸업 기록이다.
  비어 있거나 다른 값이거나 읽기에 실패하면 졸업 전이다. 이 변수는 게시 단계가 `to-develop` 브랜치를 쓰게 하는 것이기도 하다.
- 구현(2026-11-01 운영자 결정, 정책 버전 변경 없음): 실행기 `scripts/marketing-seo-agent.mjs`와 순수 규칙 `lib/marketingSeoAgentCore.ts`.
  기본 꺼짐(`MARKETING_SEO_AGENT_ENABLED=true`만 켬, `MARKETING_AUTOMATION_KILL_SWITCH`에 값이 있으면 끔). **두 단계는 서로 다른 프로세스이자 서로 다른 기계(컨테이너)에서 돌린다.**
  검증 단계(`--phase validate`)는 격리된 clone(base 커밋)에서 도구 없는 텍스트 LLM 호출 1회(마케팅 비용 원장 그대로, 자기 목적 `seo`, 새 유료 경로 없음. 시장 분석 스위치에 묶인 `brief`를 쓰지 않는다, 2026-11-02)의 find/replace 수정안을 적용하고
  git의 diff로 판정한다(허용 4개 정확 일치, rename·삭제·binary·symlink·mode 거부, 500줄). 판정 시험은 base 커밋의 고정 목록이며 없으면 실패로 닫는다(유료 호출 전에). 시험은 파일마다 따로 돌려 junit 보고서로 확인한다: 종료 코드 0은 증거가 아니고(제안 코드가 import 중 프로세스를 0으로 끝낼 수 있다), 실패가 없고 파일 이름을 시험으로 보고하지 않으며 base가 선언한 개수 이상이 돌았어야 통과다.
  검사가 제안 코드를 실행하므로 이 단계는 게시 자격증명이 없는 일회용 러너에서만 돌리고(GitHub 토큰 변수가 있으면 시작을 거부), 검사는 허용 목록 환경으로, POSIX에서는 운영자가 정한 별도 비특권 사용자(`MARKETING_SEO_CHECK_UID`·`_GID`)로 돌린다. 그 사용자는 작업 트리를 읽기만 하고 도구 산출물(`.next`, `next-env.d.ts`)과 자기 HOME에만 쓸 수 있어, 제안 코드가 판정 시험·설정을 바꿀 수 없고 검사마다 시간 제한이 있다.
  게시할 수 있는 결과는 이 사용자로 돌린 검사에서만 나오며, 사용자가 없으면 복제도 호출도 하지 않는다(서명 키 없이 같은 사용자로 돌려 보기만 하는 `--dry-run`은 산출물을 만들지 않는다). 검사가 남긴 프로세스는 새 세션을 만든 것까지 그 사용자의 `kill(-1)`로 끝낸다. 게시 단계는 이미 있는 원격 브랜치 위에 push하지 않고, 정리 삭제는 이번 실행이 만든 브랜치가 아직 자기 commit일 때만 한다.
  스테이징된 tree를 검사 전에 고정해 검사 후·커밋의 tree가 같아야 하며, 끝에 commit bundle과 기록에 서명(`MARKETING_SEO_ATTESTATION_KEY`)한다.
  시험은 제안 코드와 같은 프로세스에서 돌아 악의적인 코드를 원리상 막지 못한다(시험 안의 `assert`를 바꾸는 코드 등). 그래서 추가되는 줄에서 그 길을 닫는 심층 방어를 둔다 — 허용 import(`next`·`react`·`@/lib|components|app`)만, `process`(`LLMS_TXT_ENABLED` 하나만 예외)·`assert`·`eval`·`Function`·`globalThis`·동적 로드·constructor 사슬 거부, 주석과 문자열 내용은 코드가 아니다 — 이는 증명이 아니다. 악의적 코드에 대한 권위 있는 방어는 draft PR, 저장소 CI, 사람의 diff 검토다.
  게시 단계(`--phase publish`)는 신뢰된 checkout과 자기 의존성에서 돌고, GitHub App 토큰(`MARKETING_SEO_GITHUB_APP_TOKEN`, `MARKETING_SEO_GITHUB_REPOSITORY`)과 서명 키만 가지며 LLM 변수가 있으면 시작을 거부한다.
  서명이 맞고, base가 원격 develop의 조상이며, 부모가 base이고, tree·diff를 git에서 다시 계산해 일치할 때만 push하고, push 뒤 원격 tree를 다시 읽어 일치할 때만 PR(draft)을 연다.
  졸업 기록이 정확히 `true`가 아니면(비어 있음·다른 값·읽기 실패) 졸업 전으로 취급해 `marketing-agent/<topic>` 초안 PR만 연다.
- robots·AI 크롤러 정책(`lib/robotsPolicyCore.ts`)과 workflow·게이트 파일은 항상 사람.
- 공유 백로그의 AEO 결정(`llms.txt`는 선택 실험, 신뢰할 변경일이 없으면 sitemap 날짜 생략, FAQ 리치결과 비목표)을 따른다.
- 시험: `tests/marketingSeoAgentCore.test.mjs`(검증기·제안·전 과정 fake)와 `tests/marketingSeoBranchPolicy.test.mjs`(브랜치 정책 shell)는 사람 소유이며 허용 목록에 없다.

## 10. 측정

### 10.1 유입 기록
- 새 분석 이벤트 `marketing_touch`: 클라이언트가 랜딩 URL에서 관측한 UTM을 서버가 **수신 시각**으로 기록한다.
  이벤트 입력 route(`app/api/analytics/events/route.ts`)에서 이 이벤트만 클라이언트 시각을 무시하고,
  properties schema(`lib/productAnalyticsShared.ts`)에 닫힌 증거 값(`touch_evidence`)과 `utm_content`를 추가하며, 증거 값은 서버가 덮어쓴다.
  eventName DB CHECK 제약과 코드 enum을 함께 바꾼다(`20261101100000_marketing_touch_analytics_event`).
  구현: 판정은 `lib/marketingTouchCore.ts`, 조회는 `findLatestMarketingTouch`(`lib/productAnalyticsServer.ts`),
  클라이언트 관측은 `observeMarketingTouch`(`lib/productAnalyticsClient.ts`, 다른 이벤트와 같은 동의 규칙),
  화면은 Admin › 제품 분석의 마케팅 유입 귀속 카드다. 귀속 스냅샷은 전환 이벤트의 `touch_*` 속성으로 복사해 고정한다.
  동의 직후 대기열이 touch와 전환을 함께 보내 서버가 전환을 먼저 저장한 경우, 같은 브라우저의 touch가 전환 수신 앞뒤
  30초 안에 저장되고 브라우저가 그 touch를 전환보다 먼저 관측했다면 서버가 그 전환의 스냅샷을 이 touch로 마무리한다
  (`lateMarketingTouchRepair`). 같은 브라우저의 touch(저장+보정)와 전환(조회+저장)은 브라우저 단위 트랜잭션 잠금으로
  직렬화한다(`recordOrderedAnalyticsEvent`). 클라이언트는 전송 순서를 맞추지 않는다.
- 이 기록의 증거 수준은 **"클라이언트 관측, 서버 시각"**이며 서버가 랜딩 요청을 증명한 것이 아니다.
  보고서와 화면에 그대로 적는다.
- 가입·게스트 첫 답변 이벤트 수신 시 7일 안의 마지막 touch를 귀속 스냅샷으로 고정한다.
  touch 없음은 미귀속, 이벤트 자체가 없음(미동의·차단)은 미관측으로 따로 보고한다.

### 10.2 GA4 User-ID
분석 전용 무작위 식별자, 명시 동의·고지 조건에서만 생성·전송, 로그아웃 시 해제, 동의 철회와 계정 삭제 시 GA4 삭제 요청 후 식별자 삭제.
**개인정보 고지 개정 배포 전에는 생성하지도 전송하지도 않는다.**

구현(S6, 기본 꺼짐). 식별자 방식은 2026-11-02 운영자 결정으로 계정 id의 HMAC에서 저장하는 무작위 값으로 바꿨다(정책 버전 변경 없음):
- 식별자는 계정과 무관한 128비트 암호학적 난수(소문자 hex)이고 `Ga4UserId` 표에 계정당 최대 한 행으로 저장한다
  (`lib/ga4UserId.ts`, migration `20261102100000_ga4_user_id`, 값 형식은 DB CHECK로 강제). 저장하는 이유는 철회다 —
  행을 지우면 Tomverse 안에서 그 값을 계정에 잇는 것이 없어져 GA4와의 연결이 끊긴다. 다시 동의하면 새 값을 만든다.
  이전 HMAC 방식의 id는 고지 상수가 한 번도 `true`가 된 적이 없어 발급·전송된 적이 없으므로 그 삭제 경로는 두지 않는다.
- 생성·전송 조건(`lib/ga4UserIdPolicy.ts`): 고지 개정 배포(코드 상수 `GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED`, 현재 `false` —
  고지 개정 PR에서만 바꾼다) · 스위치 `NEXT_PUBLIC_GA4_USER_ID_ENABLED=true` · 분석 **명시 동의**(고지 지역의 미결정은 제외) ·
  로그인 · GA4 측정 id. 식별자는 이 조건이 모두 충족된 뒤의 첫 요청에서만 만든다 — 브라우저가 요청 본문에 명시 동의를 적고,
  서버는 고지·스위치·로그인이 맞고 그 진술이 있을 때만 만든다(`app/api/analytics/user-id/route.ts` POST). 브라우저의 gtag
  `user_id`로만 보내고 서버 Measurement Protocol에는 붙이지 않는다(서버는 동의 상태를 모른다). 로그아웃은 `user_id`를 `null`로 해제한다.
- 동의 철회: 로그인 상태에서 분석을 거절하면 브라우저가 `user_id`를 `null`로 해제하고 철회를 요청한다(route DELETE). 서버는 저장된
  id로 GA4 Admin API `submitUserDeletion`을 한 번 요청한 뒤 행을 지운다. 요청 실패는 철회를 막지 않는다. 요청부터 삭제까지 행을 잠가,
  그 사이의 동의 요청은 철회 중인 id를 받지 못하고 철회가 끝난 뒤 새 id를 받는다(같은 브라우저는 철회 응답 뒤에 요청한다). 철회는 고지 상수만 따르고
  스위치와 무관하다 — 스위치가 켜졌을 때 만든 id는 꺼진 뒤에도 철회할 수 있어야 한다. 동의는 브라우저 단위이므로 로그아웃 상태의
  거절은 계정 id를 지우지 않는다.
- 계정 삭제(`lib/accountDeletion.ts`): 삭제 트랜잭션 안에서 User 행을 잠근 뒤 저장된 id를 읽고, 행은 User와 함께 cascade로 지운다.
  커밋 뒤 그 id로 `submitUserDeletion`을 한 번 요청한다(롤백된 삭제는 GA4에 요청하지 않는다). 저장된 id가 없으면 요청하지 않는다.
- GA4 요청(`lib/ga4UserDeletion.ts`, `GA4_PROPERTY_ID`, `GA4_USER_DELETION_SERVICE_ACCOUNT_JSON`): 저장된 id가 있을 때만 하고,
  실패와 자격증명 누락은 id 없이 운영 incident로 남기며 재시도하지 않는다. 자격증명만으로는 아무것도 보내지 않는다.

### 10.3 120일 측정
모든 지표를 승인·자율 모드와 계정별로 나눈다.

| 지표 | 정의 |
|---|---|
| 게시 성공률 | 공개 확인 건 ÷ 게시 도구에 보낸 요청 건. Guard·승인 거절은 분모 제외·별도 집계 |
| 공개 확인 | 상태 대조 + 주 1회 사람 표본 확인, 불일치율도 지표 |
| 게시 지연 | 예약 시각(즉시 게시는 승인 시각) → 플랫폼 게시 시각, p50/p95 |
| 실패 | 오류 코드별, `outcome_unknown` 별도 |
| 리드 | touch 귀속된 게스트 첫 답변 |
| 가입 | 서버 가입 이벤트, 7일 touch 귀속, 채널별 10건 미만이면 판단 보류 |
| 비용 | 게시 도구, X 사용료 분리, 마케팅 LLM, 가입 1건당 비용 |

### 10.4 AI 노출 측정 (S5, 2026-11-01 운영자 결정, 정책 버전 변경 없음)
- 기본 꺼짐(`MARKETING_AI_VISIBILITY_ENABLED=true`만 켬, `MARKETING_AUTOMATION_KILL_SWITCH`에 값이 있으면 끔). 월요일(UTC)에만, 생성기 서비스가 깨끗하게 끝난 뒤 두 번째 감독 worker로 돈다
  (`scripts/marketing-ai-visibility-worker.mjs`, `lib/marketingAiVisibilityCore.ts`). 스위치가 꺼져 있으면 예약·호출이 0건이다.
- 질문 목록(ko/en/zh-Hant 각 3개, Tomverse를 이름으로 부르지 않는 초안)을 웹 검색이 되는 LLM에 묻고(답변 호출), 그 답변에 Tomverse가 제품으로 언급됐는지는 **두 번째 LLM 호출이 JSON 불리언으로 판정**한다.
  문자열 검색·정규식·단어 목록으로 답변을 읽지 않는다. 구조적인 것은 답변 본문이 인용한 URL(검색 결과에만 있던 페이지는 인용이 아니다)의 호스트가 `tomverse.app`(또는 하위)인지, 비율 계산, 보고서 모양뿐이다.
- 모든 호출은 마케팅 LLM 비용 원장(목적 `market_intel`, 운영자가 정한 모델과 월 상한, 호출 전 예약)을 거치며 새 유료 경로는 없다. 답변 본문은 판정 직후 버리고 저장·로그·제출하지 않는다.
- 저장은 기존 보고서 kind `measurement_120d`(생성기 보고 route와 서명을 그대로 사용, kind만 허용 목록에 추가)이고, locale별로 `ai_visibility.mention_rate.<locale>.<질문·프롬프트 세트 버전>`·`ai_visibility.own_citation_rate.<locale>.<버전>`
  한 건씩, 값은 비율(0–1)과 표본 수뿐이다. 판정이 JSON이 아니면 표본에서 빼고 세며 추측하지 않는다. 호출 하나라도 결과를 모르면 그 주는 아무것도 보고하지 않는다(부분 주는 비율이 아니다).
  `AiVisibilityRun`(답변별 행)에는 아직 쓰는 쪽이 없고 이 구현도 만들지 않았다. 정확성 플래그(`accuracyFlags`)는 판정하지 않는다.

## 11. 직접 연동 판단 기준 (채널별)
1. 특정 채널이 가입 기여의 대부분(예시 60% 이상)
2. 같은 필요 기능이 반복해서 미해결(예시 30일 3회)
3. 장애가 운영 목표 침해(예시: 성공률 95% 미만 또는 p95 1시간 초과 2주 연속)
4. 고객 계정을 연결하는 멀티테넌트 제품화
5. 게시 도구의 플랫폼 권한 상실·약관 변경으로 기능 소실
6. DPA·보안 요건 미충족(호주 Privacy Act 포함)

예시 수치는 운영자가 확정한다.

## 12. 개인정보·보유

### 12.1 댓글 모니터링
- 댓글은 본 앱이 게시 도구로 조회하고, 댓글 모니터 서비스가 **본문만** 받아(작성자·글·시각·링크 없음) **메모리에서만** 분류한다.
  모델에도 그 본문만 보낸다. 로그에 본문·handle·댓글 URL을 남기지 않는다.
- 저장은 게시물 단위 알림(건수·위험 코드·최초 감지 시각, 게시물 URL)뿐이며 90일 후 삭제한다.
- **선행 조건(사람):** lawful basis·DPIA 검토, 게시 도구의 처리자 지위·DPA·하위처리자·데이터 위치, 호주 APP 8 해외 이전,
  GDPR 고지 → 개인정보처리방침 7개 locale 개정. 선행 전에는 댓글 기능이 꺼져 있고, **댓글 모니터링 없이는 졸업이 없다.**

**S4c 구현 상태(2026-11-01).** 스위치는 환경변수 `MARKETING_COMMENTS_MONITOR_ENABLED=true`이며 기본 꺼짐이다(건강 판정을 묻는 웹 앱·게시기와 모니터를 돌리는 서비스 모두에 같은 값을 둔다). 꺼져 있으면
`runMarketingCommentsMonitor()`는 DB·게시 도구·모델 어느 것도 건드리지 않고 돌아온다. 켜진 실행은 최근 14일 안에 게시된 글의 댓글을
`GET /v1/inbox/comments/{postId}`(게시 도구 생성 클라이언트 문서 기준, 실응답 대조는 12.1 선행 조건 이행 후)로 읽어 **본문만** 분류기에 넘기고
(작성자·id·링크는 읽는 즉시 버린다), 저장은 `comment_alerts` 보고서(건수·닫힌 위험 코드·최초 감지·URL host)와 시스템 감사 한 줄뿐이다.
알림은 운영자 확인 감사 항목(`marketing_comment_alert.acknowledge`)보다 오래된 동안 열려 있고, 24시간 열려 있으면 계정이 S4a 경로로 정지한다
(재개 이전에 열린 알림은 다시 정지시키지 않는다). 모든 글을 읽고 분류까지 끝낸 실행만 `marketing_comments_monitor_last_run` 설정에 **시작** 시각을(다음 실행은 그 시각 10분 전 이후의 댓글을 새 것으로 본다; 한 번에 200글까지, 넘으면 표본이라 기록하지 않는다)
남기며, 3시간 안이면 `commentsMonitorHealthy`가 참이다(졸업 판정·자율 게시 판정 공통). 분류기가 없으면 `classifier_unavailable`로 아무것도 읽지 않는다.

**S4d 구현 상태(2026-11-02).** 분류기와 실행 경로가 연결됐다. 매시 15분에 Railway `Marketing Comments Monitor` 서비스(생성기와 같은 변수
`MARKETING_APP_URL`·`MARKETING_GENERATOR_SUBMIT_SECRET`·`MARKETING_LLM_API_KEY`와 스위치만, DB·게시 도구 자격 없음)가 worker를 20분 기한으로 띄운다.
한 실행은 본 앱 `POST /api/internal/marketing-comments-monitor`(생성기 secret) 두 번이다. `collect`는 새 댓글의 서로 다른 본문을 본문 SHA-256 id와
함께, 그리고 이번 읽기가 덮는 시각(`readAt`)을 넘기고 아무것도 쓰지 않는다. 본문이 1,000개를 넘으면 밀린 것으로 보고 가장 오래된 것부터 시각 단위로
잘라 1,000개 이하만 넘긴다(`backlog`). 자르는 시각은 그다음 댓글 직전이되 지금보다 10분(overlap) 이전이어야 하고, 그렇게 자른 온전한 실행은 자른 시각
+10분(실제로 읽은 때보다 늦지 않다)으로 기록되어 다음 실행이 정확히 자른 시각부터 이어받는다(이미 분류한 것을 다시 세지 않는다). 한 시각이나 시각 없는
댓글이 1,000개를 넘어 자를 수 없으면 실행은 계속 온전하지 않고 모니터는 비정상으로 남는다. 서비스는 본문 50개씩 LLM 한 번(엄격한 구조화 출력, 닫힌 위험 코드만)으로
분류하고, 모든 호출은 마케팅 LLM 원장의 `comment_triage` purpose로 예약·정산된다(운영자 모델·월 상한 그대로, 재시도 없음; 정산되지 않은 호출에서
분류를 멈추고 받은 판정만 넘긴다). `judge`는 id별 판정을 받아 본 앱이 댓글을 **다시 읽어** 모니터 전체를 돌린다: 무엇을 읽었는지, 실행이
온전했는지는 앱이 정하고, 실행은 `readAt`(지금보다 늦을 수 없다)으로 기록되며 그 뒤에 쓰인 댓글은 다음 실행 몫이다. 알림의 최초 감지는
`readAt`이 아니라 `judge`가 찾은 시각이다. 판정이 없는 본문은 그 글을 미독으로 남긴다(안전으로 읽지 않는다). 서비스는 인증될 뿐 신뢰되지 않으며, 판정은 알림을 열 수만 있다. 앱과 서비스 둘 다 `MARKETING_COMMENTS_MONITOR_ENABLED=true`여야 하고,
꺼져 있으면 서비스는 worker를 띄우지 않으며 앱은 두 단계 모두 `off`로 답한다. 킬 스위치는 앱이 지킨다(두 단계 `off`, 원장 예약 거절).

### 12.2 보유
| 데이터 | 보유 | 만료 처리 |
|---|---|---|
| 게시·승인·주장 근거 | 게시 후 24개월 | 본문 삭제, digest·지표 유지 |
| 거절·만료 초안 | 90일 | 삭제 |
| history의 webhook id·시도 세부 | 90일 | 요약으로 치환 |
| webhook shadow 기록(§8.1.1) | 90일 | 삭제 |
| 주간 보고·브리프·시장 정보·시장 분석(`MarketingAnalysis`) | 24개월 | 삭제 |
| 실험 결과·120일 측정 | 36개월 | 삭제 |
| 댓글 알림 | 90일 | 삭제 |
| 본토 차단 점검·보유 실행 기록 | 12개월 | 삭제 |
| AI 노출 측정 | 24개월 | 삭제 |
| LLM 비용 원장(`MarketingLlmCall`) | 24개월 | 삭제 |
| 경쟁사 등록부(`MarketingCompetitor`) | 행 유지(은퇴만) | 삭제하지 않는다. 시장 사실이 그 행을 출처 판정의 근거로 가리키기 때문이다. 개인정보가 없다 |
| 공개 버킷 이미지 | 게시 확인 후 7일 또는 게시 취소 즉시 | 삭제 |
| 분석 전용 식별자(`Ga4UserId`) | 동의 철회 또는 계정 삭제 시 즉시 | GA4 삭제 요청 + 삭제 |

- history의 append-only 예외는 **보유 정리 하나뿐**이다. 같은 CAS와 감사 기록을 한 트랜잭션에서 쓰고,
  legal hold가 걸린 행은 정리하지 않는다.

## 13. 호주 법규·규제·산업표준과 내부 정책

"근거" 열은 외부 규범의 성격이고, "Tomverse 반영" 열 중 **[내부]** 표시는 법이 직접 요구하는 것보다
엄격하게 Tomverse가 스스로 정한 규칙이다.

| 근거 | 성격 | Tomverse 반영 |
|---|---|---|
| ACL 오인·기만 행위 | 법 | 사실 검증, 금지 주장 |
| 자기 페이지 제3자 댓글 책임(ACCC 안내) | 규제 안내 | 댓글 모니터링, 24시간 미처리 시 정지, 숨김·삭제는 사람 |
| 비교 광고 | 법(ACL) | 근거·범위 저장. **[내부]** 항상 승인 |
| "Free" 표현 | 법(ACL) | 조건 문구 필수 |
| 가격 표시(component pricing) | 법(ACL) | AUD·GST 포함 총액. **[내부]** 세무 확인 전 승인 범주 |
| Unfair Trading Practices(2027-07-01 시행) | 법(시행 전) | **[내부]** 가짜 긴급성을 시행 전부터 금지 |
| AANA Code of Ethics | 산업 자율규약 | 회사가 통제하는 홍보성 콘텐츠에 적용되며 광고임이 드러나야 함. **[내부]** 회사 계정 게시물은 모두 광고로 취급. 회사 공식 계정이 광고임을 드러내므로 본문 표시는 붙이지 않는다(2026-10-31 운영자) |
| 16세 미만 SNS 계정 제한(2025-12-10 시행) | 법(의무자는 대상 플랫폼) | **[내부]** 16세 이상만 겨냥, 10대 겨냥 표현 금지 |
| Privacy Act 사생활 침해 법정 불법행위 | 법(성립요건 있음) | **[내부]** 동의 없는 사용자 사례 사용 금지 |
| Children's Online Privacy Code | 규약(등록 예정) | User-ID·실험 설계 재확인 항목 |
| 플랫폼 AI 표시 정책 | 플랫폼 약관 | 자산 출처에 따른 채널별 표시 |

## 14. 구현 단계
| 단계 | 내용 | 작성 → 검토 | 완료 기준 |
|---|---|---|---|
| S0 | 게시 도구 기술 검증(테스트 계정) | Claude → Codex | 채널별 복구 계약 표 확정 |
| S1 | 테이블, Guard와 우회 공격 테스트, 목록, 기능별 스위치, `marketing:write`, 시스템 감사 writer | Codex → Claude | 우회 코퍼스·가격 출처·권한 매트릭스 테스트 |
| S2 | Admin Console, 게시 도구 어댑터, 게시기, webhook | Claude → Codex | Admin IA 전부, 승인 경쟁·webhook replay 테스트, **§8.1.1 조건 1–5를 활성화할 `event type × 채널` 조합별로 staging shadow 처리로 통과, production(또는 환경 판정 불가)에서 shadow 활성화가 거절됨을 관측, shadow 처리 전후 `MarketingPost`·`MarketingChannel`·공개 여부·자동 정지 상태가 변하지 않고 shadow 기록만 바뀜을 관측, 운영자 서명 기록(S0 C9 이관분)** |
| S3 | 생성 서비스, A1·A3·A5, 승인 모드 운영과 120일 측정 시작 | Codex → Claude | 첫 주간 보고서, 첫 승인 게시 |
| S4 | 졸업, 댓글 모니터링, 자동 정지 | Claude → Codex | 응답 유실 등 장애 주입 테스트 (§12.1 선행 필수) |
| S5 | 랜딩 실험(스파이크 먼저), SEO PR·자동 병합, AI 노출 측정 | Codex → Claude | 캐시 누수 E2E 0건, 브랜치 정책 shell 테스트 |
| S6 | GA4 User-ID | Claude → Codex | 동의 게이트 테스트 (§10.2 선행 필수) |

## 15. 알려진 제약
- 번체 게시물 링크는 zh-TW locale이 생길 때까지 간체 페이지로 연결된다.
- Instagram·TikTok은 API 게시 취소가 불가하다(문서 기준, S0 회차 1에서 앱 수동 삭제만 관측). 그래서 두 채널은 항상 승인 모드다(O15).
- 경쟁사 가격 일부는 2차 출처다. 공식 확인 전 문구에 쓰지 않는다.
- 중국 본토 접근 차단은 저장소 밖 인프라 설정이며 이 저장소에서 검증되지 않는다.
- 게시 도구의 기능 정보는 자사 문서 기준이다. S0에서 확정한다.
- 게이트웨이(O14)는 별도 저장소의 별도 설계·검토 대상이다.
