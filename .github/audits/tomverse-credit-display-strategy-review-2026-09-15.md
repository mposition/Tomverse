# 크레딧 숫자의 위치 — 초안 검토

검토일: 2026-09-15. 대상: 사용자 첨부 「크레딧 숫자의 위치 — 결정 기록 v0.1」.
**부분 채택·수정 후 목록 등록.** 제품 코드·UI 계약·가격·예약·정산·production은 변경하지 않았습니다.

## 1. 결론

채택할 원칙은 **중복 숫자는 줄이되 실행 전에 비용을 이해·통제할 수 있고, 실행 후에는
정산 근거를 찾을 수 있게 한다**입니다. “잔액이 부족해질 때까지 실행 비용을 숨긴다”는
원칙은 채택하지 않습니다. 돈이 충분한 사용자도 소비량을 선택할 필요가 있습니다.

추천하는 기본 구조는 다음과 같습니다.

| 순간 | 기본 정보 | 자세히 열면 |
| --- | --- | --- |
| 모델·기능 탐색 | 기능·사용 조건 중심, 동일 숫자 반복 축소 | 모델별 비용·산정 조건. 가격으로 비교할 선택권은 유지 |
| 일반 요청 전 | 한 곳의 간결한 예상 총량·비용 상세 진입 | 선택 모델·검색·문맥별 내역. 추정치를 확정 상한이라 부르지 않음 |
| 별도 고비용·다단계 작업 시작 | 실행 범위와 서버가 보장하는 최대 N크레딧, 보장이 있는 경로만 | 포함 작업, 추가 승인 조건, 취소·실패·재시도 과금 |
| 구매 크레딧 사용 예정·부족·제한 | 현재 필요한 정확한 수치·사유·다음 행동 | 플랜/구매 잔액·기간·리셋·만료. 서로 다른 한도를 혼합하지 않음 |
| 완료·부분 실패·취소 | 결과 옆의 정산 상태·내역 진입 | 이 작업의 승인/예약/청구/환급. 현재 초안의 견적을 보여주지 않음 |

모든 메시지에 확인 팝업을 추가하자는 뜻은 아닙니다. 일반 대화의 마찰은 늘리지 않고,
별도 작업 승인과 반복 요청의 비용 안내를 구분합니다. 금액 숨김이 사용성·전환을 개선한다는
실측은 없으며 “제품이 계량기처럼 느껴진다”는 디자인 가설로 기록합니다.

## 2. 분석 기준

- dirty detached 로컬 작업을 보존하고 원격 fetch 후 새 분석 worktree를 사용했습니다.
- develop: `3e0445a3f65ffcc8c38660aead3f5cc2cc46e01b`.
- main: `938816f2bcf56a2a289758f6bbb6353ee93ce1c6`.
- 비교한 CreditBreakdownSheet, Memory launcher/service/credits, image 생성 API/pricing/service,
  comparison/image UI 계약은 두 ref에서 같았습니다. ChatInput은 차이가 있어 develop 기준으로
  읽었습니다. 전체 트리나 운영 화면이 같다는 의미는 아닙니다.
- 운영 DB·배포 flag·사용자 행동·정산 기록·경쟁 제품 화면은 조회하지 않았습니다.
  초안의 이름 없는 경쟁 제품 일반화는 검증된 근거로 채택하지 않았습니다.
- `smart-explore` 스킬을 사용했으나 별도 worktree 접근이 거부돼 표적 검색·읽기로 대체했습니다.
  UI 문구에서 실제 소비처·요청·정산까지 구분한 것이 아래 작업 분리의 근거입니다.
- 관련 결정이라는 「Tomverse Agent의 제품 축」 및 IDEA-A1 본문은 제공되지 않았고 조사한
  docs/audits에서 해당 명칭의 근거를 찾지 못했습니다. Agent의 범위·투자 순위를 승인된 것으로
  가정하지 않으며 이번 목록 추가가 새 Agent 제품 개발 승인은 아닙니다.

## 3. 중요한 사실 교정

### A. CreditBreakdownSheet는 결제 내역이 아니다

현재 props는 `items`, `total`, `multiplier`, `webSearchReservationCredits`이고,
ChatInput은 **현재 초안**의 `creditBreakdown`·`estimatedRequestCredits`를 넘깁니다.
ledger·run 식별자나 완료된 작업 정산 상태를 받지 않습니다.

따라서 사후 문구 13·14를 이 화면으로 단순 이동하면 과거 작업 대신 다음 요청의 비용을
보여줄 수 있습니다. 견적과 정산은 별도 모드 또는 별도 상세로 표현하고, 작업 단위의
허용된 집계 API·권한·기록 연결을 확인한 뒤 사후 정보를 접어야 합니다. 그 전에는 기존
청구·캐시 재사용 고지를 먼저 없애지 않습니다.

근거: `components/chat/CreditBreakdownSheet.tsx:16–33`, `ChatInput.tsx:4865–4872`.

### B. 이미지 예약은 “실제 사용량만큼 크레딧 청구”가 아니다

정책 `image-generation.md` §3과 `imageGenerationService.ts`는 **성공한 대상의 고정
크레딧 전액**을 청구합니다. 실제 provider 원가 정산은 내부 비용 장부의 별개 숫자입니다.
성공 이미지의 입력이 짧다고 사용자 크레딧을 일부 환급하지 않습니다.

실패 대상의 환급 때문에 그룹 전체가 최초 합계 이하로 끝날 수 있는 것과 사용량 기반
변동 가격은 다릅니다. “최대 N”을 쓰더라도 **성공 대상별 고정 가격·실패 환급**을 설명해야
하며, 원가 차액이 사용자에게 돌아오는 것처럼 표현하지 않습니다.

더구나 현재 이미지 생성 요청은 prompt/옵션/modelIds/idempotencyKey를 보내며,
API schema에 사용자가 확인한 `confirmedCredits`, `maxCredits`, quote 식별자가 없습니다.
서버 예약액에 묶인 정산이 있다는 사실만으로 **사용자가 화면에서 승인했던 금액**에 묶였다고
단정할 수 없습니다. 가격 갱신·옵션 변경·재시도·오래 열린 탭에서도 그 약속이 유지되는지
서버 계약을 먼저 정의해야 합니다. 이번에 실제 초과 청구를 발견했다는 뜻은 아닙니다.

근거: `ImageGenerationWorkspace.tsx:708–720`, `app/api/images/generations/route.ts:41–58`,
`lib/imageGenerationPricing.ts:51`, `imageGenerationService.ts:1328–1373`.

### C. Memory는 참고 패턴이지 범용 Agent 완성품은 아니다

Memory launcher는 `confirmedCredits`를 보내고 service는 재계산한 견적과 다르면
`MEMORY_ESTIMATE_CHANGED`로 거절합니다. 정산도 청구 chunk의 비율로 계산하되 예약
크레딧 이하로 제한합니다. 이 **확인 → 변경 시 재확인 → 제한된 정산** 패턴은 재사용 가치가 있습니다.

그러나 화면의 모델 선택에는 추출 견적 버튼을 누르기 전에도 `creditsPerChunk`가 표시됩니다.
“모든 숫자는 요청할 때만 나온다”는 설명은 정확하지 않습니다. 또한 고정된 chunk 작업의
상한과 도구·단계·재시도가 늘어나는 Agent 전체 예산은 같은 계약이 아닙니다.

근거: `MemoryExtractionLauncher.tsx:318,432,622`, `memoryExtractionService.ts:353–358`,
`memoryExtractionCredits.ts:277–289`.

### D. 분류표는 유용하지만 26개가 전체 화면 비용 인벤토리는 아니다

- 4번 `creditEstimateAria`는 버튼의 접근성 이름입니다. 보이는 숫자는 별도
  `CreditCostBadge`이고 title에도 숫자가 있습니다. locale 키만 지우면 화면 숫자는
  남은 채 스크린리더 안내를 잃을 수 있습니다. 전체 버튼·badge·title·aria를 함께 설계합니다.
- 비교 레일의 AI Review 비용은 `AI_REVIEW_CREDITS`를 badge에 넘깁니다. 12번 quick
  summary 문구 하나를 고쳐도 이 숫자는 남습니다. helper·직접 숫자 렌더링도 조사 대상입니다.
- 18번은 namespace를 구분해야 합니다. `usage.planCreditsRemaining`에는 수치가 있지만
  `auth.planCreditsRemaining`은 라벨이고 값은 JSX가 따로 렌더링합니다.
- 21번은 AuthButton의 기본 모델 조합 설정입니다. 초안 실행 순서의 “비교 레일 12·21”은
  위치가 다르며 같은 계약으로 묶을 근거가 없습니다.
- 정리 후보 15·16·22·23은 app/components/lib의 정적 소비처를 찾지 못했습니다.
  동적 키·타입·테스트·문서·번역 allowlist까지 확인하기 전 “위험 없음”으로 확정하지 않습니다.

따라서 **“11개 수정이면 완료”라는 공수 산정은 보류**합니다. 26개 분류의 산술 합계가
맞는 것과 실제 사용자 표면이 모두 포함되는 것은 다른 문제입니다.

### E. % 전환은 새로운 한도가 아니지만, 단독 표시는 불충분하다

숨은 USD entitlement 사고는 **서버의 별도 제한**이 문제였습니다. 표시를 %로 바꾼 것만으로
새 숨은 한도가 생기는 것은 아닙니다. 다만 기간·분모·정확한 잔량이 불명확하면 이해를 방해합니다.

현재 `percent(used, limit)`는 **사용률**을 만들고 limit≤0이면 0을 반환합니다. 그대로 잔량
%에 재사용하면 의미가 뒤집히거나 일일 제한 없음이 잔량 0처럼 보일 수 있습니다. 일일/월간
플랜·구매 lot·만료는 서로 다른 축이므로 단일 %에 합치지 않습니다.

권고는 “월간 플랜 잔량”처럼 범위를 밝힌 보조 표시와 쉽게 여는 정확한 수치입니다.
구매 크레딧과 만료·임박 만료 안내는 유지합니다. raw 내부 USD를 공개하는 방향으로 바꾸지 않습니다.

17번 `addOnCreditsWillBeUsed`도 부족해서 막힌 상태가 아니라 **실행 가능하지만 구매
크레딧을 쓸 예정인 상태의 사전 고지**입니다. 차단 시에만 표시하도록 좁히면 안 됩니다.

### F. 게스트와 모바일 계약은 마지막 열린 항목이 아니라 선행 조건이다

게스트에게 계정 청구 페이지가 없더라도 `UserUsageSummary`의 게스트 잔량 안내와
비교 레일의 trial/credit 상태가 있습니다. 숨긴 정보를 로그인 뒤 페이지에서만 보여주면
게스트는 비용·잔량 정보를 잃습니다. 현재 사용 가능한 경로에서 정확한 안내를 유지해야 합니다.

두 UI 계약 외에 `mobile-chat-composer.md:125,150,189`도 비용 경고의 접근 가능한 대체와
웹 검색 credit ceiling 설명을 요구합니다. 5·6의 숫자를 삭제하는 작업은 자동으로
“계약 무관”이 아닙니다. Deep Research 제안은 현재 클릭이 실행이며 2차 확인이 없으므로
새 승인 화면보다 먼저 그 카드의 비용 안내를 지우면 안 됩니다.

`check:locale-translation`은 영어 문장이 다른 locale 값에 그대로 남았는지를 찾는 검사이며
짧은 문자열 등을 제외합니다. 이 검사 하나가 키·placeholder·문맥·자연스러움·접근성의
누락을 전부 잡는 것은 아닙니다. locale 타입/키·placeholder 검사 및 렌더링 검증을 함께 둡니다.

## 4. 원안 26개 항목의 처리

| 번호 | 키/묶음 | 수정한 권고 |
| --- | --- | --- |
| 1 | imageModelCreditsFrom | 낮은 강조·접기 후보. 모델별 비용 정보의 발견 가능성·계약 개정 후, 즉시 삭제 아님 |
| 2 | imageGenerationTotalCredits | 실행 전 총량 유지. 승인 cap 표현은 CREDIT-CAP-01 근거가 마련된 뒤 |
| 3 | imageGenerationErrorInsufficientCredits | 유지, 필요한 금액·잔액·해결 경로 |
| 4 | creditEstimateAria | 숫자만 삭제하지 않음. 비용 상세 버튼의 visible label/title/aria를 함께 재설계 |
| 5 | toolsWebSearchCostNote | 중복 시각 문구 축약 가능. 검색 비용·환급 조건을 실행 전 상세에서 유지 |
| 6 | webSearchChipDescriptionOn | 지원 범위와 접근 가능한 비용 설명 유지. 모바일 계약 함께 검토 |
| 7 | webSearchReservationLabel | 현재 요청의 견적/예약 설명으로 유지. 과거 청구 내역으로 재분류하지 않음 |
| 8 | deepResearchSuggestionEstimate | 승인 대체 경로가 생기기 전 유지. 새 확인 단계의 이탈·마찰도 검토 |
| 9 | webSearchSuggestionEstimate | 중복 축약 후보. 실행 전 검색 추가 비용을 알 수 있어야 함 |
| 10 | comparisonRailStatusInsufficientCredits | 유지 |
| 11 | comparisonRailStatusInsufficientCreditsFor | 유지, 액션별로 구분 |
| 12 | quickDifferenceSummaryApproximateCost | 정상 실행 비용을 전부 숨기지 않음. 양쪽 액션 badge까지 한 묶음으로 검토 |
| 13 | quickDifferenceSummaryNote | 완료 작업의 정확한 정산 상세가 확보된 후 접기 |
| 14 | quickDifferenceSummaryCachedNote | 캐시 재사용·이번 청구 없음 의미를 보존하며 접기 |
| 15 | quickDifferenceSummarySetup | 정적 미사용 후보, 교차 참조 확인 후 같은 PR에서 정리 |
| 16 | quickDifferenceSummaryRun | 정적 미사용 후보, 위와 같음 |
| 17 | addOnCreditsWillBeUsed | 사전 고지 유지. 차단 상태에만 한정하지 않음 |
| 18 | planCreditsRemaining | 정확한 잔량 접근 유지. %는 기간/분모를 밝힌 보조 수단 |
| 19 | estimatedTotal | 온보딩 모델 조합의 비용 비교 권한 유지. “볼 이유 없음”은 기각 |
| 20 | contextualCreditNotice | 중복은 축약하되 선택 변경의 비용 영향을 찾을 수 있어야 함 |
| 21 | newConversationModelsTotal | 계정 기본 조합 설정의 합계/상세 검토. 비교 레일 작업과 분리 |
| 22 | creditEstimateTotal | namespace를 포함해 정적 미사용 후보 확인 후 정리 |
| 23 | creditEstimatePerModel | 위와 같음. 번역 allowlist의 참조도 함께 확인 |
| 24 | memoryExtraction.modelCredits | 이미 모델 선택에서 보이는 단위 가격. 이를 모범 패턴의 예외로 정확히 기술 |
| 25 | memoryExtraction.estimateResult | 유지, 추정과 확정 상한 의미 구분 |
| 26 | memoryExtraction.start | 현재 확인·재확인 계약 유지. 범용 Agent 완료 근거로 확대하지 않음 |

## 5. 목록 등록과 실행 순서

### CREDIT-UX-01 — 비용 정보의 점진적 공개·정산 상세 정합성

**CHAT-01 하위 병행 P2 / 수정 후 등록, 정책·UI 결정 대기.** 현재 표시 자체를 긴급 결함으로
판정하지 않았으므로 삭제/권한 안전과 CONT-01, Chat 핵심 품질·첫 성공보다 앞세우지 않습니다.
CHAT-ONBOARD-01·CHAT-ART-01과 화면 변경을 조율하고, 별도 대규모 UI 재작성은 하지 않습니다.

1. 먼저 표면별 **견적 / 사용자 승인 상한 / 예약 / 정산 / 잔량** 데이터 출처·업데이트 시점·
   Guest/Free/유료 경로·접근성·승인 정책 매핑을 확정합니다. 26개 키가 아닌 실제 렌더링이 기준입니다.
2. 숫자 중복을 줄이는 최소안과 현재안을 비교합니다. 한 곳의 총량·상세 접근·구매 사용 사전
   고지·정확한 부족 수치가 유지되는지 먼저 확인합니다. 운영 전환율을 근거 없이 지어내지 않습니다.
3. 계정 잔량의 시각적 축약은 별도 작은 변경으로 진행하되 정확한 숫자·기간·만료 접근을 유지합니다.
4. 완료 작업별 실제 정산 상세를 연결한 후에만 13·14의 중복 사후 문구를 접습니다. ledger 원자료를
   그대로 노출하지 않고 작업 연결·권한·비공개 내용 제외·부분 실패를 확인합니다.
5. comparison action rail, image workspace, mobile composer 및 관련 상위 정책의 충돌을
   승인받고 관련 상태 테스트를 갱신합니다. 문서만 먼저 바꿔 기존 코드와 모순되게 두지 않습니다.
   미사용 문구 정리는 교차 검증 후 해당 PR에 포함할 P3 정비이지 전체 작업의 우선 목적이 아닙니다.

### CREDIT-CAP-01 — 작업 단위 지출 상한의 승인·강제 계약

**후속 P2 / 설계 후보, 제품·청구 정책 결정 대기.** Memory의 이미 있는 기능은 재개발하지
않습니다. 이미지/Deep Research로 일반화하려는 범위만 검토하고, Agent 적용은 IDEA-A1의
실제 승인 범위가 생겼을 때 연결합니다. CREDIT-UX-01의 모든 시각 개선을 이 작업에 종속시키지 않습니다.

- 숫자가 **견적**인지 **사용자 청구 상한**인지 **운영 provider 예산**인지 분리합니다.
  확인 금액·대상 작업·모델·옵션·가격 버전·유효기간을 서버의 실행과 결속합니다.
- 상한은 이미 청구된 값뿐 아니라 예약 중인 병렬 작업도 포함해 원자적으로 강제합니다.
  재시도·중복 클릭·재접속·resume가 새 무제한 지출 허가가 되지 않아야 합니다.
- 범위·가격·예산 증가 시 멈추고 재승인합니다. 고정 성공 가격은 고정 성공 가격으로 설명하며
  소비량 정산으로 바꾸려면 별도 가격 정책 결정입니다. 부분 실패·취소·환급 단위도 선행 결정입니다.
- `imageHandoffAutoGenerate`는 boolean 설정입니다. 현재 화면의 숫자 옆에서 선택했다는 것만으로
  이후 모든 작업의 최대 금액이 승인된 것은 아닙니다. 매 작업 cap인지 지속 허용 한도인지,
  설정/가격 변경·만료·철회·재시도가 그 권한에 미치는 영향을 정합니다. “price→cap” 단어 교체로 끝내지 않습니다.
- UI 최종액은 승인 상한 이하, 원장 정합성·계정 잠금 순서·멱등성·소급 정산 금지는 유지합니다.
  금융 primitive나 사용자 entitlement를 UI 개선을 구실로 바꾸지 않습니다.

이번 등록으로 **Agent 승인 UX가 완성됐다고 판정하지 않습니다.** 공용으로 빌릴 것은
확인/재확인의 패턴이고, 아직 결정해야 할 것은 각 작업의 지출 권한과 생명주기입니다.

## 6. 검증·변경 경계

이번 검토는 첨부 전문·정책·정적 코드 경로 대조입니다. 제품 코드 변경이 없어 빌드·전체
unit/e2e·운영 정산·유료 turn은 실행하지 않았습니다. 실제 구현 시에는 다음을 범위에 맞춰 검증합니다.

- 무료/유료/게스트·일일 제한 없음·구매 lot·임박 만료·알 수 없는 잔액/견적.
- 모델/검색/옵션 변경 후 비용 정보, 지원 일부/부족/캐시 재사용 0, 실제 정산과 다음 초안의 분리.
- 모바일·키보드·스크린리더에서 비용 상세 발견·읽기·닫기, 7개 locale의 key/placeholder/문구.
- cap을 도입하는 경로는 stale quote·추가 단계·병렬 실행·재시도·취소·부분 실패·동시 예약 검증.
  새 비가역 위험과 일반 표시 품질은 구분하고 기존 출시 게이트를 일괄 확대하지 않습니다.

코드 근거: [견적 상세](https://github.com/mposition/Tomverse/blob/3e0445a3f65ffcc8c38660aead3f5cc2cc46e01b/components/chat/CreditBreakdownSheet.tsx#L16),
[이미지 요청 계약](https://github.com/mposition/Tomverse/blob/3e0445a3f65ffcc8c38660aead3f5cc2cc46e01b/app/api/images/generations/route.ts#L41),
[Memory 견적 재확인](https://github.com/mposition/Tomverse/blob/3e0445a3f65ffcc8c38660aead3f5cc2cc46e01b/lib/memoryExtractionService.ts#L353).

[통합 작업 목록](./tomverse-product-idea-backlog.md).
