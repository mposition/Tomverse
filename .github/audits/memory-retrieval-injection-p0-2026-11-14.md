# Account Memory 검색·주입 P0 로컬 검증

기준: `origin/main 0155ee7099ce389315403c7709cfaa708ce1ab31`.
2026-11-14에 main을 다시 fetch했으며 후속 커밋은 없었다. 별도 구현 worktree에서
작업했다. 기존 작업 폴더와 분석 checkout은 수정하지 않았다.

## 구현

- MI-01~03: 저장 tokenizer/index version 1과 기본 64 terms를 보존했다.
  `memory-query-v2`만 긴 질문의 앞32·뒤32 unique terms와 앞·뒤 400 UTF-8 bytes를
  선택한다. 짧은 질문은 NFC 이후 기존 입력을 유지한다. DB/scorer가 같은 plan을
  사용하며 prepare/preflight/send 공통 builder의 hash가 plan/version을 결속한다.
  lexical/semantic selection version은 4/5, Memory cache domain은 별도로 갱신했다.
  knowledge query/index/cache는 기존 동작을 유지한다. reindex/migration은 없다.
- MI-04~06: lexical max400을 유지하고 rerank max100에서 최근 extra에 최대50개를
  배정한다. 한쪽 pool이 작으면 남는 자리를 다른 쪽이 사용한다. extra는 lexical
  반환 ID 밖의 eligible row이며 같은 단어를 포함할 수 있다. core/pin/style은
  외부전송 대상에서 제외한다. 미채점 lexical은 기존 lexical 평가를 유지하고,
  미채점 extra는 선택에서 제외한다. 실패/off는 같은 새 query의 lexical baseline이다.
- MI-07~10: `mem-context-v2`의 앱 `rules`와 fenced `data`를 분리했다. Memory 본문은
  user-role prelude에 한 번만 들어간다. profile instructions/knowledge의 기존 역할,
  continuation와 native history/현재 요청 순서, Deep Research Memory 지원을 보존한다.
  rules/data 비용을 각각 합산하고 둘과 query plan을 priced hash/bundle에 결속한다.
- MI-11~12: 저장 inherit/on/off와 계정 master 허용/차단/미확인 상태를 따로 표시한다.
  응답 실패/잘못된 응답/계정 전환/늦은 응답/로그아웃은 활성 상태로 표시하지 않는다.
  복귀·메뉴 열기에 재조회하며 mode/master를 자동 저장하지 않는다. pinned profile의
  알려진 memory 제한도 표시한다. 답변별 기억 개수 배지는 추가하지 않았다.
- MI-13~16: 기존 harness에 top5/fullSelectedSet 지표와 score provenance/coverage를
  추가했다. corpus/query/candidate/model/settings 불일치를 거절하고 누락된 점수는
  lexical fallback으로 보고한다. mock/oracle/provider/unverified를 구분한다.
  16개 입력 fixture의 실제 답변 평가는 `not_run`이다.
- MI-17~18: source 잠금/삭제와 manual·다른 evidence의 기존 keep/suspend 의미,
  직접 작성 sensitive 기억의 허용, 승인 pair·expiry·소유권을 보존했다. extraction v10,
  승인 register, memoryDuplicates, privacy/live flags, 비용 한도·hold·정산은 바꾸지
  않았다. send는 signed semanticSteps의 cached_only 재현을 유지한다.

## 28개 작은 사례의 검증 위치

앞 8개는 각각 한국어/영어 2개이며 합계16개다. 실제 모델 답변의 정답 판정은 하지 않았다.

| 사례 | 검증/관측 |
| --- | --- |
| 짧은 query | `memoryQueryPlan`, `memoryQualityProductRetrieval`의 기존 index/선택 일치 |
| 긴 질문 말미 | query unit + 실제 PostgreSQL 조회에서 말미 target 회수 |
| 긴 질문 중간 | bounded head/tail에서 누락될 수 있음을 관측; 개선 pass로 세지 않음 |
| 현재 요청의 수정 | 입력/현재 요청 우선 rules 및 최종 payload 순서; 의미 답변 미실행 |
| 부정·distractor | 고정 gold/답변 기준을 준비; 의미 답변 미실행 |
| 두 프로젝트 | 고정 gold/대상 분리 기준과 native/current 순서; 의미 답변 미실행 |
| memory 내부 명령 | synthetic invalid statement의 user-role 경계·무해화; 공격 성공률 미측정 |
| 관련 기억 없음 | relevance-gated 선택 없음, 빈 fence/user message 없음 |

나머지 12개 결정적 경계는 아래와 같다. 부가 세부 fixture로 경계를 나누어 검증했다.

| 경계 | 검증 |
| --- | --- |
| DB400 core/pin 포화 | 실제 DB에서 cap과 cap 밖 recall 손실을 관측 |
| DB400 약한 고importance 포화 | 실제 DB의 cap 밖 target 손실 관측; cap을 늘리지 않음 |
| 24 items/900 tokens | DB 후보→실제 selector 예산 검증 |
| style 200/6 | DB 후보와 pure selector의 nested budget |
| source당3 | 기존 retrieval/scoring DB/unit 회귀 |
| duplicate/conflict | 기존 scoring 및 persistence/extraction DB 회귀 |
| superseded/deleted | 실제 owner/status 조회 회귀 |
| expired/revoked | expiry/revocation/retrieval DB 회귀 |
| source lock/delete | multi-evidence/manual keep, user-edited suspend, source-lock DB 회귀 |
| master/conversation/profile off | semantic 호출0, 저장 설정 보존, 실제 browser 표시 |
| preflight 뒤 상태 변경 | 공통 builder→서명 bundle→변경 뒤 stale 검증 |
| provider별 최종 role/token | 실제 SDK OpenAI/Anthropic/Google HTTP body 및 Research submit body 로컬 캡처; rules/data 가격·내용/query/version hash 검증 |

lexical100+extra, ID 중복만 제외, invalid response/budget/cache failure,
미채점 extra 차단과 미채점 lexical 유지는 별도 unit/DB fixture로 검증했다.
provider payload 테스트는 실제 route 전체의 HTTP 통합이 아니라 production builder와
SDK serialization seam을 통과한다. provider 응답·답변 의미는 평가하지 않는다.

## 실제 실행 환경과 결과

로컬 PC / PowerShell / 새 구현 worktree 루트. production 자격증명을 사용하지 않았다.
Node22.22.2/npm10.9.7, checkout lockfile의 `npm ci --ignore-scripts --no-audit --no-fund`
932 packages와 `prisma generate`를 실행했다. `node_modules`는 이 checkout의 실제
디렉터리이며 junction이 아니다. Next16.4.5의 설치된 local guide를 읽었다.
officeparser의 더 높은 Node patch 권고 경고가 있었으며 설치는 성공했다.

- 관련 unit: 1,482/1,482 통과. 이후 saved-score 검증 변경의 관련 32개/23개 재실행 통과.
- PostgreSQL17: 전용 localhost synthetic cluster에 checkout migration174개 적용·drift검사
  통과. 첫 memory lane은287/288이며 신규 fixture의 lexical confidence 기대 오류 하나를
  고쳤다. 제품 mixed scoring은 바꾸지 않았다. 수정된 retrieval/semantic52/52 통과,
  source-lock28/28, disclosure7/7, profile23/23 통과. 고유346개 각각의 통과를 확인했지만
  전체 lane을 마지막에 다시 실행했다고 표현하지 않는다. 전용 DB는 종료하고 보존했다.
- 변경 파일 ESLint와 `git diff --check` 통과.
- 전체 `npm run typecheck` 통과(Node heap8GB). 첫 기본4GB 실행은 heap 부족으로
  실패했고, 다음 검사에서 shell의 nullable settings 전달을 보완한 뒤 최종 통과했다.
- `chat-memory-mode`, `memory-settings-hook`, `chat-memory-context`: desktop/mobile
  Chromium **42/42 통과**. 별도3146 dev 서버와 기존 외부 네트워크 차단 harness를
  사용했다. 최초 cold compile 탐색 제한과 중간 수정 중 dev stream 오류를 최종
  재실행으로 해소했다. 메뉴 link/profile 전달 및 mobile 테스트의 Escape dismissal
  경로를 고친 뒤 통과했으며, screenshot baseline이나 production build 증거는 아니다.

## 검색 수치와 해석

`retrieval --corpus all`은 provider/모델 호출 없이 기존 제품 selector를 실행했다.
retrieval-ko32개에서 한국어 Recall@5와 전체 recall은 모두20/29=68.97%로 기존과 같다.
top5 gated 무관 포함은5/24=20.83%, 전체는6/25=24.00%다. 전체 forbidden2/inactive0의
forbidden은 validator/DB eligibility를 생략한 synthetic invalid row의 평가 gold다.
실제품 저장 성공이나 유출로 해석하지 않는다. core/style을 무관 factual 근거로 세어
전체 오주입률이라고 주장하지 않는다. development/validation은 kind가 defaulted다.

실제 Cohere saved-score 실측, 실제 Chat 답변 의미 평가, live 활성화는 미실행이다.
P1-A의 승인된 실측/활성화, P1-B의 동일 서버 이력 snapshot 기반 후속 참조 해소와
native 대화별 설정 parity가 남는다. query-planner LLM이나 수동 동의어 사전은 없다.

이 결과는 로컬 구현·검증이다. PR/push/CI 시작·재개·재실행, merge/deploy는 하지 않는다.
