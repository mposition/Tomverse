# 독립 검토 요청 — 공급자 문서 기반 가격·능력 증거 (2단계)

## 배경

1단계(#1392/#1393)는 모델 API가 이미 주는 값으로 채택 폼을 채웠습니다. 가격은 두
공급자 모두 모델 API에 없고, OpenAI는 `/v1/models`가 `{id, owned_by}`뿐이라 GPT-6
Astra 폼은 거의 비어 있었습니다. 운영자가 승인한 2단계: 스캔 크론 뒤 공식 문서를
서버에서 읽고, 출처와 함께 저장하고, fail-closed로 — 단일 요율이면 가격을 채우고,
장문 tier면 채우지 않고 `lib/modelPricing.ts` profile 제안을 만든다.

정책 제약(docs/policy/credit-and-cost-limits.md §3): `lib/modelPricing.ts`가 유일한 가격
출처이고, DB 가격 컬럼은 **관리자 override**라 tier를 평탄하게 만듭니다. 이번 변경은
가격 출처를 만들지 않습니다 — 폼의 증거·제안일 뿐입니다.

## 조사로 확인한 것 (2026-09-13 원문)

- `https://developers.openai.com/api/docs/models/<id>.md` — 컨텍스트, 최대 입력·출력,
  입력 modality, 텍스트 토큰 가격표, 장문 규칙 문장, 프로모션 문구. 없는 모델은 404.
- `https://developers.openai.com/api/docs/pricing.md` — Standard/Batch/Flex/Fast 표.
  장문 없는 모델은 장문 칸이 `-`.
- `https://platform.claude.com/docs/en/about-claude/pricing.md` — `## Model pricing` 표
  (각주 번호가 셀에 붙음: `$0.25 / MTok1`), 아래쪽 Batch 표에 같은 모델명이 반값으로
  다시 나옴, "Claude 4.6 and later models ... at standard pricing" 문장.
- GPT-6 Astra: $10/$50, 272K 초과 시 입력·캐시 2배·출력 1.5배 → **tiered**.
- GPT-5.6 Sol: 문서 $4/$20은 **프로모션**, 코드 profile은 정가 $5/$30 유지.
- Claude Fable 5.1: $10/$50, 캐시 적중 $0.25(0.025배) → **flat**.

실제 문서를 `tests/fixtures/providerModelDocs/`에 원문 그대로 저장해 테스트합니다.

## 변경

| 파일 | 역할 |
|---|---|
| `lib/providerModelDocsCore.ts` | 순수 파서, `docPricePrefill`, `buildPricingProfileProposal`, `docParseFromStored`, 리포트 줄 |
| `lib/providerModelDocEvidence.ts` | 서버 수집기(허용 호스트, redirect 금지, timeout, 크기 제한, sha256) |
| `prisma/schema.prisma`, `migrations/20260913090000_provider_model_doc_evidence` | 새 테이블 + status CHECK |
| `scripts/check-enum-constraints.mjs` | CHECK 등록 |
| `app/api/internal/provider-model-catalog/check/route.ts` | 스캔 뒤 수집, degradable |
| `lib/providerModelCatalogReport.ts` | 요약 `· docs parsed N/M`, 실패 줄 |
| `lib/modelAdoptionDraft.ts` | 증거 소비: API 우선·문서 보충, 가격 prefill 판정, profile 제안 |
| `app/api/admin/model-lifecycle/adoption-draft/route.ts` | 증거 행 읽기(fetch 안 함) |
| `components/admin/AdminModelRegistryPanel.tsx` | id 따라가기를 cap에서 가격 3필드까지 일반화, profile 제안 표시·복사 |
| `scripts/run-provider-model-doc-evidence.mjs` | 리포트 없이 수동 실행 |

## 설계 판단 — 특히 검토해 주세요

1. **가격 prefill 조건**(`docPricePrefill`): profile 없음 ∧ parsed ∧ problems 0 ∧ 프로모션
   아님 ∧ `longContext.kind === "flat"` ∧ 입력·출력 둘 다. "flat"은 **긍정 진술**일 때만:
   OpenAI는 모델 페이지에 장문 문장이 없고 **동시에** 가격표 장문 칸이 전부 `-`;
   Anthropic은 명시 문장의 버전 이상. 이 조건이 과소 과금 override를 만들 수 있는
   경로가 남아 있는지.
2. **문서 간 교차 검증**: OpenAI 모델 페이지와 가격표의 입력·출력 가격이 다르면
   problem → prefill 금지. Anthropic은 단일 문서라 교차 검증이 없습니다. 이게 충분한지.
3. **API 우선**: 컨텍스트·출력 상한·이미지는 모델 API 값이 있으면 API, 없을 때만 문서.
   충돌은 unknown으로 표시. 문서 출력 상한도 1단계 가드(`상한 + 최대 입력 ≤ 창`)를
   그대로 통과해야 cap으로 채워집니다.
4. **저장된 증거 신뢰**(`docParseFromStored`): parserVersion이 현재와 다르면 무시.
   JSON 형태가 어긋나면 null 또는 unknown으로 강등.
5. **수집기 안전성**: 허용 호스트 2개, `redirect: "error"`, 10초 timeout, 1.5MB,
   content-type이 markdown/text가 아니면 실패, 공급자당 12모델, 동시 3. 대상은 **열린
   add 큐의 sighting**뿐. 실패 시 `fields`를 DbNull로 지워 어제 가격이 오늘 실패 옆에
   남지 않게 함. check route 180초 안에 들어가는지.
6. **패널 id 따라가기 일반화**: 1단계에서 5라운드 검토로 확정한 cap 로직을
   `DRAFT_FOLLOWED_FIELDS`(cap + 가격 3필드)로 넓혔습니다. 가격도 id가 profile 있는
   id로 바뀌면 override가 되므로 같은 위험입니다. 일반화가 기존 승인 판정을 깨지
   않았는지 — 필드별 touched, 복귀 시 복원, 대기·실패 경로.
7. **profile 제안**: `RESERVATION_TO_DECIDE`(컴파일 안 되는 식별자)로 결정을 강제.
   tiered 두 번째 tier의 cache write는 문서가 "cache rates"를 말할 때만 배수 적용.
8. **리포트**: 실패 행을 provider failures 블록에 넣고 요약에 붙임(저장된 Slack
   템플릿이 새 변수를 버리므로). `docEvidence === undefined`(수집 throw)는 "did not
   run"으로 인쇄, `null`은 이 호출자가 수집을 안 함.

## 범위 밖으로 발견한 것 (판정 요청 아님, 참고)

크레딧당 비용 상한 `COST_PER_CREDIT_CEILING_MICRO_USD = 40,000`이 2026-08-01의 Opus
4.8($5/$25)·출력 8,192 기준으로 유도됐는데, 현재 출력 상한은 128,000이고 $10/$50
모델이 있습니다. 채택 폼의 크레딧 하한은 Fable 5.1·Astra·Opus 5 모두
`above_every_class`가 됩니다. 크레딧 정책 결정이라 이 PR에서 바꾸지 않습니다.

## 요청

P1(반드시 수정)/P2(고려)로 분류하고 파일:줄과 재현 가능한 실패 시나리오를 적어
주세요. 특히 **과소 과금 override가 생길 수 있는 경로**와 **문서 구조 변화가 조용히
틀린 숫자로 이어지는 경로**를 우선해 주세요. 코드를 수정하지 말고 한국어로 답해
주세요.
