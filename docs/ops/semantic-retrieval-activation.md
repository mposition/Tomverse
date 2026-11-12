# 의미 검색(Cohere) 활성화 runbook

- 작성: 2026-11-12 (Claude). 결정: 운영자, 2026-11-12 (시나리오 1~5 구현, 기본 꺼짐).
- 계약: `docs/policy/external-conversation-import-and-memory.md §9a`.
- 비용 버킷: `docs/policy/credit-and-cost-limits.md`의 "버킷 구분".
- 이 문서는 스위치를 켜기까지 무엇을 어떤 순서로 하는지만 적습니다.
- **스위치를 켜는 것은 운영자 승인입니다.** 켜는 순간 유료 호출이 시작되고 계정 memory·knowledge 원문이 Cohere로
  나갑니다. 이 문서의 어느 단계도 그 승인을 대신하지 않습니다.

## 1. 켜기 전에 끝나 있어야 하는 것

| # | 할 일 | 누가 | 어디서 | 끝났다는 증거 |
|---|---|---|---|---|
| 1 | Cohere 계정에서 학습 사용 거부(opt-out) 설정 | 운영자 | Cohere 대시보드 › Settings | 설정 화면 캡처 또는 날짜 기록 |
| 2 | 보관 기간 결정: 기본 30일 보관 그대로 쓸지, zero data retention을 요청할지 | 운영자 | support@cohere.com (ZDR은 enterprise 대상) | 회신 메일 |
| 3 | 처리 국가 확인과 DPA 요청 | 운영자 | privacy@cohere.com, Cohere Trust Center | DPA 사본 |
| 4 | 1~3의 사실로 개인정보 고지의 `[운영자 확인 필요]` 세 곳을 채우고, 그 `/privacy` 버전을 승인 | 운영자 | 개인정보 고지 PR(`claude/cohere-privacy-notice`) | `SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED = true`가 main에 배포됨 |
| 5 | 모델과 단가 확인 (2절) | 운영자 | Cohere 대시보드 › Billing | 2절 표에 실제 값 기록 |
| 6 | 예산 결정 (3절) | 운영자 | 이 문서 | 일·월 값 |
| 7 | 환경 변수 입력과 재배포 (4절) | 운영자 | Railway 웹 대시보드 | Admin › Feature flags에서 "설정됨" 표시 |
| 8 | 품질 비교 (6절) | 운영자(유료 측정) 또는 Claude(저장된 점수 재현) | 로컬 PC | 비교 결과 기록 |

4번이 끝나기 전에는 환경 변수를 모두 넣어도 **아무 호출도 나가지 않습니다.** 코드가 고지 게시 여부를 먼저 보고
(`semanticRetrievalNoticePublished`), Admin도 모든 스위치를 "준비 안 됨"으로 표시해 켜는 요청을 거절합니다.

## 2. 모델과 단가

Cohere 가격표가 공개 페이지에 단가를 보여 주지 않아(2026-11-12 확인) 코드에 상수로 넣지 않았습니다. **운영자가
대시보드에서 계약 단가를 확인해 넣습니다.** 아래 "참고 값"은 제3자 집계 사이트에 나온 값이며 확인 전에는 쓰지 않습니다.

| 용도 | 권장 모델 | 이유 | 과금 단위 | 참고 값(미확인) |
|---|---|---|---|---|
| rerank | `rerank-v3.5` 또는 `rerank-v4.0-pro` | 다국어(한국어 포함), 검색 단위 과금이 확인된 세대 | search unit(질문 1개 + 문서 100개까지) | v3.5 US$2.00 / 1,000 searches, v4.0 Pro US$2.50 / 1,000 |
| rerank(대안) | `rerank-v5.0-fast` | 최신 세대 | **토큰 과금으로 바뀌었다는 보도 있음, 미확인** | Fast US$0.02 / 1M tokens |
| embed | `embed-v4.0` | 다국어, 이미지 입력, 128k context | 토큰 | US$0.12 / 1M text tokens |

과금 단위는 **둘 중 하나만** 넣습니다. 둘 다 넣으면 설정 오류로 rerank가 꺼집니다.

- search unit 과금: `COHERE_RERANK_MICROUSD_PER_SEARCH_UNIT` — US$2.00 / 1,000 searches면 `2000`
- 토큰 과금: `COHERE_RERANK_MICROUSD_PER_MILLION_TOKENS` — US$0.02 / 1M tokens면 `20000`

응답이 설정과 다른 단위로 청구를 보고하면 예약을 정산하지 않고 그대로 두며
`semantic_retrieval_billing_unit_missing` 로그를 남깁니다. 이 로그가 보이면 설정한 과금 단위가 모델과 맞지 않는
것입니다(5절).

**단위는 micro-USD입니다.** US$0.12 / 1M tokens는 `120000`, US$1.00은 `1000000`입니다.

## 3. 예산

전용 버킷 `retrieval-provider:cohere`에 일·월 두 window가 있고, 둘 다 있어야 호출합니다. 사용자 크레딧과 무관한
운영 비용이며 어느 환경에도 기본값이 없습니다.

한 턴의 최악 예약(참고 단가 기준, 실제 청구는 대개 이보다 작습니다):

| 호출 | 최악 예약 | 근거 |
|---|---|---|
| 지식 rerank, 후보 60개·각 1,024 token | search unit 2~7개 → US$0.004~0.014 | 짧은 질문 2단위, 400바이트 질문 7단위 |
| 메모리 rerank, statement 100개 | search unit 1개 → US$0.002 | 짧은 문장 |
| 질문 embedding | 수백 token → US$0.0001 미만 | |
| 지식 파일 색인, 조각 50개 | 약 15만 byte 상한 → US$0.02 미만 | 업로드 1회 |

**제안(운영자 결정):** 일 `2000000`(US$2), 월 `20000000`(US$20). 하루 지식 rerank 턴 수백 개를 덮고, 예상 밖의
반복 호출이 생겨도 하루 US$2에서 멈춥니다. 예산이 차면 그날은 어휘 검색으로 동작할 뿐 오류는 나지 않습니다.

## 4. 환경 변수 입력

**실행 위치:** Railway 웹 대시보드(브라우저). production 자격증명(Railway 로그인)이 필요한 **쓰기** 작업입니다.
**`COHERE_API_KEY`는 대화창에 붙이지 말고 대시보드에 직접 입력합니다.**

1. Railway에서 Tomverse 프로젝트를 열고 환경을 고릅니다. **dev에서 먼저** 확인하고 production은 그다음입니다.
2. **Tomverse** 웹 서비스 → Variables. 유지보수 sweep(색인 backlog, 캐시 정리)도 같은 서비스의 내부 route
   (`/api/internal/maintenance/cleanup`)에서 돌므로 다른 서비스에는 넣지 않습니다.
3. Raw Editor에 아래를 넣습니다(값은 2·3절에서 정한 것).

```
COHERE_API_KEY=<대시보드에 직접 입력>
COHERE_RERANK_MODEL=rerank-v3.5
COHERE_RERANK_MICROUSD_PER_SEARCH_UNIT=<확인한 값>
COHERE_EMBED_MODEL=embed-v4.0
COHERE_EMBED_DIMENSION=1024
COHERE_EMBED_MICROUSD_PER_MILLION_TEXT_TOKENS=<확인한 값>
COHERE_EMBED_MICROUSD_PER_MILLION_IMAGE_TOKENS=<확인한 값, 스캔 PDF 색인을 쓸 때만>
RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_DAY=2000000
RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_MONTH=20000000
```

4. 저장한 뒤 **Deploy**합니다. Railway 변수는 그 뒤에 시작한 배포에만 반영됩니다.
5. Admin › Feature flags(`/admin/platform?tab=features`)의 "의미 검색 (Cohere)" 패널에서 API 키·제공자 예산·개인정보
   고지가 모두 "설정됨/게시됨"이고, "설정은 했지만 쓸 수 없는 값"이 비어 있는지 확인합니다.

`COHERE_EMBED_DIMENSION`은 생략하면 모델 기본 차원(embed-v4.0은 1536)입니다. 1024면 vector 하나가 1KB입니다.
나중에 바꾸면 기존 vector는 비교되지 않고 다시 색인됩니다(색인 비용이 다시 듭니다).

## 5. 스위치를 켜는 순서

Admin › Feature flags에서 하나씩 켜고, 각 단계마다 하루 정도 로그와 버킷을 봅니다.

1. `knowledgeRerank` — 보내는 것이 가장 적습니다(질문과 후보 조각, 저장 없음).
2. `memoryRerank`
3. `knowledgeEmbed` — 켜면 기존 지식 파일의 색인이 유지보수 sweep마다 조각 192개씩 진행됩니다. 업로드한 파일은
   처리 직후 960개까지 바로 색인합니다.
4. `memoryDuplicates` — 다음 추출부터 적용됩니다. core·고정·style memory는 보내지 않습니다.
5. `knowledgeImagePages` — 새로 올리는 PDF부터 적용됩니다. 이미 실패(`NO_TEXT`)로 처리된 스캔 PDF는 다시 올려야 합니다.

**끄기:** 같은 화면에서 끄면 다음 요청부터 어휘 검색입니다. 환경과 상관없이 끄는 것은 항상 허용됩니다. 이미 저장된
vector는 남아 있지만 스위치가 꺼져 있으면 읽지도 보내지도 않습니다.

## 6. 품질 비교

`tools/memory-quality/README.md`의 의미 검색 비교 절을 따릅니다. 저장된 점수로 재현하는 측정은 비용이 없고,
`--live` 측정은 유료라서 `--max-calls`를 명시해야 돌고 결과를 `--save-scores`로 저장해 다시 쓸 수 있습니다.
2026-11-12 어휘 검색 기준선은 PR #3791 본문에 있습니다.

임계값(`KNOWLEDGE_SEMANTIC_DEFAULTS`, `MEMORY_SEMANTIC_DEFAULTS`, `MEMORY_DUPLICATE_SIMILARITY`)은 측정 전의
초기값입니다. 바꾸면 해당 retrieval algorithm version을 올립니다.

## 7. 관측

모든 로그는 `console.info(JSON.stringify(...))` 한 줄이고 질문·문서 원문은 들어 있지 않습니다.

| event | 의미 | 볼 때 |
|---|---|---|
| `semantic_retrieval` | 호출 1건. `feature`, `api`, `outcome`(`ranked`·`embedded`·`cached`·`budget_refused`·`timeout` 등), `searchUnits`/`inputTokens`, `latencyMs` | 늘 |
| `semantic_retrieval_billing_unit_missing` | 설정한 과금 단위로 청구가 보고되지 않음. 예약을 그대로 둠 | 한 번이라도 나오면 2절 단위 재확인 |
| `semantic_retrieval_billed_above_reservation` | 청구가 예약보다 큼. 상한 계산이 틀렸다는 뜻 | 나오면 즉시 스위치를 끄고 보고 |
| `semantic_retrieval_settle_failed` | 정산 쓰기 실패. 예약이 과다 계산된 쪽으로 남음 | 반복되면 DB 확인 |
| `assistant_knowledge_embedding_failed`, `memory_duplicate_context_failed` | 색인·중복 준비 실패. 기능은 어휘 검색으로 계속 | 반복되면 확인 |

사용량(운영 DB, 읽기 전용):

```sql
SELECT "period", "periodStart", "count" AS micro_usd
FROM "ChatUsageBucket"
WHERE "key" = 'retrieval-provider:cohere'
ORDER BY "periodStart" DESC, "period";
```
