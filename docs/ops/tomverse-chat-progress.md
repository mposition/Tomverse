# Tomverse Chat 진행 현황

## 기준과 읽는 방법

이 문서는 사용자에게 전체 Chat의 진행 상황과 다음 작업을 일관되게 설명하기
위한 **진행 현황표**다. 구현 완료율, 품질 판정, 출시 승인 또는 현재 production
상태를 자동 산출하는 registry가 아니다.

- 작성 기준일: 2026-09-11.
- 이번 offline bridge 작업의 base: `8646fcb50f868268bc90bf47fe0032c171251b45`.
  선행 corpus PR #1359의 merge `8d86bd45efba789a058496128ecdd47b2033a9dd`를
  포함한다. merge와 배포·flag 활성화는 별도 상태로 기록한다.
- 기능 목록의 출처: 별도 worktree
  `H:/Project/tomverse-chat-mobile-web-plan-20260911/docs/policy/tomverse-chat-delivery-plan.md`의
  **미커밋 계획 업데이트**. 해당 worktree HEAD는
  `66932b07e44f565eb9e91bea5cd0daf8bc3e9eba`, 문서 SHA-256은
  `522702adc9114afaa853f54080fc56ac4512959a79d655d8235d53a66fbe810d`다.
  아래 C01–C21은 그 문서 14.2의 21개 요구사항 행, F01–F08은 14.4의
  8개 local-foundation 종료 산출물을 각각 고정한 것이다.
- 외부 계획의 구현 inventory는 `66932b07` 소스 조사 기준이다. 현재 저장소의
  [기존 개발 계획](../policy/tomverse-chat-delivery-plan.md)에 그 미커밋 업데이트가
  병합되어 있다고 주장하지 않는다. 로컬 경로는 외부 영구 보관의 보장도 아니다.
- 별도 표시가 없는 기능 행은 **그 계획이 기록한 기준 현황을 옮긴 것**이며,
  이번 bridge 작업에서 해당 기능·배포·기기를 다시 검증했다는 뜻이 아니다.
  새 source, 환경, 실행 관측으로 갱신할 때는 그 근거와 범위도 함께 기록한다.

**전체 Chat 완료율: 산정 보류.** 21행은 추적할 기능 영역이지 동일 작업량의
21개 완료 조건이 아니다. 가중치와 완료 판정 분모가 동결되지 않았으므로
행 수, 테스트 통과 수 또는 pending release gate 수를 백분율로 바꾸지 않는다.
이번 corpus의 48문항, 8개 cell, 기반 산출물 8개 역시 전체 Chat의 분모와 다르다.

구현 · 제품 연결 · 실행 검증 · 병합 · 배포/공개 · 품질/출시 승인은 구분한다.
같은 기준의 이전 전체 백분율이 없으므로 이번 변화량도 지어내지 않는다.

## 한눈에 보는 이번 상태

| 축 | 현재 기록 상태 | 이 기록이 뜻하지 않는 것 |
| --- | --- | --- |
| 공용 Chat 기반 | 기존 플랫폼 기능 다수 존재; 아래 기준 inventory 유지 | 새 Chat end-to-end 또는 모든 mode의 production 검증 완료 |
| 실행 계약 선행 slice | PR #1356이 base에 병합됨; 동결 코드의 221개 테스트와 6개 guard 기록 존재 | 48문항 v2 기반 전체 완료 또는 model-quality 향상 |
| 선행 48문항 corpus·oracle | 봉인 후 정답 48/48; 동결 `64c713fe` Claude round 1 approve·controller passed, PR #1359 병합 및 해당 staging 배포 성공 확인 | corpus 일치나 staging 배포가 모델 품질 향상 또는 production 공개라는 해석 |
| 이번 48문항 offline bridge | full catalogue plan·96개 mock·journal·정답 채점·Replay 연결 구현; 최종 source 검증·독립 검토 기록 준비 | 실제 provider 관측, 새 유료 승인 또는 Chat dispatch 검증 완료 |
| 모바일 Chat entry·단일 transcript | 계획의 후속 사용자 기능; 새 통합 상태는 본 회차에서 미검증 | 기존 Review panel을 숨기면 단일 Chat 구현이 된다는 해석 |
| Planner·품질 개선 | 계획된 후속 작업; 새 관측과 별도 판정 필요 | 이번 exact-answer fixture로 일반적인 최적 모델을 입증 |
| PWA·native·Memory Release B | 별도 milestone과 승인 경계 유지 | 모바일 웹 또는 corpus 작업의 자동 완료 범위 |

선행 slice의 실제 Claude 최종 판정은 `approve`와 문서 nit 1건이었고,
controller는 `on_hold / revisions_exhausted`로 종료했다. 사용자의 별도 문서
정정·기록 기반 PR 진행 결정 이후 병합된 것이며, controller가 통과로 바뀐
것이 아니다. 자세한 출처와 제한은
[선행 검토 기록](router-development-benchmark/execution-contract-v2-review-20260911.md)에 있다.

## 전체 기능 inventory — 고정 21개 영역

아래 행의 존재나 기존 구현은 전체 기능 완료를 뜻하지 않는다. C20을 제외한
행에 대해 이번 회차의 새로운 실행 검증 또는 공개 승인을 부여하지 않는다.

| ID | 기능 영역 | 계획이 기록한 기준 현황 | 남은 핵심 확인·작업 |
| --- | --- | --- | --- |
| C01 | Chat 제품 진입·새 대화 | 제품별 생성·경계 helper 존재; `/chat` surface는 Review shell 경로 | gated Chat entry 연결, productKey reader/cutover 근거, legacy link 보존 |
| C02 | 모델 변경을 가로지르는 단일 답변 | runtime/message primitive 존재; 기존 이력은 모델별 panel/filter | 모델과 무관한 timeline, version·attempt 연결, follow-up 보존 |
| C03 | Auto·수동·명시적 Auto 복귀 | Router/filter/sticky/UI/server 경로 존재 | 새 Chat consumer와 policy·dispatch·manifest 일치, 별도 readiness |
| C04 | 답변 provenance | badge와 model metadata 렌더 기반 존재 | 최종 응답 provider/model, recovery 표시, Planner와 답변 저자 분리 |
| C05 | streaming·stop·regenerate·edit/resend | 기존 Review runtime와 관련 E2E 정의 존재 | unified timeline의 partial/reconnect/mutation ownership 회귀 |
| C06 | draft·계정 격리·reload | identity/conversation scoped in-memory draft 기반 | reload persistence는 별도 정책 결정; 격리와 logout 경계 유지 |
| C07 | 작은 화면·키보드·접근성 | composer/drawer/scroll 계약과 기존 모바일 surface | 새 Chat의 320px·IME·zoom·safe-area·focus·기기 확인 |
| C08 | conversation context·긴 대화 | context fit/preflight/attachment resolution 기반 | 모델 변경 follow-up과 실제 포함 context, reserve/dispatch/manifest 일치 |
| C09 | Voice Input | recorder/transcription/scoped draft append 존재; 계획은 사용자 production 활성 확인을 기록 | 새 composer 재사용·회귀; 이번 회차에서 live flag/기기를 다시 확인한 것은 아님 |
| C10 | 파일·이미지·문서·Drive | upload/reference와 Drive picker 기반 존재 | 소유권·권한·모델별 지원 조합 및 follow-up context 보존 |
| C11 | 웹 검색·citation | native/app-managed/search-model 경로 존재 | 실제 backend readiness, search budget, citation provenance 보존 |
| C12 | Deep Research·장기 작업 재진입 | persisted job/polling/remount recovery 기반 | 새 Chat status/re-entry/settlement 통합; polling 중지와 server 취소 구분 |
| C13 | Artifacts·생성 파일·다운로드 | tool assembly·artifact·owned download 기반 | reopen과 model/auth/search 조합별 지원·다운로드 회귀 |
| C14 | 프로젝트·이력·검색 | sidebar assignment와 owned conversation search 기반 | 제품별 destination, legacy link, project와 knowledge/Memory 구분 |
| C15 | Assistant profile·knowledge | versioned profile/context builder/retrieval 기반 | binding/version/tool intersection·소유권과 현재 flag 확인 |
| C16 | 공유·export·삭제 | share/export/delete/cleanup와 registry 기반 | 새 Chat 회귀, retry/job 중 삭제, account lifecycle 확인 |
| C17 | estimate·reserve·settle·refund | 공용 credit와 attempt billing 기반 | 새 경로의 primary/pass-through/fallback·중복·취소 회귀 |
| C18 | 안전·개인정보·moderation | 소유권·lock·context 정책과 enforcement 기반 | Auto/manual/Planner/pass-through/fallback 전체 mode의 적용 추적 |
| C19 | Prompt Refiner·Planner | state/version/failure plumbing; 계획은 active normal Planner call을 확인하지 못함 | 책임 경계·same-model pass-through 구현, 품질·지연·비용 별도 측정 |
| C20 | Benchmark·collector·Replay | v1/collector/Replay·실행 계약·48문항 corpus 병합; 이번 별도 v2 plan·96개 mock·journal·Replay 연결 구현 | 이번 최종 source 검증과 Claude 판정·병합은 별도 기록; 실제 provider 관측·정책 실험·Chat 연결은 남음 |
| C21 | 공용 package·PWA·native | 기존 `chat-core`·`ui-tokens`; 추가 package/shell은 별도 architecture milestone | 필요한 seam 추출과 플랫폼 회귀; PWA/native/store는 별도 완료·승인 |

## Benchmark v2 개발 기반 — 별도 8개 종료 산출물

이 목록은 전체 v2 기반의 범위다. **이번 offline bridge의 완료 조건과 같지 않다.**
선행 8-row mock은 기존 v1 corpus와 실행 계약의 배선 검증이며, 48문항에 대한
collector/Replay 실행 증거로 승격하지 않는다.

| ID | 종료 산출물 | 선행 근거와 이번 범위 |
| --- | --- | --- |
| F01 | versioned corpus/schema·coverage·독립 expected derivation | 48문항·8 cell·12 family·24/24 partition 및 oracle 정답 48/48; 선행 동결 source 검토 승인·PR #1359 병합 |
| F02 | source/prompt/context/model/cap/settings/mode 실행 계약 | 이번 v2 plan/partition 재구성 후 96개 mock contract를 raw journal terminal과 결속; 실제 product dispatch는 미검증 |
| F03 | refusal·unmeasured·acquisition·response·correctness 분리와 전체 분모 | 이번 full 2,016행 중 계획 가능 720·거절 1,296 유지; 선택 96과 미선택·미관측을 model/cell/partition/family별로 분리 |
| F04 | correctness/acquisition 및 시간·usage·가격·billed cost 분리 | mock 호출만 96개; token·TTFT·whole-call·end-to-end·billed cost 전부 null, 실제 provider 성능·청구 관측 없음 |
| F05 | dry-run→mock collection→journal→grading/Replay/report | 이번 48문항 연결 구현; 2 terminal 뒤 중단→94개 재개→반복 0, intent-only hold·export 거절 및 length hold 검증 경로 |
| F06 | corpus/plan/result/answer parser bound와 경계 검사 | 기존 200,000 nodes/16 MiB·선택 1,008 상한 유지; full v2 plan/manifest와 실제 저장 JSON 재파싱 및 byte/node 계측 |
| F07 | 재현 명령·안전 artifact·제안 상태 paid manifest | 별도 v2 mock CLI/새 artifact directory 구현; legacy live 입구 거절, 신규 paid manifest·승인은 후속 결정이며 과거 60회 승인 재사용 금지 |
| F08 | 동결 commit 테스트·Claude 독립 검토·정직한 잔여 기록 | 선행 검토/병합과 별개로 이번 source 검증·동결 패키지·Claude 판정 준비; 검토·병합·배포는 아직 대기 |

## 선행 corpus의 고정 범위와 독립성

목표는 두 task × 한국어/영어 × basic/advanced의 **8 cell × 6문항 = 48문항**이다.
task마다 여섯 template family를 두고 각 family는 네 language/difficulty
조합에 하나씩 존재한다. task마다 세 family 전체를 tuning, 나머지 세 family
전체를 development-validation으로 동결하여 총 24/24와 cell별 3/3을 유지한다.
이는 engineering coverage와 partition 규칙이지 통계적 `n`, 대표 트래픽,
측정된 난이도 또는 모델별 호출 권한이 아니다.

별도 oracle agent는 `{id, prompt}`만 든 packet으로 규칙을 해석했다. 2026-09-11
06:48:55 UTC에 oracle source와 48건 도출 결과를 봉인했고, 이후 별도 허용을
받은 oracle 담당자의 봉인 결과 gold 대조는 06:50:34 UTC에 **48/48 일치**를 기록했다. 이 대조에서
gold나 oracle source를 수정하지 않았다. 봉인 source SHA-256은
`e925fcf88db9dc2629079bb190082d4285ed33ef8082e35f2c0c32e40d1939be`,
결과 파일 SHA-256은
`d54d9111d6be6451137e3350e229103e0b560d7b6f99d149e6d1a14c740bbe20`다.
역할 분리는 절차적 독립성이고 ACL에 의한 비밀 분리, 두 사람의 판단 또는
범용 모호성 검출을 보장하지 않는다. 범위는 주어진 prompt 규칙의 결정적 검증이다.

standalone 구현·봉인 및 검증 절차는
[corpus v2 guide](router-development-benchmark/corpus-v2.md)에 기록한다.
봉인 후 CLI 테스트는 10/10 통과했고 실패·취소·skip·todo는 0이었다.
선행 corpus slice의 precommit 검증은 신규 corpus/oracle/CLI 99개, 기존 실행 계약 26개,
benchmark 96개, collector 80개, Replay 19개로 **320/320 통과**했다.
타입·lint·corpus 검사·encoding·문서 참조·정책 절 참조·diff whitespace의
7개 guard도 통과했고, 검증 전후 12개 scope 파일의 해시는 같았다.
이는 precommit 관측이며, 결과를 이 문서에 기록한 수정까지 같은 바이트로
검사했다는 주장은 아니다. 동결 패키지 검사와 Claude 독립 검토 결과는 별도다.
이 문서를 포함한
미래 commit의 승인을 이 문서가 먼저 선언하지 않는다. source review 이후의
결과는 별도 동결 review receipt로 결속할 수 있으며, 그 결과를 적기 위해 이미
검토한 source를 조용히 바꾸지 않는다.

## 이번 bridge의 범위와 상태

이번 구현은 별도 [offline bridge guide](router-development-benchmark/bridge-v2.md)의
범위다. full catalogue 2,016행과 48문항·8 cell·12 family·24/24 partition을
유지하면서 두 모델의 96개 답변을 고정 mock으로 생성한다. 실제 provider 호출과
발생 비용은 0이고, 모형 실행의 정답 비율은 모델 품질 증거가 아니다.
v1 corpus·60회 유료 증거·원래 Replay source 허용 규칙은 그대로 보존한다.

선행 corpus 동결 source `64c713fea47d7fa67b237b99ad8b6e928cc61b66`는 Claude
round 1 `approve`, 지적 0건, controller `passed`로 확인됐다. PR #1359는
2026-09-11 07:56:17 UTC에 `8d86bd45efba789a058496128ecdd47b2033a9dd`로 병합됐고,
해당 commit의 Railway staging deployment
`8969295a-15f4-4726-9096-ad366ea1c183`은 `SUCCESS`로 확인됐다. 이 관측은
이번 bridge의 검토·병합·배포가 아니다. 이번 source freeze에서의 실제 테스트와
Claude 판정은 별도 동결 검증 기록에 결속하며, 이 문서가 자기 승인을 선언하지 않는다.

## 권장 다음 순서와 필요한 결정

1. **이번 offline bridge의 최종 검증과 동결 source Claude 독립 검토를 마친다.**
   schema·raw journal·gold 격리·미측정 분모를 먼저 확인한다. 독립 검토는 이번
   scope와 새 승인 기록에만 결속하며, 과거 검토나 60회 유료 승인을 상속하지 않는다.
   검토 이후의 PR·병합·배포 상태는 각각 별도로 보고한다.
2. **gated Chat entry·단일 transcript·recovery를 별도 제품 작업으로 준비.**
   실제 사용자 흐름을 진전시키는 단계이며 유료 benchmark 결과를 기다릴 필요는
   없다. 다만 product-entry/소유권 경계 검토, draft persistence 정책 및 공개/cutover
   결정이 필요한 부분은 별도로 승인받는다.
3. **필요한 경우 동결 proposal 이후에만 새 provider 관측 비용과 실행 범위를 결정.**
   정확한 row·호출·예산·중단 규칙이 있어야 새 유료 승인을 요청할 수 있다.
   관측 전에는 Router quality band 게시, 제품 품질 향상 또는 출시 승인을 주장하지 않는다.

이 순서의 추천 자체는 신규 자동 착수·유료 실행·병합·배포 승인이 아니다.
