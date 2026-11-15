# Memory relevance 구현·검증 기록

작성일: 2026-11-15, Australia/Brisbane.

## 기준과 구현

- 분석 main: `b1e00bfa10886ab4022ab835d2801618c07a1b9f`.
- 구현 전 main/develop fetch 후 실제 develop base:
  `7f0d86bc6885edfcf2edf7515c4fa6bf5376b394`.
- 분리 브랜치: `codex/memory-relevance-to-develop`. 원래 checkout의 미커밋 작업은 보존했다.
- `MEMORY_RELEVANCE_CONTEXT_ENABLED`는 기본 꺼짐이다. 기존 semantic privacy gate,
  readiness, 운영자가 설정한 모델·단가·일/월 예산을 유지한다.
- Memory full query는 NFC 문자열을 한 번 확정하고 cache key·비용 예약·wire·평가에
  그대로 사용한다. Knowledge/embedding과 legacy bundle의 query 정책은 유지한다.
- 같은 대화의 owner/passwordVersion 검증 뒤 저장 user 본문 최대 2개만 보조 맥락으로
  사용한다. 실제 채택한 source ID/digest만 기존 bundle에 서명한다. 원문을 bundle,
  로그나 새 DB snapshot에 저장하지 않는다. user 본문에는 붙여넣은 외부 자료가 있을 수 있다.
- 전송은 envelope 선검증 후 같은 source subset과 cache만 재현한다. 정상 append는
  snapshot을 바꾸지 않고, 변경·삭제·권한 변화와 성공 cache 소실은 거절한다. 실패한
  contextual rerank는 current-only lexical plan으로 재현한다.
- Web 재준비는 이전 bundle을 전달한다. 유효 subset을 재사용하고, 만료·legacy·빈 anchor나
  변경된 source는 현재 접근을 확인한 current-only로 복구한다. 위조·다른 계정/대화/모델은
  이 복구에 섞지 않는다. 기존 retry/nonce·Auto 전후 검증을 유지한다.
- Native 다중모델 Review의 bundled transcript는 원래 저장한 질문까지 사용한다. Native
  단일 Chat/단일모델 Review의 no-bundle 경로는 contextual 지원 범위 밖이다.

## 모델·과금 지원과 한계

공식 v2 [입력 한도](https://docs.cohere.com/docs/reranking-best-practices),
[요청·응답 계약](https://docs.cohere.com/v2/reference/rerank),
[가격의 search-unit 정의](https://cohere.com/pricing),
[청구 token 설명](https://docs.cohere.com/docs/how-does-cohere-pricing-work),
[실제 모델 ID](https://docs.cohere.com/docs/models)를 확인했다.
모델 한도는 v3.5의 2,048, v4 fast/pro의 모델별 16,384 query tokens를 사용한다. v5는
공통 표의 2,048을 적용하며, shared 32,768 context를 query 한도로 간주하지 않는다.

| 경로 | 구현 상태 |
|---|---|
| 확인된 모델 + public search-unit | 400 bytes를 넘는 query 지원. query token 상한이 500 미만일 때만 공식 청크 비용을 계산한다. 500/501-byte 경계는 비유한 분모 대신 `search_unit_cost_unverifiable`로 무호출 fallback한다. |
| v5 fast/pro + 명시 token-price 설정 | 실제 query와 문서 및 query 반복분으로 보수적 예약, 응답 `input_tokens`로 기존 정산. 운영 설정/단가를 추가하지 않는다. |
| v3/v4 + token-price, 미확인 모델 | 구체적인 모델/과금 계약 사유로 provider dispatch 0. |
| 정확한 로컬 tokenizer 없음 | bytes가 token 한도 이하이면 보수적 증명으로 사용한다. 초과하면 실제 초과로 단정하거나 이력을 삭제하지 않고 `query_token_count_unavailable`로 fallback한다. 정확한 token 초과를 아는 경우에만 오래된 이력부터 줄인다. |

새 4KB/8KB 비용성 제한, 새 검색엔진·vector DB·재색인·selector LLM·추가 router/rerank는 없다.
구현 단계의 테스트 fixture는 운영 설정이 아니다. 후속 운영 readback과 별도 승인 평가의
모델·단가는 아래에 기록하며, 운영 설정은 변경하지 않았다.
모델 표 최종 대조 후 실제 API ID가 아닌 계열 표기 `rerank-v3.0`을 허용 목록에서 제거했다.
실제 v3.0 English/multilingual ID 지원은 이번에 추가하지 않았고 모두 명시적인 미확인
모델 fallback 대상이다. 이 엄격화와 고지 보완은 검토 후의 변경이며 검토 상태는 unknown으로
유지한다. 운영 전송 권한·모델·단가·예산을 추가하지 않았다.

## 로컬 검증

운영 DB를 사용하지 않고 loopback의 전용 PostgreSQL 17 test DB에서 실행했다. provider는
로컬 fetch stand-in이며 유료 호출은 없다.

| 검사 | 결과 |
|---|---|
| focused Memory/query/cache/cost/bundle/privacy/evaluation/client unit | 211 통과 |
| Memory DB lane | 288 + usage disclosure 7 통과 |
| 신규 snapshot/full-query 통합을 포함한 focused DB | 44 통과 |
| Native transport 회귀 | 76 통과, Native workspace typecheck 통과 |
| 최종 route | 149 통과 |
| 루트/Native typecheck | 통과 |
| 전체 lint | 통과 |
| production build | 통과: 컴파일·타입 검사·224개 정적 페이지 생성 |
| Memory context/mode Playwright | desktop Chromium, 18 통과 |
| 직접 Web Review Easy 전송 Playwright | desktop Chromium, 1 통과 |
| 모델 가격·accent token·enum constraint 검사 | 통과 |
| 완성 diff 독립 검토 | `r-20261115-095316-15f4a8`: Claude accept, Copilot `unknown/no_verdict_block`. 전체 unknown, 규칙대로 재제출하지 않음. |

검토의 고지 지적은 7개 언어의 `semanticSearchTransfer1`에서 Knowledge의 기존 절단과
Memory의 새 payload를 구분해 보완했다. provider 전송 후 응답 실패까지 무전송으로
단정하던 기존 문구도 수정했고, 해당 privacy 회귀 22개를 다시 통과했다. 고지는 여전히
기본 숨김이며 activation gate를 변경하지 않았다. 후속 계정 확인에서 학습 이용 Off를
확인했지만 처리 국가·계정별 보관 조건은 미확인이다.

검토에 남은 한계: 이전 bundle 없는 새 준비는 질문 저장 전이라는 기존 호출 계약을
따른다. 이미 저장된 질문을 직접 새로 준비하는 별도 regenerate/edit 흐름에는 명시적인
source cutoff 입력을 추가하지 않았다. 이번 자동 재준비는 반드시 이전 bundle을 전달해
이 문제를 피하며, 기존 no-bundle 재시도에 contextual 지원을 추가했다고 주장하지 않는다.
또한 search-unit 과금에서 query 상한이 500에 가까우면 보수적인 예약량이 커져 기존
예산이 거절할 수 있다. 이는 `budget_refused`로 관측되며 예산을 자동으로 올리지 않는다.

전체 lint·production build와 브라우저 회귀는 구현 커밋 `8f6fee6ee`를 검증했다. 이후
허용 모델 엄격화와 숨김 고지 보완 뒤 focused unit 211개와 해당 파일 scoped lint를 다시
통과했다. 전용 test PostgreSQL은 검증 후 중지했다. 원래 checkout의 미커밋 변경을 보존했고,
운영 DB는 건드리지 않았으며 로컬 test 로그·DB 파일은 Git 커밋에 넣지 않았다.

## 실제 의미 품질·운영 상태

평가 harness는 `current-query`, `full-query`, `full-query+history`를 구분하고 실제 사용한
query/history/model/corpus/candidate provenance를 연결한다. 신규 synthetic 10사례는
배선·정책 검증용이다. 오프라인 기존 retrieval-ko32 lexical Recall@5는 20/29로 변함없다.
mock/oracle 통과를 reranker나 최종 답변의 의미 품질 개선으로 해석하지 않는다.

### 승인된 실제 provider 평가

사용자는 계정 로그인과 **합성 10사례 × 3모드, 최대 30회·US$1** 평가를 승인했다.
운영 변수를 쓰지 않고 local harness에만 `rerank-v5.0-fast`, token billing,
US$0.02 / 1M input tokens를 지정했다. [Cohere 공개 가격](https://cohere.com/pricing)의
Advanced retrieval models 탭에서 확인한 가격이며, 협상된 계정 계약 단가나 확정 invoice가 아니다.

- 운영 readback: production에는 기존 credential만 있고 rerank 모델·두 단가 변수·일/월
  retrieval budget·새 relevance switch는 설정되어 있지 않았다. dev/staging에도 해당
  Cohere 설정이 없었다. 변수·예산·credential·운영 DB를 변경하지 않았다.
- 기존 key의 유효성과 로그인한 조직 일치를 read-only metadata로 확인했다. 조직 ID와
  credential은 이 기록이나 첨부 artifact에 포함하지 않는다. 계정 학습 이용은 **Off**다.
- 처리 국가·계정별 보관 기간/예외는 확인되지 않았다. 일반 [enterprise commitments](https://cohere.com/enterprise-data-commitments)를
  이 계정의 개별 계약으로 간주하지 않으며 `SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED`는 false다.
- 30회 입력 전체를 먼저 검증했고 공개 단가 기준 보수적 예약 합계는 US$0.000481이었다.
  로컬 실행 기록을 첫 요청 전에 독점 생성하고 각 요청 전/후에 저장했다. 전역 30회·US$1
  한도, 요청별 기존 비용 예약·청구 단위 확인, 실패 시 재시도 없음, trial 한도에 맞춘
  직렬 전송을 적용했다. 기존 제품 request body·응답 validation·selector를 사용했다.
- **30회 성공 / 실패·재시도 0**, 응답 `input_tokens` 합계 **4,470**. 계정 Usage의
  증가분도 정확히 4,470 tokens이며 `TRIAL`, subtotal US$0.00로 표시됐다. 확정 invoice는
  검증하지 않았다. 공개 가격의 토큰 비례 추정은 **US$0.0000894**, 요청별 micro-USD 올림
  합계는 US$0.000099다. 모두 승인 한도 이내다.

| 입력 방식 | Recall@5 (관련 gold 7개) | 무관 주입 / 전체 주입 | 청구 input tokens | 사례당 harness 평균 / p95 |
|---|---:|---:|---:|---:|
| lexical, provider 없음 | 6/7 (85.7%) | 9/15 (60.0%) | 0 | 측정 안 함 |
| 기존 400-byte current-query | 4/7 (57.1%) | 6/10 (60.0%) | 1,110 | 508 / 669 ms |
| full-query | 5/7 (71.4%) | 6/11 (54.5%) | 1,347 | 710 / 1,097 ms |
| full-query+history | 6/7 (85.7%) | 7/13 (53.8%) | 2,013 | 638 / 819 ms |

모든 선택은 relevance-gated tier이며 always-on tier 주입은 0이다. 각 요청의 후보는 같은
합성 기억 3개다. harness 시간은 provider 요청과 로컬 저장·비교를 포함하고 요청 사이의
6.5초 대기는 제외한다. 단일 직렬 실행이므로 운영 latency 비교 결론으로 일반화하지 않는다.

실제 개선과 남은 회귀:

- 긴 한국어 질문의 중간 조건은 기존 400-byte 입력에서 놓쳤으나 full-query부터 Atlas만
  선택했다. copied-user-material은 이력을 넣어야 관련 Atlas를 회수했다.
- 이력 추가는 lexical과 Recall@5가 같고, coffee 사례는 모든 rerank 모드에서 놓쳤다.
  특히 무관한 Atlas 이력을 넣으면 coffee 대신 Atlas가 주입됐다.
- 프로젝트 생략·전환·최신 정정·한영 혼용은 이력을 넣어도 반대 프로젝트가 함께 남았다.
  `candidate_absent`는 이력을 넣어 잘 기권했지만, `assistant_reference`는 오히려 두
  프로젝트를 주입했다. 이러한 실패를 해결했다고 주장하지 않는다.
- 작성자가 만든 10사례이고 독립 holdout이나 사람 승인 gold가 아니다. 후보 recall,
  assistant 해석, DB eligibility, 최종 답변 생성 품질은 평가하지 않았다. 제품 활성화의
  충분한 품질 근거는 아니다. 다음 권장은 **무관 이력이 현재 질문을 덮는 실패를 먼저
  개선하고, 별도 승인 범위에서 독립 사례로 재평가**하는 것이다. 추가 유료 호출은 하지 않았다.

[재현 가능한 점수·provenance와 측정 기록](artifacts/memory-relevance-2026-11-15/report.json)을
커밋했다. 세 점수 파일 모두 당시 구현에서 query/history/model/candidate/corpus identity 검증과
CLI 오프라인 replay를 통과했고 live 결과와 일치했다. replay의 provider 호출은 0이다.

과거 평가 재현 위치: 로컬 PC / PowerShell / **`bff86e393`의 별도 checkout** repository root.
후속 v4 선택 규칙에서는 이 v3 provenance를 묵시 재해석하지 않고 거절한다. production credential 불필요,
저장 artifact 읽기와 stdout 출력만 하며 아래 명령은 유료 전송을 하지 않는다.

```powershell
node --import tsx tools/memory-quality/cli.ts retrieval --semantic --corpus relevance --query-mode full-query+history --rerank-scores .github/audits/artifacts/memory-relevance-2026-11-15/scores-full-query+history.json
```

### PR·활성화·병합·배포 상태

develop 대상 [PR #3999](https://github.com/mposition/Tomverse/pull/3999)를 draft와 `ci:hold`로
생성했다. 이후 다른 세션/주체가 hold를 제거하고 ready로 바꾼 이벤트를 발견해 draft와
hold를 복구했다. 이 세션에서 CI를 시작·재실행하지 않았다. 복구 당시 아직 실행 중이던
PR Fast Gate 한 건만 중지했다. 일부 외부 시작 CI는 이미 완료된 상태였다.

기능은 기본 꺼짐이다. 운영 모델·단가·예산 설정, 제품 고지 gate 활성화, 병합·배포는
하지 않았다. 독립 검토 unknown도 그대로이며 재제출하지 않았다.

## 후속 수정: 이력이 현재 질문의 직접 일치를 전부 대체하는 실패

사용자의 후속 요청으로 관측된 `irrelevant_history` 실패를 우선 수정했다.
[Cohere Rerank 5의 한계](https://docs.cohere.com/docs/rerank)는 관련성 판단을 바꾸는
지시문을 지원하지 않는다고 명시한다. 새 classifier·scoring engine이나 두 번째 모델 호출을
추가하지 않고 기존 selector의 선택 결과와 `termHits`를 이용한 작은 결과 검사를 적용했다.

- 현재 질문만의 lexical 선택에 ordinary relevant memory가 있고, 실제 이력을 채택한
  rerank가 non-empty ordinary 선택을 만들면서 현재 질문과 일치하는 후보를 전부
  term overlap 0인 후보로 바꾸면 **기존 lexical 결과 전체로 복귀**한다.
  `semanticFallbackReason`은 `history_displaced_current_query`다. 점수를 혼합하지 않는다.
- 선택 전후 모두 기존 core/pinned/style, 만료·중복·source cap·token budget을 적용한다.
  core/style의 term 일치가 ordinary memory의 대체를 가리지 않는다. 기권(빈 ordinary 선택),
  lexical 직접 일치가 없는 참조, 이력 없는 current-only와 legacy는 이 검사를 적용하지 않는다.
- 거절한 결과는 semantic 사용으로 표시하지 않고 extra·history anchor·contextual effective
  plan을 버린다. 기존 current-only lexical fingerprint를 서명하므로 현재 질문 저장·전송과
  사용되지 않은 이력의 수정 후에도 추가 provider 호출 없이 재현한다. 이미 발생한 기존
  호출의 비용·cache 기록은 유지하며 예약·청구·정산 코드는 변경하지 않았다.
- `memory-query-v4`로 기존 full-query bundle/평가 provenance의 묵시 재해석을 막는다.
  provider query 문자열과 후보·cache·wire·비용 계약은 바꾸지 않았다. 평가 harness도 같은
  검사와 실제 historyCount를 사용하며 거절 사례를 coverage에 별도 표시한다.

[저장 점수 재처리 기록](artifacts/memory-relevance-2026-11-15/history-displacement-replay.json)은
기존 provider 응답의 10사례 query/history/candidate identity를 모두 대조했다. 새 provider
전송·지출은 **0**이다. 이는 새 모델 실행이나 독립 holdout의 품질 측정이 아니다.

| 같은 저장 응답의 선택 | 관련 기억 회수 | 무관 주입 / 전체 주입 |
|---|---:|---:|
| 수정 전 | 6/7 | 7/13 |
| 수정 후 | 7/7 | 6/13 |

변경된 사례는 `irrelevant_history` 하나이며 Atlas 대신 coffee를 선택한다. 기존 기권과
copied-user-material의 Atlas 회수는 유지했다. 프로젝트 혼입·assistant 참조·일부 후보만
대체하는 실패와 lexical 직접 일치가 없는 경우의 잘못된 의미 판단까지 해결하지 않는다.
보수적인 복귀가 유효한 zero-overlap 의미 매치를 배제할 수도 있으므로 다음 품질 검증은
이 tradeoff를 포함한 별도 독립 사례 평가가 우선이다. 추가 유료 평가 승인을 사용하지 않았다.

후속 로컬 검증:

| 검사 | 결과 |
|---|---|
| focused selector/query/input/cost/quality unit | 207 통과 |
| 추가 harness·bundle·send 회귀 (위 unit과 일부 중복) | 80 통과 |
| source snapshot·retrieval server contract | 11 통과 |
| 전용 PostgreSQL 17 DB | 기존 bundle/semantic 회귀 44 + 신규 재현 1 통과 |
| quality 도구 자체 typecheck | 통과 |
| 변경 서버·평가 코드·DB 테스트의 root 옵션 typecheck (기존 ambient 타입 포함) | 통과 |
| 변경 파일 scoped lint | 통과 |
| 후속 통합 head 전체 root typecheck | 미완료: 로컬 메모리 압박. 파일 로딩 진단에서 heap allocation failure가 발생해 전체 실행을 중지했다. Next route typegen은 통과했다. |

신규 DB 회귀는 실제 cache·서명·source 조회를 사용하고 provider만 로컬 stand-in으로
대체한다. 커피 선택, lexical fingerprint 일치, 거절한 history anchor 부재, 현재 질문
저장·사용되지 않은 source 변경 후 전송 검증, 준비·동일 snapshot 반복 조회·전송에서 provider 호출이
1회인 것을 확인했다. 전용 DB는 loopback `tomverse_memory_precedence_test`이고 운영 DB를
사용하지 않았다. 실행 후 전용 PostgreSQL을 정상 중지했다.

작업 중 원격에 추가된 CI admission의 develop 동기화 머지 `d9bc5b2cf`를 보존해 수정 커밋을
통합했다. Memory 구현·테스트 파일은 동기화로 달라지지 않았다. 원격에서 draft·`ci:hold`가
다시 해제된 것을 확인해 복구했다. 당시 시작된 CI 3건은 중지를 요청하는 사이 이미
완료되어 중지 대상이 남지 않았다. 이 세션에서 CI를 시작·재실행하지 않았다.

운영 스위치·예산·고지 gate, 독립 검토 unknown, draft·`ci:hold`, 병합·배포 상태는 유지한다.
