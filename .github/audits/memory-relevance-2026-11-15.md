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
운영 모델과 단가를 조회·변경한 기록은 없으며 테스트 fixture는 운영 설정이 아니다.
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
기본 숨김이며 미확인 처리 국가·학습·보관 기간과 activation gate를 변경하지 않았다.

검토에 남은 한계: 이전 bundle 없는 새 준비는 질문 저장 전이라는 기존 호출 계약을
따른다. 이미 저장된 질문을 직접 새로 준비하는 별도 regenerate/edit 흐름에는 명시적인
source cutoff 입력을 추가하지 않았다. 이번 자동 재준비는 반드시 이전 bundle을 전달해
이 문제를 피하며, 기존 no-bundle 재시도에 contextual 지원을 추가했다고 주장하지 않는다.
또한 search-unit 과금에서 query 상한이 500에 가까우면 보수적인 예약량이 커져 기존
예산이 거절할 수 있다. 이는 `budget_refused`로 관측되며 예산을 자동으로 올리지 않는다.

전체 lint·production build와 브라우저 회귀는 구현 커밋 `8f6fee6ee`를 검증했다. 이후
허용 모델 엄격화와 숨김 고지 보완 뒤 focused unit 211개와 해당 파일 scoped lint를 다시
통과했다. 전용 test PostgreSQL은 검증 후 중지했다. 원래 checkout의 미커밋 변경을 보존했고,
운영 DB·CI는 건드리지 않았으며 로컬 test 로그·DB 파일은 Git 커밋에 넣지 않았다.

## 실제 의미 품질·운영 상태

평가 harness는 `current-query`, `full-query`, `full-query+history`를 구분하고 실제 사용한
query/history/model/corpus/candidate provenance를 연결한다. 신규 synthetic 10사례는
배선·정책 검증용이다. 오프라인 기존 retrieval-ko32 lexical Recall@5는 20/29로 변함없다.
mock/oracle 통과를 reranker나 최종 답변의 의미 품질 개선으로 해석하지 않는다.

실제 provider/답변 품질 평가, `--live`, live 활성화, 운영 설정 변경, PR, 병합, 배포는
실행하지 않았다. 남은 live 결정은 기존 고지의 미확인 사실 확인과 해당 payload/모델/가격/
예산 범위의 활성화·평가 승인이다. 이 문서는 그 승인을 대신하지 않는다.
