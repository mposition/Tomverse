# Chat continuation 답변별 Review 문맥 전달 검증

범위: 로그인 계정의 저장 완료된 텍스트 Chat continuation 답변을 새 Review
continuation으로 비교한다. 기존 원문 단위 fork와 일반 Chat 비교는 유지한다.
준비는 새 Conversation·bridge·초안만 만들며 실행은 사용자의 Send 이후다.

## 구현 경계

- 완료 Message와 같은 transaction에서 실제 성공 provider attempt의 source plan을
  nullable JSON에 기록한다. 실패·unknown·preflight plan은 성공 증거로 저장하지 않는다.
- descriptor에는 부모·질문·답변·native prefix의 ID/digest와 source manifest binding만
  저장한다. imported/native 본문은 복제하지 않는다.
- 질문 이전 native prefix는 최근 100행 후보, 3,000 추정 토큰 이내다. imported source의
  기존 3,000 추정 토큰 상한과 UTF-16 발췌 좌표를 유지한다. 빠진 문맥은 표시한다.
- 부모 assistant는 출처가 구분된 user-role 참고자료다. 클릭한 답변과 이후 turn은 제외한다.
- target 전용 draft CAS와 consume/receipt만 허용한다. 일반 Review에는 Chat recovery
  접근을 열지 않는다. 부모/source의 잠금·삭제·변경은 bootstrap/preflight/send에서 거절한다.

## 완료 시나리오별 검증 위치

| # | 시나리오 | 실행 가능한 검증 |
|---|---|---|
| 1 | Kyoto/AUD 1,500 source가 실제 provider 입력에 포함 | `chat-route-fallback-liveness.test.ts`, handoff loader tests |
| 2 | 앞선 assistant 설명 포함, clicked answer/이후 turn 제외 | handoff loader/core/DB tests |
| 3 | 1,200자 초과 질문 보존 | handoff DB, Web/Native UI tests |
| 4 | selected/retrieved/head+tail/emoji 발췌와 순서·분류 round-trip | `continuationSourceManifest.test.mjs`, actual dispatch tests |
| 5 | legacy recent 재구성과 복원 한계 표시 | loader, Web/Native UI tests |
| 6 | 준비 0 provider/reservation/Message, 동일 key race, anchor 분리 | handoff DB, Web/Native UI, client attempt tests |
| 7 | 기존 초안·첨부 보존, target 편집/reload/consume | Web/Native UI, durable recovery DB tests |
| 8 | 계정·generation·A→B→A·늦은 응답·unknown/conflict 보호 | Web/Native UI, client attempt tests |
| 9 | 부모/source의 독립 잠금·passwordVersion·삭제·native 변경 거절 | loader, handoff DB, preflight/dispatch tests |
| 10 | 모든 모델에 같은 reference, 중복 없음, native 비용 산입 | actual dispatch, `review-handoff-preflight.test.ts` |
| 11 | 후속 질문에서도 reference 유지, unavailable 실행 중단 | actual dispatch, loader tests |
| 12 | 첨부·Research·이미지 및 한도 초과를 명시적으로 거절 | loader, handoff DB, Native UI/transport tests |
| 13 | reference 본문을 URL/target Message/descriptor/일반 export에 복제하지 않음 | manifest/core/DB, Web/Native UI, sharing/export 회귀 |
| 14 | 기존 원문 fork·일반 Chat 비교·Review→Chat·opt-in source export 유지 | continuation fidelity, Web/Native 기존 UI, export DB tests |

## 한계

manifest가 없는 과거 답변은 당시 selected/retrieved 발췌를 복원하지 못한다.
현재 미전송 picker는 과거 답변에 적용하지 않는다. 당시 memory/profile/tools/reasoning 및
provider prompt의 byte 동일성은 재생하지 않는다. 첨부가 필요한 질문/native prefix와
Research·이미지·voice·Guest/public share는 이번 지원 범위 밖이다.

검증은 synthetic provider와 별도 로컬 DB만 사용한다. production migration, 유료 runtime
실행, PR, CI 실행, merge, deploy는 이 변경의 검증에 포함하지 않는다.

## 로컬 실행 결과

| 검사 | 결과 |
|---|---|
| continuation fidelity | pure 48개, server 169개 통과 |
| 실제 mock provider dispatch | 4개 통과: fallback attempt 결속, 모든 모델/후속 질문의 동일 참조, 전송 전 참조 취소 |
| handoff preflight | 2개 통과: native reference 비용 산입, 잠금 상태 admission 전 거절 |
| Message receipt/recovery API | 17개 통과: 일반 Review 거절, handoff target의 정확한 scope/text-only만 허용 |
| Native transport/bearer gate | 63개 통과 |
| Native 단일 모델 참조·세션 재검증 후 transport | 54개 통과, mobile typecheck 통과 |
| Native UI | 기존·신규 11개와 한도/미지원 오류 안내 2개 통과 |
| Web 신규 handoff UI | desktop/mobile browser 8개 통과: long draft, CAS, reload/Back, 잠금 거절, consume, anchor generation, 첨부, 일반 Review 격리 |
| Web 필수 기존 회귀 | desktop/mobile browser 6개 통과: 일반 Chat 비교, 원문 fork, Review→Chat(모바일 초안·첨부 보존 포함) |
| PostgreSQL migration | 별도 loopback DB에 422개 적용, schema drift 0 |
| durable transaction DB | 24개 통과 |
| handoff 생성 DB | 4개 통과 |
| 기존 continuation/source opt-in export DB | 50개 통과 |
| manifest/native reference core | 9개 통과 |
| handoff reference loader | 8개 통과 |
| 전체 application typecheck | `npm run typecheck -- --incremental true --tsBuildInfoFile .tmp-review-context-final.tsbuildinfo` 통과 (exit 0, Node heap 8 GiB) |
| 변경 파일 lint·diff check | 통과 |
| accent token / conversation writer 검사 | 통과 |
| model pricing / enum constraint 검사 | 통과 |

전체 webpack build는 변경하지 않은 Admin import 경로의 기존 오류로 실패했다:
`node:crypto` → `lib/amux/decisionMakerBodyCore.ts` →
`lib/amux/decisionMakerAdminCore.ts` → `components/admin/AmuxDecisionMakerRequestsPanel.tsx`.
해당 클라이언트 번들 문제는 이 작업에서 수정하지 않는다.
Web 기능 검증은 외부 호출을 차단한 별도 로컬 Next development 서버에서 수행했다.
모델 카탈로그 등 배경 API는 기존 E2E fixture 방식으로 명시적으로 mock했다.
메모리 압박에서 경로가 반복 컴파일되는 것을 막기 위한 개발 서버 설정은 검증에만
사용하며 제품 변경으로 남기지 않는다.
광범위 44개 회귀 실행은 자원 압박과 미모킹 배경 API의 초기 컴파일 때문에 중단했다.
위 필수 기존 6개는 별도의 명시적 fixture로 끝까지 다시 검증했다.
임시 PostgreSQL은 검증 후 종료했고 사용한 loopback 포트가 해제된 것을 확인했다.

## 독립 검토

`r-20261115-110226-00bf41`은 구현 커밋 `f3e50cee8`을 검토했다.
Claude(Anthropic)는 `accept` 및 minor/nit 의견을 반환했다. 두 번째 검토자
Copilot(Moonshot)은 `reviewer_exit_1`로 종료해 종합 결과는 **unknown**이다.
orchestrator의 unknown 재요청 금지 절차에 따라 자동 재제출하지 않았다.

완료 Message와 manifest를 함께 롤백하는 동작을 best-effort로 바꾸라는 minor 의견은
이번 원자성 요구와 상충하므로 적용하지 않는다. native prefix는 명시한 상한과 누락
고지를 유지한다. 일반 Review의 handoff probe는 서버 marker가 확인된 target에만
한정한다. 단일 모델 handoff는 기존 continuation GET으로 Message 저장 전에 참조를
재검증하며, 기존 다중 모델 admission의 최소 모델 수를 바꾸지 않는다.
Native는 이 요청에도 기존 parent unlock grant를 전달한다. Native bearer로 잠긴
external source를 해제하는 기능은 기존에도 지원하지 않으며 이번에도 거절을 유지한다.
참조 확인을 기다리는 동안 A→B→A로 계정이 전환돼도 이전 send가 Message를 저장하지
못하도록 기존 session revision을 확인한다.
검토 결과는 병합·배포 승인으로 사용하지 않는다.
