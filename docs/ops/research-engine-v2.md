# Deep Research engine v2 — 운영과 로컬 검증

상태: 구현·로컬 검증 완료, 기본 꺼짐. production 활성화, live 유료 실행, 새 지출 상한은
이 문서로 승인되지 않습니다(각각 별도 운영자 결정).

## 1. 무엇이 v1과 다른가

| 축 | Preview v1 (`engineVersion = 1`) | 확장 엔진 v2 (`engineVersion = 2`) |
|---|---|---|
| 실행 | run 하나가 lease를 잡고 최대 3 generation | work item(plan, investigate, search, read, analyze_private, coordinate, verify, write_section, synthesize) 단위 lease·epoch fencing, 짧은 slice |
| 계획 | 없음 | LLM structured plan, 확인 질문, 사용자 편집·승인, 진행 중 범위 변경(input revision) |
| 자료 | 공개 질문, 검색 snippet, 읽기 2개 | 사용자 URL·발견 링크·HTML/text/PDF/DOCX/XLSX/CSV 범위 읽기, 선택한 첨부·대화·Memory·Assistant knowledge(비공개) |
| 근거 | source ID 구조 검사 | source identity ↔ content version 분리, 비공개 저장소의 추출 텍스트, chunk 위치(페이지·섹션·행·메시지), claim → 정확한 span, 재게재 판별 |
| 검증 | 없음 | 인용 quote의 결정적 위치 확인 + 검증 모델(지지/일부/상충/미확인/근거 없음, 숫자·날짜·단위) |
| 보고서 | 단일 JSON, 출력 4,096 | 섹션별 작성·schema/인용 검사·repair·합성, 부분 보존, revision, Markdown/PDF/DOCX/CSV/XLSX |
| 비용 | run 하나 = 예약 하나 | dispatch 하나 = Chat 예약 하나, run 총액 불변식(`docs/policy/credit-and-cost-limits.md`) |

v1 행은 그대로입니다. v1 worker·recovery·만료 쿼리는 `engineVersion = 1`만 고르고, v2 행은
DB 제약(`ResearchPreviewRun_v2_shape_check`)상 run 단위 checkpoint·예약을 가질 수 없습니다.
진행 중 v1 run은 자기 decoder와 가격으로 끝납니다. `Conversation.productKey`는 바뀌지 않습니다.

## 2. 스위치(모두 기본 꺼짐)

| 변수 | 의미 |
|---|---|
| `RESEARCH_ENGINE_ENABLED` | v2 offer·API·worker 전체 |
| `RESEARCH_ENGINE_MODEL_IDS` | 쓸 수 있는 모델. `RESEARCH_ENGINE_MODEL_SHORTLIST`(`lib/researchEngineService.ts`: Preview P0의 Gemini 둘과 Gemini 4 Carbon, GPT 6.2 Sol, Claude Sonnet 5.5, Claude Opus 5.5. 모두 reasoning이 출력 토큰에 포함되고 강제 tool 호출이 확인됨) 안에서만 고를 수 있고 운영 변수로 새 모델을 더할 수 없음. 목록에 넣는 것은 코드 변경 |
| `RESEARCH_ENGINE_ROLE_MODELS` | 역할별 모델(`writer=…,researcher=…`), 위 목록 안에서만. run 시작 시 고정 |
| `RESEARCH_ENGINE_PRIVATE_SOURCES_ENABLED` | 첨부·대화·Memory·knowledge 선택 허용 |
| `RESEARCH_ENGINE_NATIVE_ENABLED` | Native bearer route와 capability |
| `RESEARCH_ENGINE_DEFAULT_ENTRY` | rollout: composer에서 v2를 기본 Research 진입으로 보이고 Perplexity 신규 선택 행을 숨김. 기존 Perplexity run·가격·조회는 그대로 |
| `RESEARCH_ENGINE_MAX_APPROVED_CREDITS` | 사용자가 한 run에 승인할 수 있는 총액 상한(기본 2,000) |
| `RESEARCH_ENGINE_MAX_RUNNING_ITEMS{,_PER_ACCOUNT,_PER_RUN,_PER_PROVIDER}` | 동시 실행 한도(기본 32/4/4/16) |
| `CHAT_TASK_AGENT_ENABLED` | 작업 맡기기(§9). 정확히 `true`이고 `RESEARCH_ENGINE_ENABLED`도 켜져 있을 때만. 끄면 새 작업 run과 작업 run의 유료 작업 시작(계획 요청·승인·재개·예산·마무리·범위·수정)이 `CHAT_TASK_AGENT_DISABLED`로 거절되고, 일시정지·취소·삭제는 그대로 됩니다 |

Chat의 Auto/manual 선택은 바꾸지 않습니다. Research 실행 모델은 run의 `executionProfile`에
고정되고, dispatch 직전 registry의 provider/API ID/reasoning/가격 version이 다르면 보내지
않습니다.

## 3. 비공개 자료 경계

- 선택은 서버에서 소유자·잠금(비밀번호 대화는 선택 시 unlock 필요)·삭제·Memory 설정을
  확인해 revision digest가 있는 manifest 항목이 됩니다. worker는 cookie나 bearer를 갖지
  않습니다.
- 비공개 텍스트를 읽는 모든 dispatch 직전에 다시 검증합니다. 삭제·재잠금·Memory 끄기 뒤에는
  모델에 보내지 않고 source를 `revoked`로 바꾸며 저장된 텍스트를 정리 큐에 넣습니다.
- 검증 모델은 보여 준 claim을 읽은 글로 고쳐 쓸 수 있으므로, 검증 호출 하나는 출처 한 묶음만 봅니다. 공개
  claim은 비공개 claim과 따로, 비공개 claim은 인용하는 비공개 자료 조합이 같은 것끼리 검증합니다. 비공개 자료를
  인용하지 않는 비공개 파생 claim은 하나씩 검증합니다. 그래서 자료 하나를 철회하면 그 내용이 닿았을 수 있는
  claim이 모두 정리 대상(그 자료를 인용한 claim)에 들어갑니다.
- 검색할 수 있는 역할(planner, researcher, coordinator)의 prompt는 `PublicResearchContext`
  타입으로 공개 brief와 공개 source 행에서만 만들어집니다. 이 역할에 가는 자유 텍스트는 공개 조사
  텍스트로 정한 것뿐입니다: `publicBrief`(따로 주지 않으면 질문·objective·constraints), 추가 질문,
  section_research·conditions revision의 instruction, 계획 재작성 의견. 공개용 brief를 따로 주면
  원래 질문·objective·constraints, 범위 변경 메모(priorityNote), 형식 수정 instruction은 검색
  역할에 가지 않습니다. 비공개 분석(analyst)·검증·작성
  역할에는 검색·fetch tool이 없습니다. 이 분리가 경계이며 prompt 경고는 보조입니다.
- 비공개 자료를 하나라도 고른 run의 보고서는(비공개 claim이 남지 않았어도) 공개 공유가
  거절되고, 모델 없이 만드는 공개용 redaction revision이 있을 때만 그 버전으로 공유됩니다.
- run이 끝난 뒤 원본을 지우거나 다시 잠그거나 Memory를 끄면, 근거 조회 시점과 maintenance
  sweep(`revalidatePrivateResearchSources`, 오래 확인 안 한 것부터)이 원본을 다시 확인해 복사본을
  `revoked`로 바꾸고 정리 큐에 넣습니다. 모델 호출이 없어도 적용됩니다. 범위에서 제외(excluded)한
  source도 대상이며, source 목록·보고서·export·계정 데이터 내보내기는 응답 전에 먼저 확인합니다.
  회수하면 원본에서 복사된 라벨(source 제목, manifest label, 모든 revision의 참고문헌 제목)을 일반
  라벨로 바꿉니다. 그 원본에서 나온 내용도 함께 거둡니다. 모델이 쓴 글은 읽은 claim을 다 인용한다고 믿을 수
  없으므로, 철회된 claim을 읽은 모델의 출력은 모두 버립니다: 원본을 인용한 claim 문장은 제외 안내문이 되고,
  그 claim을 읽은 섹션은 제외 안내문과 남은 claim 문장(한 문단에 하나)으로 다시 만들어집니다. 그 revision의
  합성 결과(제목, 요약, 충돌 항목, scope note, 한계, 다음 질문, 완료 조건)와 섹션 제목은 사용자 질문, 승인된
  계획의 섹션 제목(없으면 번호), 제외 안내문으로 바뀝니다. 저장된 비공개 분석 결과(인용문 포함)도 비웁니다.
  철회 전에 보낸 요청이 철회 뒤에 돌아와도, 결과를 저장하는 모든 commit(비공개 분석, 검증, 섹션, 최종 정리,
  보고서 저장)이 run 잠금 안에서 같은 정리를 다시 적용하므로 내용이 되살아나지 않습니다.
  인용문을 확인하지 못한 비공개 finding은 어느 자료에도 연결되지 않아 철회로 찾을 수 없으므로 claim으로 저장하지
  않습니다(인용할 수도 없는 claim입니다). 이 규칙 전에 저장된 그런 claim은 run의 비공개 자료가 하나라도 철회되면
  문장을 지웁니다. 채팅 답변은 정리된 현재 revision에서 다시 렌더링합니다.

## 4. 실행·회복

- worker: `npm run worker:research-preview -- --engine-concurrency=4`(v1과 같은 프로세스,
  각 엔진은 자기 스위치가 켜졌을 때만).
- maintenance(`lib/researchEngineRecovery.ts`)는 회복 전용입니다: 만료 lease(시작된
  dispatch는 unknown, 아니면 재대기), 묶이지 않은 segment, 정산, 증거 객체 정리, 멈춘 run
  진행. 새 유료 작업을 시작하지 않고, 행마다 격리하며 세 번 실패한 행은 격리
  (`recoveryQuarantinedAt`)해 다음 행을 막지 않습니다. v1의 해석 불가 정산 행도 같은 방식으로
  격리합니다.
- 실행 기한(표준 120분, deep 360분)은 조사 시간만 셉니다. 계획을 승인해 조사를 시작할 때, 그리고 보고서
  수정 요청으로 새 조사를 시작할 때 정해지고, 일시정지한 시간만큼 재개할 때 늘어납니다. 계획 검토 중에는
  흐르지 않습니다. 예산 소진 대기는 기한이 지나면 있는 근거로 끝냅니다.
- run을 만들면 계획 작업이 바로 예약됩니다("계획 만들기"와 "바로 시작" 모두 계획에서 시작). 계획 전에
  자료를 더할 client만 `requestPlan: false`로 모델 호출 없는 draft를 남깁니다.
- 호출별 출력 상한은 `RESEARCH_OUTPUT_TOKEN_CAPS`(`lib/researchEngineContract.ts`)에 있고 reasoning 토큰을 포함합니다.
  상한을 생각에 다 써서 tool 호출 없이 끝난 응답은 결과 불명이 아니라 실제 usage로 정산되는 invalid output
  (`RESEARCH_OUTPUT_TRUNCATED`)이며 재시도됩니다. 받아들이지 못한 dispatch마다 worker가 내용 없는 로그 한 줄
  (`research_dispatch_not_accepted`: 역할, 모델, 코드, 오류 이름, 중단 이유, 출력 토큰)을 남깁니다.
- pause는 진행 중 slice가 끝나는 경계에서, cancel은 새 dispatch를 막고 이미 보낸 요청은
  결과/비용 확인으로 남깁니다.

## 5. 데이터 수명

- run·대화·계정 삭제는 cascade로 행을 지우고, 비공개 증거 객체는 같은 문장의 DB trigger가
  `ResearchEvidenceObjectCleanup`에 넣어 maintenance가 지웁니다(삭제 실패는 최대 6시간 간격으로
  계속 재시도하며 포기하지 않습니다). 증거 객체는 쓰기 전에 키를 큐에 넣고(`write_pending`, 1시간
  유예) version 기록이 같은 트랜잭션에서 가져갑니다. 유예가 지난 키는 지운 뒤 `write_abandoned`로
  24시간 더 남겨 늦게 도착한 쓰기까지 한 번 더 지웁니다. funding segment는 사용자 내용이
  없는 금융 기록이라 지우지 않고 run 연결만 끊으며(`runId = NULL`), 만료 reconcile은 이런 segment의
  미정산 hold를 환불하지 않고 결과 불명으로 정산합니다. 직접 run 삭제는 미정산·unknown hold가 있으면
  거절합니다.
- 계정 export는 brief manifest(참조만), 계획, 보고서 revision과 claim, 승인 총액, source
  메타데이터를 포함하고 증거 본문·funding·lease·provider binding은 제외합니다.

## 6. 로컬 검증(로컬 PC, PowerShell 또는 Git Bash, 이 worktree)

production 자격증명은 필요 없고 쓰지 않습니다. 격리된 테스트 DB에만 씁니다.

```bash
node --conditions=react-server --import tsx --test tests/researchEngineEvidence.test.mjs tests/researchEngineReport.test.mjs tests/researchEngineClientState.test.mjs
```

DB suite(각각 별도 프로세스, `TEST_DATABASE_URL`이 로컬 `tomverse_test`):

```bash
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/integration/research-engine-run.db.test.ts
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/integration/research-engine-boundaries.db.test.ts
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/integration/research-engine-chat-finance.db.test.ts
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/integration/research-engine-scale.db.test.ts
node --conditions=react-server --experimental-test-module-mocks --import tsx --test --test-concurrency=1 tests/integration/research-engine-task.db.test.ts
```

작업 맡기기(§9)의 unit·화면 검사: `tests/researchEngineTask.test.ts`(react-server 조건), `tests/client/deepResearchTaskRender.test.tsx`.

scale suite는 synthetic 기능·부하 목표입니다(한 run에 generation 20회 이상, source 후보
500개 이상, 성공 read 100개 이상, 인용 40개 이상, 출력 4,096 tokens 초과 보고서, 20개 동시
run, run 안 독립 작업 4개 동시, fake clock 60분·worker 교체·pause/resume·예산 확장).
production 한도, 지연시간, 처리량 수치가 아닙니다.

## 7. 품질 평가

`scripts/research-engine-evaluate.ts`는 이미 저장된 run(v1 baseline과 v2)을 같은 brief
digest로 짝지어 구조·비용 지표를 쓰고, v2 run마다 claim과 인용 span을 담은 사람 검토용
CSV를 만듭니다. run을 새로 시작하거나 provider를 부르지 않습니다. 실제 모델로 비교 run을
만드는 live 평가는 별도 승인 대상이며, 이전 Preview US$10/두 pair 승인은 여기에 적용되지
않습니다.

## 8. 아직 확인하지 않은 것

- 실제 provider(Gemini)와 Brave로의 live 품질·비용·지연 — 미실행.
- 실기기 Native(iOS/Android) 동작 — fixture/브라우저 수준 검증만.
- Project workspace 자료 — develop에 Project 서비스가 없어 adapter 경계
  (`setResearchProjectSourceAdapter`)만 있고 기본은 사용 불가.
- 스캔 PDF OCR/vision — 유료 provider 권한이 없어 `no_text_layer`로 표시만 함.
- 작업 맡기기(§9)의 실제 모델 계획·결과 파일 품질 — fake 모델 DB 테스트만, live 미실행.

## 9. 작업 맡기기(delegated task, 기본 꺼짐 `CHAT_TASK_AGENT_ENABLED`)

새 실행 엔진이 아니라 이 엔진의 run 하나입니다. 차이는 brief의 `taskOutput`(`document` | `spreadsheet` |
`presentation`) 하나이고 manifest JSON에만 들어가므로 migration이 없습니다. 강도는 기존 standard/deep 프로필을
그대로 쓰고(새 한도 값 없음), 요금제·승인 총액 상한·동시 실행 한도도 Research와 같습니다.

- **맡기기**: composer 도구 메뉴의 Deep Research 시트에 "결과물: 보고서 / 문서 / 표 / 발표 자료"가 보입니다
  (offer의 `features.taskAgent`). 보고서는 지금의 Research 그대로이고, 나머지를 고르면 작업 run이 됩니다.
- **계획**: planner가 "해야 할 일의 단계"(plan schema의 `subquestions`)와 결과물 구성(`outline`)을 냅니다.
  같은 plan schema·편집·승인·`autoStart`를 씁니다. 표는 모든 섹션이 표로 작성되고, 발표 자료는 짧은 요점으로
  작성됩니다(writer 지시). 결과물 종류는 닫힌 enum이라 공개 context(`PublicResearchContext`)에 들어가도 됩니다.
- **도구**: 모델 호출은 `RESEARCH_MODEL_TOOL_NAMES`의 구조화 제출 7개(`submit_research_plan`, `_turn`,
  `_private_analysis`, `_coverage`, `_verification`, `_section`, `_synthesis`) 중 하나만, 호출마다 하나를 강제로
  받으며 `execute`는 입력을 받아 두기만 합니다. 목록 밖 이름은 `callResearchModel`이 예약 전에 거절합니다. 실행기의
  동작은 기존 공개 웹 검색(Brave)·공개 페이지 읽기·사용자가 고른 비공개 자료 읽기, 그리고 마지막의 파일 배치뿐입니다.
  이메일·MCP 쓰기·결제·게시·브라우저 조작 도구는 없고, 계획이나 읽은 페이지가 그렇게 하라고 해도 실행기에 그 동작이 없습니다.
- **결과물**: 보고서가 끝나면(`finalizeReport`) 같은 보고서 문서를 모델 호출 없이 기존 생성 파일 렌더러로
  docx·xlsx·pptx로 배치해(`lib/researchEngineTaskOutput.ts`) 답변 메시지의 `MessageArtifact`로 붙입니다
  (`lib/researchEngineTaskFiles.ts`). 카드·내려받기·버전은 일반 생성 파일과 같습니다. 보고서 revision마다 파일
  하나(ordinal = revision − 1)이고, 수정 요청의 파일은 앞 파일의 다음 버전입니다. 바이트를 먼저 쓰고 행은 finalize
  트랜잭션에서 씁니다. 행을 못 쓰면 바로 지우고, 그 사이 crash는 orphan sweep이 회수합니다.
  배치는 내용을 버리지 않습니다. 표가 시트보다 많으면 남는 표를 마지막 표 시트에 이름·머리행과 함께 이어 붙이고,
  슬라이드가 100장을 넘으면 더 촘촘히(슬라이드당 요점 20개, 그다음 구분 슬라이드 없이) 배치합니다. 슬라이드의 요점이
  잘려도 전문은 그 슬라이드의 발표자 노트에 있습니다. 그래도 한도를 넘으면 파일을 실패(`content_too_large`)로 남기고
  카드가 답변의 보고서나 보고서 탭 내보내기를 안내합니다.
- **비공개 자료 철회**: 철회(§3)하는 트랜잭션 안에서 그 run의 파일을 먼저 보류합니다(`source_revoked`: 실패 상태, 객체
  없음, 옛 객체는 같은 트랜잭션에서 삭제 큐 `MessageArtifactCleanup`의 `source_revoked`). finalize나 다른 commit의
  보류가 revision을 바꾸면 그 revision의 파일도 같은 트랜잭션에서 보류됩니다. 그 commit 뒤 정리된 revision에서 다시
  배치해 같은 행을 ready로 되돌립니다(run lock 아래 revision digest가 같고 아직 보류 중일 때만). 재생성이 저장에 실패하거나
  중간에 끊기면 행은 `source_revoked`로 남고, 다음 Research 읽기(`revalidateRunPrivateSources`)나 maintenance
  (`rebuildWithheldResearchFiles`)가 다시 만듭니다. 파일 바이트를 내주거나 복사하는 곳(다운로드, 생성 파일 수정 입력,
  프로젝트 저장)은 비공개 자료를 고른 run의 파일이면 먼저 그 run의 비공개 자료를 다시 확인하고, 철회가 발견되면 내주지
  않습니다. run 삭제는 답변 파일을 `message_deleted`로 삭제 큐에 넣습니다.
- **진행·멈추기·알림**: 진행 화면, 일시정지·재개·취소·지금 마무리·예산 늘리기는 Research 그대로입니다. workspace가
  열린 채 run이 끝나면 기존 답변 완료 브라우저 알림(설정에서 켠 경우, 탭이 숨겨졌을 때만)을 띄웁니다. 웹 푸시·이메일은 없습니다.
- **비용**: 결과 파일 단계는 모델을 부르지 않으므로 크레딧이 없습니다. 같은 fake 응답이면 작업 run과 Research run의
  정산 총액·모델 호출이 같다는 것을 DB 테스트가 확인합니다.
