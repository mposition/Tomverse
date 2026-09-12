# Tomverse Chat 진행 현황

## 기준과 읽는 방법

이 문서는 사용자에게 전체 Chat의 진행 상황과 다음 작업을 일관되게 설명하기
위한 **진행 현황표**다. 구현 완료율, 품질 판정, 출시 승인 또는 현재 production
상태를 자동 산출하는 registry가 아니다.

- 작성 기준일: 2026-09-12. 아래 선행 benchmark의 고정 기록은 2026-09-11
  당시 관측을 보존하며, 새 Chat 사용자 흐름의 상태는 별도 갱신 구획에서 구분한다.
- 이번 Chat 진입·단일 transcript·복구 작업의 base는
  `14997bcfbfa90c9bc431efcbba7b0a9ae3490859`다. PR #1367 merge
  `409cf20d1225b33958a051d21ea938cb6b62ac6e`와 해당 staging deployment
  `1a875926-ec67-41b9-9a98-56edbd596cac`의 `SUCCESS`를 확인했다.
  이 선행 배포 확인은 이번 새 변경의 배포나 flag 활성화를 뜻하지 않는다.
- 게시된 offline bridge PR #1366의 base: `8646fcb50f868268bc90bf47fe0032c171251b45`.
  선행 corpus PR #1359의 merge `8d86bd45efba789a058496128ecdd47b2033a9dd`를
  포함한다. merge와 배포·flag 활성화는 별도 상태로 기록한다.
- 2026-09-11 당시 식별자 테스트·진행 기록 후속의 base는 PR #1366의 동결 source
  `d84c90035582638ffd77f2d07677aa0aefa2c248`다. 원래 검토 기록과 별도 변경이며
  **그 당시 고정 기록에서는** 이 후속 source의 독립 검토 전이었다. 아래
  2026-09-12 Chat 사용자 흐름의 검토 상태와 혼합하지 않는다.
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
  게시된 bridge 작업에서 해당 기능·배포·기기를 다시 검증했다는 뜻이 아니다.
  새 source, 환경, 실행 관측으로 갱신할 때는 그 근거와 범위도 함께 기록한다.

## 전체 웹 Chat 계획 추정 — planning-estimate-v1

**현재 약 60%, 주관적 계획 범위 50–70%. 이전 약 55% 대비 +5%p.**
사용자가 요청한 대략적인 구현 진척 설명이며, 정식 완료율·품질 인증·출시
준비도는 아니다. 이번 로컬 사용자 흐름 연결을 반영한 잠정 계획 판단이다.
대상은 모바일 화면을 포함한 현재 **웹 Chat**의 C01–C20과 C21의 필요한 공용
연결부다. C21의 PWA·native·store는 별도 미래 milestone으로 계속 추적하며,
완료로 간주하거나 이 웹 범위의 백분율을 전체 크로스플랫폼에 적용하지 않는다.

| 중복 없는 기능 그룹 | 계획 가중치 | 주관적 진척 추정 | 근거와 남은 불확실성 |
| --- | --- | --- | --- |
| C08–C18 기존 플랫폼 기능 | 40% | 약 80% | 재사용할 구현 기반이 다수 있으나 새 Chat 통합·mode별 회귀·기기 검증 완료율은 아님 |
| C01–C07 + C21의 웹 공용 연결부 | 40% | 약 60% | gated entry·모델 변경을 가로지르는 transcript·명시적 질문 복구를 로컬 연결; 공개 전환·서버 재개·전체 기기 검증은 남음 |
| C19–C20 Refiner·Planner·품질 평가 | 20% | 약 25% | 일부 plumbing과 offline 평가 기반은 있으나 정상 Planner 호출·실제 provider 관측·제품 품질 검증이 남음 |

계산은 `0.40 × 80 + 0.40 × 60 + 0.20 × 25 = 61%`이며, 과도한 정밀도를
피해 5%p 단위로 반올림하여 약 60%로 전달한다. 이전 계산은 동일한 가중치에서
연결부 40%를 적용한 53% → 약 55%였다. 이번 연결부 20%p 증가 판단만 반영했고
기존 플랫폼·Planner 그룹, 웹 범위·분모·산정 방법 버전은 바꾸지 않았다.
가중치와 그룹 추정은 inventory와 이번 구현 근거를 바탕으로 한 계획 판단이지
새 전체 코드 감사나 측정값이 아니다. 50–70%는 오래된 inventory와 미확인 통합
작업량의 불확실성을 드러내는 주관적
범위이며 통계적 신뢰구간이 아니다. 21행은 같은 작업량의 완료 조건이 아니므로
행 수·테스트 수·release gate 수를 단순 비율로 바꾸지 않는다. 선행 corpus의
48문항·8개 cell·별도 기반 산출물 8개도 전체 Chat의 분모가 아니다.

구현 · 제품 연결 · 실행 검증 · 병합 · 배포/공개 · 품질/출시 승인은 구분한다.
이전 식별자 테스트·문구 보완 회차의 증분 0%p는 그대로다. 이번 증분은 그 기록을
다시 평가한 것이 아니라 새로운 사용자 흐름 구현 때문이다. 이후 의미 있는
작업 회차마다 전체 추정·불확실성 범위, 변경 이유
(변화가 없으면 0%p와 이유, 기준 변경이면 새 기준임을 명시), 순서가 있는 다음
작업과 필요한 승인을 함께 보고한다. 정밀 측정이 없다는 이유로 대략적 설명을
보류하지 않고 범위와 근거의 한계를 제시한다. 범위·가중치를 바꿀 때는 방법
버전을 올려 이전 수치와의 직접 비교 가능 여부를 기록한다.

## 이번 Chat 사용자 흐름 — 로컬 구현 상태

범위와 경계는 [이번 구현 계획](chat-entry-transcript-recovery-v1.md)에 있다.

| 축 | 이번 변경 | 아직 뜻하지 않는 것 |
| --- | --- | --- |
| C01 진입·새 대화 | `/chat/workspace`에 서버 gate·owned read·Chat 전용 생성 연결; 기존 `/chat`은 Review 유지 | 공개 cutover, flag 활성화, 기존 데이터 일괄 변경 |
| C02·C04 단일 흐름·저자 | 모델과 무관한 대화 runtime·전체 모델 history; fallback/routed/requested 순서로 답변 저자 표시 | 모든 모델의 일반적인 최적성 또는 새로운 Router 품질 증거 |
| C05·C06 중단·초안 | partial과 오류 안내 분리; 선택한 실패 질문·첨부를 명시적으로 복원하고 새 질문에 저장; 준비 중 계정·대화·모델·새 Chat 의도 변경과 수정한 초안 보호 | 새로고침 뒤 미저장 partial 복구, 서버 attempt 재개, draft 디스크 저장 |
| C07 모바일·기존 기능 | 기존 composer·drawer·Review·Studio 경로를 재사용하고 mock 브라우저 회귀 검증 | 실제 OS/키보드·native 앱 검증 또는 모든 기능 조합의 운영 검증 |
| 검증 | 마지막 수정본 build·typecheck·42파일 lint 통과; 브라우저 328개와 격리 PostgreSQL 42개 통과, 기존 project skip 85개는 별도 집계 | Linux golden·실기기·운영 DB·실제 R2/provider 검증 또는 아직 실행하지 않은 동결 패키지 체크의 통과 |
| 독립 검토 | 실제 Claude round 0의 7건 수정 후 round 1은 approve + nit 2건; controller는 awaiting_revision. 두 항목 보완·검증 후 마지막 round 2 검토 대기 | controller 통과, 기존 작업의 승인 상속, 사람의 출시 승인 |
| 병합·배포 | 이번 변경은 로컬 작업이며 미병합·미배포 | 선행 #1367 배포를 이번 코드의 배포로 해석 |

Windows conversation-writer 검사기의 경로 정규화도 포함한다. 기존 검사 규칙과
허용 목록은 유지하며, 실제 CLI가 허용 writer를 통과시키고 비허용 production
writer를 거부하는 회귀 테스트를 추가했다. 테스트 실패를 면제한 것이 아니다.

### 마지막 round 2 수정본의 로컬 근거

round 1의 source `43fc1a36d7f0104975391a8645e0f53d74a94170`와
digest `sha256:c902e6ba41ad3c0577cb0271c31c40c2b6251106feecb550e58b345bc372cf10`에
대한 실제 Claude 판정은 approve였지만, 지적 2건이 남아 제어 프로그램은
통과로 처리하지 않았다. Chat의 오류 복구 버튼이 기존 모델 선택기를 열도록
연결하고, 모델 제거 핸들러는 확인창·설정 변경·DELETE 전에 Chat을 거부하도록
보완했다. Review 동작은 유지했다. 현재 UI에서 삭제에 도달할 수 있었다는
주장은 아니며, 이 항목은 핸들러 자체의 방어 보강이다.

새 round2 기록은 브라우저 **328건 통과**(Chat 34+34, 주변 회귀 150+82,
첨부 28), 기존 skip 85건·실패 0건이다. 같은 Linux golden 2건은 미실행으로
남겼고 gate를 완화하지 않았다. 격리 PostgreSQL 42건, build·typecheck·42파일
lint도 새로 통과했다. 실제 공급자·R2·운영 DB 호출은 없다.

최종 검사들은 `2026-09-12T07:33:18.716Z`까지 완료했다. UI·정적 검사 47경로
scope SHA는 `f664738db1f702778d4f3497bb1a05ec7fba8968cc044a01cbe54954e14c7df2`로
전후 동일했다. DB와 UI를 포함한 열 개 receipt의 파일별 해시를 실제 소스와
대조해 차이 0을 확인했다. 두 운영 문서만 이후 갱신하며, 나머지 45경로는
유지한다. 새 동결 패키지가 문서와 소스를 결속하고 자체 검사를 실행해야 한다.
마지막 허용 round 2의 독립 판정은 이 소스 기록 시점에 아직 대기 중이다.

동일 기능 사이클의 수정이므로 전체 웹 Chat 추정은 **약 60%**, 작업 시작 전
약 55% 대비 **+5%p**를 유지한다. 이번 nit 보완에 추가 진척을 더하지 않는다.
권장 순서는 마지막 독립 검토·PR 통합 CI → 승인 범위의 staging 흐름 확인 →
영속 중단 복구 계약·구현 → Refiner/Planner 및 별도 승인된 모델 품질 평가다.
병합·배포·flag 활성화·새 과금은 이 기록이 승인하지 않는다.

### 이전 round 1 수정 검토에서 보존한 로컬 근거

같은 작업의 round 0 커밋 `af298c77b034e1eee894bc5103f8dafe65ac7a6b`와
실제 Claude 지적 7건은 보존했다. 새 초안의 단일 모델 초기화, 정확한 실패 안내,
빈 실패 메시지의 요청 문맥 제외, 복원 첨부의 새 메시지 영속화, 정책 정합성,
선형 복원 대상 계산, 오류 분류를 보완했다. 같은 null ID를 유지한 New Chat이
이전 요청을 무효화하지 못하던 경합도 실제 재현 후 intent ticket으로 막았다.

`round1-*` 최종 기록의 브라우저 324건은 새 Chat 32+32, 인접 회귀 150+82,
기존 첨부 회귀 28건이다. 기존 조건부 skip 85건과 Linux golden 미실행 2건은
통과에 넣지 않았다. build·typecheck·42개 코드 파일 lint도 통과했으며 UI·정적
검사 동안 47개 파일의 scope SHA-256은
`50a82d41ee070d90384f76c66a40233ad4246612ce1be2cfc5f5606647634911`로
전후 동일했다. DB와 UI 기록은 manifest 형식이 달라 aggregate hash가 다르지만
47개 파일별 해시를 대조한 차이는 0이다.

격리 PostgreSQL은 기존 migration 99개와 drift 검사를 통과했고, 기존 첨부
28개·새 재전송 14개 테스트가 통과했다. 실제 행·동시성·트랜잭션 timeout
`P2028`은 관측했지만 객체 저장소는 stub이다. 원본과 새 첨부의 수명주기를
분리하고, 파일 복사는 DB 트랜잭션 밖에서 끝낸다. 강제 종료·불명확한 원격
쓰기 결과·cleanup DB 불능까지 원자적 정리를 보장하는 것은 아니다.

이 두 운영 문서는 최종 실행 후 기록을 갱신했다. 나머지 45개 파일은 동일하며
precommit·검토 패키지가 최종 문서와 소스 해시를 새로 결속해야 한다. 이 기록은
아직 실행하지 않은 round 1 독립 승인을 앞당겨 주장하지 않는다. 같은 개발
사이클 안의 수정 검토이므로 전체 계획 추정은 **약 60%, 이전 회차 대비 +5%p**로
유지하고, 검토 지적을 고친 횟수만큼 진척률을 다시 더하지 않는다.

다음 권장 순서는 ① 수정본 Claude 검토·PR 통합 CI, ② 승인된 gate 범위의 staging
사용자 흐름 확인, ③ 영속 중단 복구 계약·구현, ④ Refiner/Planner 연결과 별도 승인된
실제 모델 품질 평가다. 새 과금·flag 활성화·병합·배포 승인을 포함하지 않는다.

### 이전 round 0에서 보존한 로컬 실행 근거

보관 위치는 `H:/Project/chat-entry-transcript-recovery-evidence-20260912/`다.
아래 여섯 디렉터리의 `command.json`, `output.log`, `result.json`,
`source-before.json`, `source-after.json`을 대조했다. 각 실행은 exit 0,
`sourceUnchanged: true`이며 39개 scope 파일 목록과 전후 SHA-256이 모두
`e9e55ef3b7e96e22f25816943e1e3724e8c1b804b3e4dd097841b0bb2fcf409d`로 같았다.
당시 구현은 미커밋 상태여서 receipt의 HEAD는 base다. HEAD만이 아니라 개별
파일 해시와 scope 해시가 실제 실행 바이트를 식별한다.

| 실행 | 등록 | 통과 | 기존 project skip | 실패 |
| --- | --- | --- | --- | --- |
| `final-chat-e2e` | 20 | 20 | 0 | 0 |
| `affected-desktop-e2e` | 187 | 150 | 37 | 0 |
| `affected-mobile-e2e` | 130 | 82 | 48 | 0 |

`final-build`는 로컬 production build, `final-typecheck`는 `next typegen`과
`tsc --noEmit --incremental false`, `final-scoped-lint`는 변경 JS/TS 37파일의
`eslint --max-warnings=0` 통과를 기록한다. 브라우저 통과는 합계 **252개**이며,
skip 85개를 성공에 더하지 않는다. Windows에서 Linux 기준 composer golden
2개는 `--grep-invert=golden`으로 해당 실행 대상에서 제외했다. 위 등록 수에는
이 제외분이 없으며, golden·검증 gate를 수정하거나 면제하지 않았다.
따라서 Linux canonical golden 확인은 여전히 남아 있다.

새 Chat에는 A→B 모델 변경 후 이력·context, stop/re-entry·partial, GET-only
reload·정확한 질문 복원, 준비 중 모델 변경·초안 편집, 늦은 create/미분류 대화
조회, 계정 변경, 320/390px·200% text·조합 입력의 mock 관측이 있다. 영향 회귀는
기존 composer·drawer·picker·comparison rail·image workspace·대화 전환을
검사한 것이다. 실기기 OS/키보드·Safari, 실제 DB 영속화·운영 계정·공급자 호출의
증거는 아니며 실제 provider 호출은 없었다. 기존 영향 회귀 로그의 dummy
loopback DB·verification 거부도 실제 backend 성공으로 해석하지 않는다.

개발 중 관측한 focused runtime 54·SSR 4·server 19·pure 24·writer/CLI 17개의
통과는 **중간/개발 관측**이다. 동결 패키지에서는 그 source에 대해 재실행하여
기록할 예정이며, 위 scope 해시의 최종 패키지 통과로 미리 승격하지 않는다.
초기 fixture 오류와 중간 build/browser 결과는 같은 보관 루트의
`pre-archive-observations.md`에 별도로 남겼다.

이 완료 기록과 구현 계획의 결과 문구는 위 실행 뒤에 작성했다. 두 Markdown도
당시 scope에 포함됐으므로 이 문서 수정 후의 aggregate digest는 달라진다.
receipt는 그대로 보존하며, 미래 commit이나 이 새 문구가 이미 검사·승인됐다고
주장하지 않는다. 이번 기록 pass는 앱·테스트 소스를 바꾸지 않는다. 실제 Claude
판정과 최종 패키지 결속은 다음 단계이며, 현재는 여전히 미병합·미배포다.

## 선행 benchmark 상태 — 2026-09-11 고정 기록

| 축 | 현재 기록 상태 | 이 기록이 뜻하지 않는 것 |
| --- | --- | --- |
| 공용 Chat 기반 | 기존 플랫폼 기능 다수 존재; 아래 기준 inventory 유지 | 새 Chat end-to-end 또는 모든 mode의 production 검증 완료 |
| 실행 계약 선행 slice | PR #1356이 base에 병합됨; 동결 코드의 221개 테스트와 6개 guard 기록 존재 | 48문항 v2 기반 전체 완료 또는 model-quality 향상 |
| 선행 48문항 corpus·oracle | 봉인 후 정답 48/48; 동결 `64c713fe` Claude round 1 approve·controller passed, PR #1359 병합 및 해당 staging 배포 성공 확인 | corpus 일치나 staging 배포가 모델 품질 향상 또는 production 공개라는 해석 |
| 게시된 48문항 offline bridge | 동결 `d84c900`에서 339/339·guard 7개 통과; Claude 최종 approve·nit 2건, controller on_hold; 기록 기반 PR #1366 게시 | controller passed, 실제 provider 관측, 새 유료 승인 또는 Chat dispatch 검증 완료 |
| 이번 식별자 검사·진행 기록 후속 | 기존 96행·2모델로 선택 식별자와 거부 검사를 보강; 웹 Chat 계획 추정의 첫 기준 정리 | 원래 검토의 재개·판정 변경 또는 이 후속 source의 독립 검토 완료 |
| 모바일 Chat entry·단일 transcript | 계획의 후속 사용자 기능; 새 통합 상태는 본 회차에서 미검증 | 기존 Review panel을 숨기면 단일 Chat 구현이 된다는 해석 |
| Planner·품질 개선 | 계획된 후속 작업; 새 관측과 별도 판정 필요 | 기존 exact-answer fixture로 일반적인 최적 모델을 입증 |
| PWA·native·Memory Release B | 별도 milestone과 승인 경계 유지 | 모바일 웹 또는 corpus 작업의 자동 완료 범위 |

실행 계약 선행 slice의 실제 Claude 최종 판정은 `approve`와 문서 nit 1건이었고,
controller는 `on_hold / revisions_exhausted`로 종료했다. 사용자의 별도 문서
정정·기록 기반 PR 진행 결정 이후 병합된 것이며, controller가 통과로 바뀐
것이 아니다. 자세한 출처와 제한은
[선행 검토 기록](router-development-benchmark/execution-contract-v2-review-20260911.md)에 있다.

## 전체 기능 inventory — 고정 21개 영역

아래 행의 존재나 기존 구현은 전체 기능 완료를 뜻하지 않는다.
아래는 계획의 기준 inventory이며, 이번 작업이 갱신한 영역은 위 구획에 따로
적는다. 선행 두 파일 후속은 어느 행에도 제품 실행 검증이나 공개 승인을
부여하지 않았으며, 이번 로컬 구현도 공개 승인을 부여하지 않는다.

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
| C20 | Benchmark·collector·Replay | v1/collector/Replay·실행 계약·48문항 corpus 병합; v2 plan·96개 mock·journal·Replay의 PR #1366 게시 | 원래 검토는 approve·nit 2건으로 on_hold; 후속 독립 검토·병합은 별도이며 실제 provider 관측·정책 실험·Chat 연결은 남음 |
| C21 | 공용 package·PWA·native | 기존 `chat-core`·`ui-tokens`; 추가 package/shell은 별도 architecture milestone | 필요한 seam 추출과 플랫폼 회귀; PWA/native/store는 별도 완료·승인 |

## Benchmark v2 개발 기반 — 별도 8개 종료 산출물

이 목록은 전체 v2 기반의 범위다. **게시된 offline bridge의 완료 조건과 같지 않다.**
선행 8-row mock은 기존 v1 corpus와 실행 계약의 배선 검증이며, 48문항에 대한
collector/Replay 실행 증거로 승격하지 않는다.

| ID | 종료 산출물 | 선행 근거와 게시된 bridge 범위 |
| --- | --- | --- |
| F01 | versioned corpus/schema·coverage·독립 expected derivation | 48문항·8 cell·12 family·24/24 partition 및 oracle 정답 48/48; 선행 동결 source 검토 승인·PR #1359 병합 |
| F02 | source/prompt/context/model/cap/settings/mode 실행 계약 | 게시된 bridge의 v2 plan/partition 재구성 후 96개 mock contract를 raw journal terminal과 결속; 실제 product dispatch는 미검증 |
| F03 | refusal·unmeasured·acquisition·response·correctness 분리와 전체 분모 | 게시된 bridge의 full 2,016행 중 계획 가능 720·거절 1,296 유지; 선택 96과 미선택·미관측을 model/cell/partition/family별로 분리 |
| F04 | correctness/acquisition 및 시간·usage·가격·billed cost 분리 | mock 호출만 96개; token·TTFT·whole-call·end-to-end·billed cost 전부 null, 실제 provider 성능·청구 관측 없음 |
| F05 | dry-run→mock collection→journal→grading/Replay/report | 게시된 bridge에서 48문항 연결 구현; 2 terminal 뒤 중단→94개 재개→반복 0, intent-only hold·export 거절 및 length hold 검증 경로 |
| F06 | corpus/plan/result/answer parser bound와 경계 검사 | 기존 200,000 nodes/16 MiB·선택 1,008 상한 유지; full v2 plan/manifest와 실제 저장 JSON 재파싱 및 byte/node 계측 |
| F07 | 재현 명령·안전 artifact·제안 상태 paid manifest | 별도 v2 mock CLI/새 artifact directory 구현; legacy live 입구 거절, 신규 paid manifest·승인은 후속 결정이며 과거 60회 승인 재사용 금지 |
| F08 | 동결 commit 테스트·Claude 독립 검토·정직한 잔여 기록 | bridge `d84c900`의 339/339·guard 7개, Claude approve·nit 2건과 on_hold를 보존하고 PR #1366 게시; 후속 source 검토·병합·배포는 별도 |

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

## 게시된 bridge의 범위와 당시 후속 상태 — 2026-09-11 고정 기록

게시된 bridge 구현은 별도 [offline bridge guide](router-development-benchmark/bridge-v2.md)의
범위다. full catalogue 2,016행과 48문항·8 cell·12 family·24/24 partition을
유지하면서 두 모델의 96개 답변을 고정 mock으로 생성한다. 실제 provider 호출과
발생 비용은 0이고, 모형 실행의 정답 비율은 모델 품질 증거가 아니다.
v1 corpus·60회 유료 증거·원래 Replay source 허용 규칙은 그대로 보존한다.

선행 corpus 동결 source `64c713fea47d7fa67b237b99ad8b6e928cc61b66`는 Claude
round 1 `approve`, 지적 0건, controller `passed`로 확인됐다. PR #1359는
2026-09-11 07:56:17 UTC에 `8d86bd45efba789a058496128ecdd47b2033a9dd`로 병합됐고,
해당 commit의 Railway staging deployment
`8969295a-15f4-4726-9096-ad366ea1c183`은 `SUCCESS`로 확인됐다. 이 관측은
bridge PR #1366의 검토·병합·배포가 아니다.

게시된 bridge의 동결 source는 `d84c90035582638ffd77f2d07677aa0aefa2c248`,
변경 digest는 `sha256:01cf233f93bc2d5fef0ad16723e93dd68c129ae4c602a662699d5fa46ead4921`이다.
이 source의 패키지는 bridge 19·corpus 99·실행 계약 26·benchmark 96·collector 80·
Replay 19로 **339/339**, guard 7개 통과를 기록했다. 실제 Claude 최종 round 2는
`approve`와 evidence nit 2건이었고, controller는 `on_hold / revisions_exhausted`로
종료했다. 최초 round 0의 CLI 파싱 실패 원본은 보존했고, 사용자 승인 후 유일한
JSON 블록을 무변형 등록하여 정상 수정 검토를 진행한 이력도 그대로 유지한다.

사용자의 별도 기록 기반 게시 결정으로 [PR #1366](https://github.com/mposition/Tomverse/pull/1366)을
공개했다. 2026-09-11 게시 직후 관측은 `OPEN`, base `develop`, 위 동결 head,
CI 대기, 자동 병합 없음이다. 이는 이후 CI·병합·배포 상태를 미리 판정한 것이
아니며, 원래 controller가 `passed`로 바뀐 것도 아니다.

2026-09-11 당시 별도 후속은 테스트와 이 진행 문서 두 파일만 보완한다. 기존 fixture에는
모델 선택이 다른 21쌍·같은 27쌍이 있으므로 새 모델이나 수집 없이 실제 report
정책의 selector 결과와 modelId·rowId·reason을 결속한다. 같은 검사로 메모리상의
candidate=baseline 투영을 거부하며, runtime 소스 변조 후 전체 19개 테스트를
실행했다는 증거로 표현하지 않는다. corrected/regressed가 0인 기존 fixture,
96개 mock, runtime·정답·모델·유료 실행 범위는 바꾸지 않는다. 그 고정 기록에서
후속 source는 독립 검토 전이며, 원래 검토 기록·승인·source 바이트를 덮어쓰지
않는다. 이 문단은 2026-09-12 새 Chat slice의 현재 상태 보고가 아니다.

## 권장 다음 순서와 필요한 결정

1. **이번 slice의 최종 source 검증·Claude 독립 검토를 마친 뒤 통합한다.**
   중간 트리 실행과 최종 동결 실행을 분리한다. 기존 검토 기록은 재개하지 않으며
   실패한 체크나 미해결 지적을 면제하지 않는다. 통합 CI, staging 검증, 공개
   cutover·flag 활성화는 별도 단계다.
2. **gated staging에서 기존 기능의 Chat 연결을 확인한다.** 첨부·웹 검색·
   Deep Research·생성 파일·profile·공유/삭제를 위험 순서로 좁혀, 소유권·중복
   과금·context 보존을 먼저 확인한다. 실 provider turn은 정확한 시나리오와
   예산을 제시한 뒤 별도 승인을 받고 실행한다.
3. **서버 재개 계약 후 durable recovery, 이어서 Refiner·Planner를 구현한다.**
   현재의 명시적 새 전송과 동일 attempt 재개를 구분하고 멱등성·부분 저장·정산
   경계를 먼저 정한다. Planner는 별도 안전·지연·비용 계약과 Claude 검토를
   거친다. 새 provider 평가도 동결된 row·호출·중단 규칙과 별도 비용 승인 후에만
   진행하며, 과거 60회 승인을 상속하지 않는다.

이 순서의 추천 자체는 신규 자동 착수·유료 실행·병합·배포 승인이 아니다.
