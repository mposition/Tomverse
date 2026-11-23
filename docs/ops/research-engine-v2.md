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
| `RESEARCH_ENGINE_MODEL_IDS` | 쓸 수 있는 모델. `RESEARCH_PREVIEW_P0_MODEL_SHORTLIST`(usage 계약이 검증된 Google 조합) 안에서만 고를 수 있고 새 모델을 더할 수 없음 |
| `RESEARCH_ENGINE_ROLE_MODELS` | 역할별 모델(`writer=…,researcher=…`), 위 목록 안에서만. run 시작 시 고정 |
| `RESEARCH_ENGINE_PRIVATE_SOURCES_ENABLED` | 첨부·대화·Memory·knowledge 선택 허용 |
| `RESEARCH_ENGINE_NATIVE_ENABLED` | Native bearer route와 capability |
| `RESEARCH_ENGINE_DEFAULT_ENTRY` | rollout: composer에서 v2를 기본 Research 진입으로 보이고 Perplexity 신규 선택 행을 숨김. 기존 Perplexity run·가격·조회는 그대로 |
| `RESEARCH_ENGINE_MAX_APPROVED_CREDITS` | 사용자가 한 run에 승인할 수 있는 총액 상한(기본 2,000) |
| `RESEARCH_ENGINE_MAX_RUNNING_ITEMS{,_PER_ACCOUNT,_PER_RUN,_PER_PROVIDER}` | 동시 실행 한도(기본 32/4/4/16) |

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
```

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
