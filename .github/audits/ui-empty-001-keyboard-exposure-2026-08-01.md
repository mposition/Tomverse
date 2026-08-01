# UI-EMPTY-001 — empty 상태 background control 키보드 노출 (미해결)

## 상태

- 분류: **P1 접근성 결함**
- 상태: **미해결(Open)**. 제품 결정 대기가 아니라 **결함으로 추적**합니다.
- 최초 식별: 2026-07-29, dark empty overlay 작업(UI-EMPTY-001) 중
- 이 문서 기준 SHA: `origin/develop` @ `9d37fce`

**릴리스 판정에 미치는 영향**: 이 항목이 릴리스 접근성 기준에 포함되어 있다면,
해결 전까지 해당 기준을 **통과로 표시해서는 안 됩니다**. 아래 "경위"가 보여주듯
"제품 결정 대기"로만 남겨 두면 잘못된 계약이 downstream으로 전파됩니다.

## 결함

`DesktopChatShell`의 empty 상태는 welcome 화면을 comparison panel **위에 덮는
overlay**로 구현돼 있습니다. overlay는 pointer event를 가로채지만, 뒤쪽 panel의
control은 DOM과 tab order와 accessibility tree에 그대로 남습니다.

결과로 생기는 문제:

1. **입력 방식별 동작 불일치.** 마우스 사용자는 overlay 때문에 뒤쪽 control에
   도달할 수 없지만, 키보드 사용자는 Tab으로 도달합니다. 같은 기능이 입력 방식에
   따라 접근 가능 여부가 달라집니다.
2. **보이지 않는 대상으로의 focus 이동.** 가려진 control로 focus가 옮겨가면
   focus 표시가 overlay 뒤에 있어 위치와 목적을 알아보기 어렵습니다.
3. **의미 없는 상태의 control 노출.** panel별 follow-up 입력은 답변이 존재해야
   의미가 있는데, 답변이 하나도 없는 상태에서 키보드로 도달할 수 있습니다.

light/dark 양쪽 모두 해당하며, overlay alpha 변경(UI-EMPTY-001의 색상 부분)과는
무관하게 그 이전부터 존재하던 구조 문제입니다. **다만 선행 결함이라는 사실이
심각도를 낮추지는 않습니다.**

## 경위 — 왜 "결정 대기"로 두면 안 되는지

1. `bc49c2c`에서 panel에 `inert={isConversationEmpty || undefined}`를 추가해
   노출을 닫으려 했습니다.
2. 그 결과 `upgrade-discovery.spec.ts`의
   "panel-only send waits for a changed model selection to persist"가
   재시도 2회 포함 3회 모두 실패했습니다. panel의 model select와 follow-up
   입력이 실제로 조작되는 경로였기 때문입니다.
3. `09c1201`에서 `inert`를 되돌렸습니다. 무조건 `inert`는 올바른 해법이 아니며,
   되돌린 판단 자체는 유효합니다.
4. 그런데 그 사이 **다른 branch(#147)** 가 `inert`가 살아 있던 시점의 제품을
   기준으로 해당 테스트를 다시 썼습니다. 그리고 `inert` revert가 반영된 뒤에도
   테스트 쪽 변경은 그대로 남았습니다.

현재 `origin/develop`의 상태:

| 위치 | 내용 |
|---|---|
| `components/chat/DesktopChatShell.tsx` | `inert={` **0회**. 주석은 "inert는 시도했다가 되돌렸고 background control 노출은 남아 있다"고 설명 |
| `tests/e2e/upgrade-discovery.spec.ts` | 주석은 "UI-EMPTY-001 makes the whole comparison panel `inert` while the conversation has no messages yet"라고 **반대 계약**을 설명 |

즉 제품과 테스트가 서로 반대되는 계약을 문서화하고 있습니다.

### 파생된 실질 문제 2가지

**(1) 항상 참이 되는 assertion.** 같은 테스트에 다음이 남아 있습니다.

```ts
await expect(page.getByTestId("desktop-model-panel").first()).not.toHaveAttribute(
  "inert",
  ""
);
```

제품에 `inert`가 전혀 없으므로 이 단언은 **모든 상태에서 무조건 통과**합니다.
empty 상태를 배제하려고 넣은 검사인데 아무것도 지키지 못합니다.

**(2) 커버리지 소실.** 위 테스트는 원래 *메시지가 없는* 대화에서 panel-only
send의 순서를 검증했습니다. 지금은 history를 seed해 non-empty 상태로 바꿔
검증합니다. 원래 시나리오는 더 이상 어디서도 실행되지 않습니다.

## 제품 결정 — 부분 분리형

승인된 방향은 "panel 전체에 무조건 `inert`"가 **아닙니다**. empty 화면을
interactive panel 위의 overlay가 아니라 **독립적인 시작 화면**으로 취급하고,
첫 질문 전에 필요한 control만 그 화면에 **직접** 제공합니다.

**empty 상태에서 접근 가능**

- 메인 입력창
- 명시적으로 보이는 모델 선택 control
- 최근 대화
- 로그인·업그레이드 등 welcome 화면에 실제로 표시된 CTA

**empty 상태에서 접근 불가**

- panel별 follow-up 입력
- 답변이 생겨야 의미가 있는 panel 작업
- overlay 뒤에 가려진 모든 control

**첫 답변 생성 이후**

- welcome 화면 제거
- panel model selector와 follow-up 입력 활성화

모델 선택은 첫 질문 전에 반드시 필요하므로 막으면 안 됩니다. 대신 **가려진
panel의 selector를 이용하게 하지 말고**, welcome 화면 또는 공용 모델 선택기에
명확한 경로를 제공합니다. 잠긴 모델을 선택했을 때의 upgrade 안내도 이 전면
경로에서 보장합니다.

## 완료 조건

- [ ] Tab focus가 **화면에 보이는 control에만** 도달
- [ ] pointer와 keyboard가 **동일한 기능**에 접근
- [ ] empty 상태에서 panel follow-up 입력 접근 불가
- [ ] 첫 질문 전 모델 변경 가능, 잠긴 모델의 upgrade discovery 가능
- [ ] 첫 메시지 이후 panel control 정상 활성화
- [ ] light/dark × desktop/compact × 200% 확대 회귀 테스트
- [ ] 서로 반대인 코드·테스트 주석과 계약 문서 정리
- [ ] 위 (1)의 무의미한 assertion 제거 또는 실제 계약에 맞게 수정
- [ ] 위 (2)로 사라진 empty 상태 panel-only send 커버리지 복원 여부 판단

## 관련 위치

- `components/chat/DesktopChatShell.tsx` — empty overlay와 panel 렌더링
- `components/chat/ChatWelcomeScreen.tsx` — 시작 화면이 직접 제공해야 할 control
- `tests/e2e/upgrade-discovery.spec.ts` — "panel-only send waits for a changed
  model selection to persist"
- `docs/ui-contracts/` — 확정 후 계약 문서화 위치 검토
