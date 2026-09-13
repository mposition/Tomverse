# 독립 검토 요청 — 채택 초안 API 데이터 prefill (1단계)

## 배경

staging에서 Claude Fable 5.1과 GPT-6 Astra를 채택하자 Native PDF, Reasoning,
Max output tokens, Reservation, 가격 칸이 비어 있었습니다. 원인은 셋이었습니다.

1. `supportsNativePdf` 컬럼이 있는데도 초안이 PDF를 출력하지 않았습니다(파서는
   `pdfInput`을 이미 수집).
2. 초안 타입이 `maxOutputTokens`·`reservationOutputTokens`·가격·캐시 배수를
   `null`로 **고정**하고 있었습니다(#1378).
3. 가격은 두 공급자 모두 모델 API에 없습니다 — 이번 범위가 아니며 2단계입니다.

운영자가 승인한 방향: max output은 조건부 prefill, reasoning은 `high` 제안 +
확정 필수, 이번은 API로 이미 받는 값만.

## 변경

`lib/modelAdoptionDraft.ts`, `app/api/admin/model-lifecycle/adoption-draft/route.ts`,
`components/admin/AdminModelRegistryPanel.tsx`, 테스트.

### A. Max output — 조건부 prefill

`requestOutputCapFromProvider`: 공급자 상한 + `CHAT_USER_MAX_INPUT_TOKENS` ≤
컨텍스트일 때만 복사. 컨텍스트를 모르면 복사하지 않음. **pricing profile이 있으면
복사하지 않음**(null이 profile을 상속).

근거: 컬럼이 null이면 `resolveModelPricing`이 profile → 등급 fallback
(2,048/4,096/8,192)으로 해석합니다. profile 없는 reasoning 모델을 비워 두면 8,192로
잘립니다 — `claude-sonnet-5` 4,096 화석과 같은 실패입니다. Kimi K3(상한 = 컨텍스트)
사고는 가드가 산술로 막습니다.

패널: 운영자가 id를 고쳐 profile 있는 id가 되면, **손대지 않은** prefill 값만 새
초안 값(null)으로 따라갑니다. 운영자가 입력한 숫자는 유지합니다.

### B. Reservation — 쓰지 않고 표시

승인안은 "등급 기본값으로 채움"이었으나 구현에서 바꿨습니다. null reservation은
런타임에 이미 profile/등급 기본값으로 해석되므로, 숫자를 쓰면 **오늘은 같은 값이고
내일은 정책을 따라가지 않는 화석**만 남습니다(AGENTS.md가 이 컬럼들의 화석을
경고). 대신 라우트가 `resolveModelPricing`으로 등급별 실효값을 계산해
`effectiveTokenLimits`로 내려주고, 패널이 빈 칸의 placeholder로 "4,096 · 비워 두면
적용"을 보여 줍니다. max output 빈 칸에도 같은 표시를 합니다.

### C. Reasoning — 제안 + 확정 필수

`suggestReasoning`: thinking 지원 시 `high`. 단 공급자가 effort 단계를 알렸고
`high`가 없으면 medium → low 순. 셋 다 없으면 제안하지 않음. Anthropic 요청은 이
값을 `effort`로 그대로 보내므로(`lib/modelGenerationCompatibility.ts`) 지원하지
않는 단계를 제안하면 모든 요청이 실패합니다.

패널: 제안값이 있으면 확정 전까지 저장 버튼 비활성. select 변경 또는 "이 값으로
확정" 버튼으로 확정(같은 값 재선택은 onChange가 안 일어나므로 버튼이 필요).

### D. Native PDF

`pdfInput`이 boolean이면 그대로, 없으면 미지원으로 두고 unknown에 명시.

## 특히 봐 주셨으면 하는 것

1. **B의 설계 변경이 타당한지.** 승인안과 다릅니다. placeholder 값이 저장 결과와
   실제로 일치하는지 — 특히 per-model env override, profile 유무, 등급 변경, max
   output을 입력했을 때 `min(cap, reservation)` 규칙.
2. A의 가드가 Kimi K3 유형을 모두 막는지, 그리고 id 변경 시 prefill 추종 로직
   (`prefilledMaxOutputRef`/`formMaxOutputRef`)에 경쟁 조건이나 잘못 덮어쓰는 경로가
   있는지.
3. max output prefill이 크레딧 하한 계산에 미치는 영향 — 이제 하한이 128,000 출력
   기준으로 계산됩니다. 그것이 옳은지.
4. reasoning 확정 게이트가 클라이언트 전용인 것(등급 확정과 같은 방식)이 허용
   가능한지, 우회 경로가 문제가 되는지.
5. 서버 preflight나 저장 경로에 이번 변경과 어긋나는 규칙이 있는지.
