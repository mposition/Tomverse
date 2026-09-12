# 발견 큐 → 레지스트리 채택 기능 독립 재검토 (Round 7)

- 검토일: 2026-09-12
- 검토 기준: `git show 9cdc4f6d` 및 현재 소스 트리
  `9cdc4f6d05e2cd4fc8689ca1b9cd68068caa4396`
- 이전 지적: `codex-review-round6.md`의 P1-A6 잔여, P2-A9
- 판정: **수정 후 재검토 필요**

결론부터 말하면 **두 건 모두 완전히 닫히지 않았다.** `9cdc4f6d`은 최초 draft
ID에서 구한 profile 가격에 `modelId`를 붙이고, Registry ID가 달라지면 그 가격을
사용하지 않도록 했다. 이는 다른 ID에 최초 가격을 잘못 재사용하는 경로는 막지만,
Round 6가 요구한 **편집된 ID의 profile 재해석**은 하지 않는다. 따라서 API model에서
만든 ID를 canonical profile ID로 고치는 alias 모델은 여전히 화면에서 Save가
차단된다.

P2-A9도 최초 ID에 profile이 이미 매칭되는 경우의 핵심 문구와 long-context 설명은
개선됐다. 그러나 안내 역시 최초 ID 기준 배열로 한 번만 저장된다. alias 모델의 ID를
canonical 값으로 편집해 실제 저장은 profile을 상속하게 된 뒤에도 화면은 공급자
가격을 직접 입력하라고 안내한다. 안내대로 입력하면 여전히 `NULL` 상속이 숫자
override로 바뀐다.

## 판정 요약

| 항목 | 판정 | 핵심 근거 |
|---|---|---|
| P1-A6 편집된 Registry ID의 profile 미재해석 | **미해결** | 최초 `profilePrice`를 ID 불일치 시 폐기할 뿐 새 `form.id`로 조회·해석하지 않아 alias 채택의 Save 차단이 그대로임 |
| P2-A9 상속 가격인데 직접 입력을 안내 | **부분 개선 / 미해결** | 최초 ID가 profile ID와 같을 때의 문구는 수정됐지만, ID 편집 후 안내는 갱신되지 않아 실제 상속 경로에도 직접 입력을 계속 요구함 |
| 새 결함 | **별도 독립 결함 없음** | 반대 방향 ID 편집에서 생기는 상충 안내도 확인했으나, 두 항목과 같은 “최초 draft snapshot을 재해석하지 않음” 원인의 파생으로 판단함 |

## 남은 결함

### P1-A6. 편집한 Registry ID의 profile을 다시 해석하지 않아 Save가 계속 차단됨

커밋은 adoption-draft 응답의 `profilePrice`에 최초 `draftModelId`를 넣고, panel에서
`profilePrice.modelId === form.id`일 때만 이를 `inheritedPrice`로 사용한다. 하지만
`form.id` 변경 시 새 draft를 요청하거나 새 ID로 가격을 해석하는 코드는 없다.
`setProfilePrice()`는 draft GET 응답을 받은 한 번만 실행된다.

**재현 입력 → 현재의 잘못된 출력:** 새 Anthropic discovery의 API model이
`claude-haiku-4-5-20251001`이고, code profile의 canonical ID는
`claude-haiku-4-5`이다. draft를 열면 `registryIdFromApiModel()`이
`claude-haiku-4-5-20251001`을 제안하므로 최초 profile 조회는 `null`이다. 운영자가
Registry ID를 `claude-haiku-4-5`로 고치고 가격과 max output을 비워 상속을
선택한다 → POST server는 현재 `body.id`로 US$1/US$5 및 max output 64,000 profile을
찾아 floor를 계산할 수 있지만, panel의 `profilePrice`는 계속 `null`이다.
`creditFloor`는 `price_unknown`이 되고 `isCreditFloor(creditFloor)` 조건 때문에 Save가
비활성화된다.

`inheritedPrice`의 ID equality는 반대 문제, 즉 최초 profile 가격을 전혀 다른 편집
ID에 적용하는 것은 방지한다. 그러나 “기존 값을 버림”은 “새 ID를 재해석함”이
아니므로 Round 6의 재현과 기대 출력은 바뀌지 않았다.

- 최초 제안 ID로만 profile 여부와 가격을 계산:
  `app/api/admin/model-lifecycle/adoption-draft/route.ts:97-154`
- profile 가격 state를 draft 응답에서 한 번만 설정:
  `components/admin/AdminModelRegistryPanel.tsx:238-296`
- 편집 ID가 다르면 기존 가격을 `null`로 만들 뿐 재조회하지 않음:
  `components/admin/AdminModelRegistryPanel.tsx:315-345`
- Registry ID 입력은 편집 가능:
  `components/admin/AdminModelRegistryPanel.tsx:741`
- floor가 없으면 Save 차단:
  `components/admin/AdminModelRegistryPanel.tsx:804`
- POST server는 현재 `body.id`로 profile을 해석:
  `app/api/admin/models/route.ts:110-129`,
  `app/api/admin/models/route.ts:184-195`
- 실제 alias profile:
  `lib/modelPricing.ts:1142-1155`

### P2-A9. 편집 후 실제로 상속하는 ID에도 직접 가격 입력 안내가 남음

최초 proposed ID에 profile이 있는 경로는 개선됐다. draft는 가격 컬럼을 비워 profile을
상속하라고 명시하고, floor 설명도 해당 prompt 크기의 tier를 사용했다고 정확히 말한다.
이 범위에서는 이전의 직접 입력 및 long-context 미반영 안내가 제거됐다.

그러나 `hasPricingProfile`도 최초 `proposedId`로만 계산되고, 그 결과로 만든
`unknowns`는 `adoptUnknowns` state에 한 번 저장된다. 위 P1-A6 alias 재현에서 Registry
ID를 `claude-haiku-4-5`로 바꿔도 목록은 계속 “공급자 공식 가격표에서 확인해
입력합니다”라고 표시한다. 저장 server의 실제 의미는 profile 상속인데 화면은 숫자
override를 만들도록 안내하는 상태가 그대로다. 운영자가 안내대로 입력하면 form 숫자가
profile fallback보다 우선하고 Registry 가격 컬럼에도 숫자가 저장되므로 tier와 예정
가격 상속이 평탄화된다.

또한 최초 ID가 profile에 매칭되는 경우에도 상속 안내는 여전히 “아직 사람이 정해야
하는 값” 아래에 있고, 바로 다음 항목은 “최소 등급은 가격을 넣으면 계산됩니다”라고
말한다. 가격을 비워 두라는 새 문구와 같은 패널 안에서 어긋난다.

- 최초 proposed ID의 profile 여부만 draft에 전달:
  `app/api/admin/model-lifecycle/adoption-draft/route.ts:97-101`
- profile 유무에 따른 정적 문구:
  `lib/modelAdoptionDraft.ts:319-334`
- 안내 배열을 한 번만 저장:
  `components/admin/AdminModelRegistryPanel.tsx:238-269`
- 상속 안내까지 미결정 값 아래 표시:
  `components/admin/AdminModelRegistryPanel.tsx:677-686`
- floor가 없으면 직접 가격 입력을 다시 안내:
  `components/admin/AdminModelRegistryPanel.tsx:730-735`

## 새 결함 여부

별도 번호를 부여할 독립 결함은 발견하지 못했다. 다만 이번 변경으로 최초 ID에
profile이 있던 상태에서 Registry ID를 profile 없는 값으로 바꾸면, 가격 floor는 새
equality 검사로 사라지는 반면 `adoptUnknowns`는 계속 “profile을 상속하므로 비워
두세요”라고 말한다. 같은 화면의 floor 영역은 반대로 가격을 입력하라고 안내한다.
이는 P1-A6/P2-A9와 동일하게 ID 편집 후 가격·안내 state를 재해석하지 않는 원인이므로
새 번호로 중복 집계하지 않았다.

## 테스트와 검증

- `git diff 9cdc4f6d^ 9cdc4f6d --check` — 통과
- `npm run typecheck` — 통과
- 변경된 소스·테스트 4개 파일 ESLint — 통과
- `tests/model-adoption-draft.test.ts` +
  `tests/modelRegistryPricingInheritance.test.ts` + `tests/modelPricing.test.mjs` —
  80/80 통과
- `npm run check:model-pricing` — 통과: explicit profile 36,
  fallback/unpriced/register warning 0

추가된 테스트는 `buildAdoptionDraft({ hasPricingProfile: true })`가 상속 문구를 내는지와
false일 때 공식 가격표 문구를 내는지만 검사한다. 편집된 `form.id`에 대해 profile
가격과 안내를 다시 해석하는 route/client 동작은 테스트하지 않으며, 실제 구현에도 그
경로가 없다. 따라서 green test는 위 두 잔여 결함을 반증하지 않는다.
