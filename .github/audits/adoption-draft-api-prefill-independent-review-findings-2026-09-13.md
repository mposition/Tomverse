# 독립 검토 결과 — 채택 초안 API prefill (1단계)

검토자: codex (독립 실행) · 5라운드 · 최종 **승인**
요청서: `adoption-draft-api-prefill-independent-review-prompt-2026-09-13.md`,
`adoption-draft-api-prefill-round2-prompt-2026-09-13.md`

## 배경

2026-09-13 staging에서 Claude Fable 5.1·GPT-6 Astra를 채택하자 Native PDF,
Reasoning, Max output, Reservation, 가격 칸이 비어 있었습니다. 원인은
(1) `supportsNativePdf` 컬럼이 있는데 초안이 PDF를 출력하지 않음 — 이전 분석에서
대소문자를 구분한 grep(`pdf`)이 `Pdf`를 놓쳐 "컬럼 없음"으로 잘못 판단,
(2) 초안 타입이 max output·reservation·가격을 `null`로 고정, (3) 가격이 두 공급자
모델 API에 없음(2단계 범위)이었습니다.

## 운영자 승인 방향과 구현에서 바꾼 것

승인안: max output 조건부 prefill, reasoning `high` 제안 + 확정 필수, 1단계 먼저.

**Reservation은 승인안("등급 기본값으로 채움")과 다르게 구현했습니다.** null
reservation은 요청 시점에 이미 profile·등급 기본값으로 해석되므로, 숫자를 쓰면 오늘은
같은 값이고 내일은 정책을 따라가지 않는 화석만 남습니다. 대신 빈 칸에 실제 적용될
값을 흐리게 표시합니다. 1차 라운드에서 codex가 이 변경 자체를 타당하다고 판정했습니다.

## 라운드별 결과

### 1차 — P1 4, P2 1

| # | 지적 | 처리 |
|---|---|---|
| P1-1 | `inputTokenLimit`을 창으로 쓰면 "창을 모르면 복사 안 함"이 깨짐 | **반론** — 2차에서 타당 판정 |
| P1-2 | profile 없는 모델의 빈 cap에 "비워 두면 적용" 표시, 서버는 거절 | 수정 |
| P1-3 | 라우트가 이미 cap으로 잘린 예약값을 내려줘 env override 시 표시와 저장 결과 불일치 | 수정 |
| P1-4 | "손대지 않음"을 값 비교로 판정 — 같은 값을 다시 입력하면 덮어씀 | 수정 |
| P2 | reasoning 확정이 UI 전용 | 수용 안 함(설계 선택) |

**P1-1 반론.** 입력 한도는 실제 창의 **하한**입니다 — 최대 허용 입력은 창 안에
들어가야 하므로 `창 ≥ 입력 한도`. 따라서 `cap + 최대 입력 ≤ 입력 한도`가 통과하면
실제 창에서도 통과하며, 가드는 이 값에 대해 엄격해질 수만 있습니다. codex는 2차에서
"타당"으로 판정하고, 단 `inputTokenLimit`에 다른 의미의 수치(feature-gated 한도 등)를
넣으면 전제가 깨지므로 parser 계약을 유지해야 한다고 덧붙였습니다. 근거는
`requestOutputCapFromProvider` 주석과 테스트에 남겼습니다.

**P1-2.** `blankTokenFieldValues()`로 판정을 옮겨 profile이 없으면 `"required"`,
패널은 "필수 · 비우면 저장되지 않습니다". 초안 노트의 "비우면 2,048~8,192로 잘림"
문구도 채택 경로에서는 틀렸으므로 고쳤습니다(prefill의 이득은 잘림 방지가 아니라
재입력 제거 — profile 없으면 빈 cap은 애초에 저장되지 않음).

**P1-3.** 같은 `resolveModelPricing`을 `maxOutputTokens: Number.MAX_SAFE_INTEGER`로 한 번
더 불러 clamp 전 예약값을 얻고, `min(입력 cap ?? 기본 cap, clamp 전 예약값)`.
지적된 4,096 / 8,192 / 16,000 시나리오를 실제 resolver로 고정하는 테스트 추가.

**P1-4.** 입력 onChange에서 동기로 켜는 `maxOutputTouchedRef`.

**P2 수용 안 함.** 판매 등급 확정과 같은 관리자 UI acknowledgement입니다. 서버는
select를 건드렸는지 알 수 없고 등급도 같은 방식입니다. API 수준 불변식이 필요하면
등급과 함께 별도 설계할 사안입니다. codex도 "UI acknowledgement로 한정한다면 수용
가능"으로 판정했습니다.

### 2차 — P1-1 반론 타당, P1-3 해결, P1 1 잔존

ID를 고친 뒤 profile 재조회가 **대기 중이거나 실패한 경우**, 이전 ID 기준 prefill
cap이 그대로 저장돼 profile override 화석이 되는 경로. 같은 원인으로 그 구간에 "필수"를
단정.

수정: `capProposedForIdRef`(cap이 어느 id 기준인지), 재조회 타이머 발화 시 손대지
않은 다른 id의 cap을 즉시 비움, `lookupSettledForId`로 파생한 `profileLookupPending`
동안 저장 비활성, 미확정이면 `blankTokenFieldValues`에 `null`을 넘겨 안내 없음.

### 3차 — P1 해결, P2 3

1. 응답 없는 조회로 영구 pending → `AbortSignal.timeout(10_000)`.
2. 공백 id 불일치(엔드포인트·스키마는 trim) → 비교에 `form.id.trim()`.
3. 실패 플래그가 id에 귀속되지 않음 → `profileLookupFailedForId`로 바꿔 파생.

추가로 이미 settled된 id는 재조회하지 않음(아는 답을 실패로 뒤집을 수 있으므로).

### 4차 — 3건 해결, 기존 P1 재개방 없음, P2 1

B 조회 중 A로 복귀하면 A의 제안 cap이 복원되지 않음. settled early return에 "cap을
손댔거나 여전히 이 id 기준"일 때만 건너뛰는 조건 추가.

### 5차 — 승인

해결 확인, ref를 실행 시점에 읽으므로 stale closure 없음, 이전 P1·P2 재개방 없음,
새 P1/P2 없음.

## 검증

- `npm run typecheck` · `check:encoding:strict` · `check:accent-tokens` 통과
- 변경 파일 `eslint --max-warnings=0` 통과
- `tests/model-adoption-draft.test.ts` 65건 통과(신규 16건)
- `npm run test:unit` 실패 7건 — 변경을 뺀 기준선에서 동일하게 재현되는 Windows 환경
  문제(경로 스캔 6, 실행 비트 1)

## 한계

패널의 id 재조회 상태 전이(`maxOutputTouchedRef`, `capProposedForIdRef`,
`lookupSettledForId`)는 컴포넌트 테스트가 없어 codex의 코드 추적으로만 검증했습니다.
순수 판정(`blankTokenFieldValues`, `requestOutputCapFromProvider`, `suggestReasoning`)은
단위 테스트로 고정했습니다.
