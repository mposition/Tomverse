# 발견 큐 → 레지스트리 채택 기능 독립 재검토 (Round 8)

- 검토일: 2026-09-12
- 검토 기준: `git show 6f427dde` 및 현재 소스 트리
  `6f427dde441d3d8c95047b450ddded47d86c5fce`
- 이전 지적: `codex-review-round7.md`의 P1-A6, P2-A9
- 판정: **수정 후 재검토 필요**

결론부터 말하면 **P1-A6은 정상 응답 경로에서 닫혔지만 P2-A9는 아직 완전히
닫히지 않았다.** `6f427dde`은 편집 중인 Registry ID를 adoption-draft API에 다시
보내고, 그 ID로 profile 가격과 안내를 다시 계산한다. 따라서
`claude-haiku-4-5-20251001`을 `claude-haiku-4-5`로 고치는 Round 7 재현에서는 빈 가격
컬럼을 유지한 채 floor가 계산되고 Save 차단이 해소된다.

그러나 profile 상속 안내 바로 다음에 여전히 “최소 등급은 가격을 넣으면
계산됩니다”가 표시되고, 상속 안내 자체도 “아직 사람이 정해야 하는 값” 아래에 있다.
가격을 비워 두라는 올바른 안내와 직접 입력을 전제로 한 안내가 같은 목록에서 충돌하므로
P2-A9는 부분 해결에 그친다.

새 결함은 **P2 1건**이다. 편집 ID 재해석 요청이 실패하면 코드는 오류를 조용히
버리지만, 화면은 일치하는 `profilePrice`가 없어서 Save를 계속 비활성화한다. 저장
server가 현재 ID를 다시 해석한다는 주석과 달리 사용자는 저장 요청 자체를 보낼 수
없고, 실패한 요청의 자동 재시도도 없다.

## 판정 요약

| 항목 | 판정 | 핵심 근거 |
|---|---|---|
| P1-A6 편집된 Registry ID의 profile 미재해석 | **해결** | `modelId` query로 현재 `form.id`를 다시 해석하고, 응답의 가격이 같은 ID일 때 floor에 사용함 |
| P2-A9 상속 가격인데 직접 입력을 안내 | **부분 해결 / 미종결** | ID별 상속 여부는 갱신되지만, profile 상속 상태에도 “가격을 넣으면 계산” 문구와 “아직 사람이 정해야 하는 값” 구획이 그대로임 |
| 새 P2-A10 재해석 실패 후 Save 차단 지속 | **미해결** | non-2xx/예외를 상태 변경 없이 무시하여 재시도가 일어나지 않고, client floor가 없어서 Save도 누를 수 없음 |

## 닫힌 항목

### P1-A6. 편집한 Registry ID의 profile 재해석

route는 이제 선택적인 `modelId` query를 읽어 `pricedModelId`로 삼고, 그 ID로
`hasPricingProfile`과 `profilePrice`를 모두 계산한다. panel은 채택 중 `form.id`가
현재 `profilePrice.modelId`와 다르면 400ms 뒤 같은 endpoint를 다시 요청하며,
응답의 `profilePrice`와 `unknowns`를 함께 교체한다.

따라서 Round 7의 재현은 다음처럼 바뀐다.

1. provider API model `claude-haiku-4-5-20251001`로 연 draft의 최초 proposed ID에는
   profile이 없어 가격 floor가 없다.
2. 운영자가 Registry ID를 canonical `claude-haiku-4-5`로 고친다.
3. 재조회가 `lib/modelPricing.ts`의 US$1/US$5, max output 64,000 profile을 현재
   worst-case prompt tier로 해석해 반환한다.
4. `profilePrice.modelId === form.id`가 되어 빈 가격과 빈 output cap의 fallback으로
   쓰이고, 판매 등급·크레딧·채택 사유 조건까지 충족하면 Save가 활성화된다.
5. POST도 현재 `body.id`를 동일하게 해석하므로 UI floor와 저장 preflight가 같은
   profile을 본다.

핵심 근거:

- 현재 form ID query 해석:
  `app/api/admin/model-lifecycle/adoption-draft/route.ts:43-57`,
  `app/api/admin/model-lifecycle/adoption-draft/route.ts:108-174`
- 편집 ID의 debounced 재조회와 가격·안내 갱신:
  `components/admin/AdminModelRegistryPanel.tsx:330-367`
- 응답 가격을 같은 ID에만 결속:
  `components/admin/AdminModelRegistryPanel.tsx:321`
- profile 가격을 floor fallback으로 사용:
  `components/admin/AdminModelRegistryPanel.tsx:368-392`
- 저장 server도 현재 `body.id`로 profile 해석:
  `app/api/admin/models/route.ts:110-129`,
  `app/api/admin/models/route.ts:184-195`
- 실제 alias profile:
  `lib/modelPricing.ts:1142-1155`

## 남은 결함

### P2-A9. profile 상속 상태에도 직접 가격 입력을 전제로 한 안내가 남음

이번 커밋은 Round 7의 주 재현, 즉 ID를 편집한 뒤에도 최초 안내가 남던 문제는
해결했다. 재조회 응답의 `unknowns`를 `setAdoptUnknowns()`로 반영하므로 canonical
profile ID에서는 “profile을 상속합니다. 비워 두세요”가 표시되고, profile 없는 ID로
바꾸면 공식 가격표에서 입력하라는 안내로 돌아간다.

하지만 `buildAdoptionDraft()`는 profile 유무와 관계없이 바로 다음 항목으로
“판매 등급과 크레딧 — 최소 등급은 가격을 넣으면 계산됩니다”를 추가한다. profile이
있는 경우 가격은 입력하는 값이 아니며 이미 profile로 floor를 계산한다. 같은 목록의
앞 문장은 숫자를 넣으면 tier와 예정 가격을 영구 override한다고 경고하고, 뒤 문장은
가격을 넣어야 계산된다고 말하므로 행동 지침이 여전히 상충한다.

상속 안내도 계속 “아직 사람이 정해야 하는 값” 제목 아래에 있다. profile을 상속하기
위해 가격 컬럼을 비우는 것은 이미 정해진 저장 의미이지 사람이 결정할 값이 아니다.
상속 안내를 정보성 구획으로 분리하거나, profile이 있을 때 판매 등급 문구를 “profile
단가로 계산된 최소 등급 이상을 선택합니다”처럼 바꾸지 않는 한 P2-A9는 닫히지 않는다.

- profile별 첫 가격 문구:
  `lib/modelAdoptionDraft.ts:322-333`
- profile 여부와 무관한 직접 입력 전제 문구:
  `lib/modelAdoptionDraft.ts:334`
- 전체 목록을 미결정값으로 표시:
  `components/admin/AdminModelRegistryPanel.tsx:724-733`

### 새 P2-A10. ID 재해석 요청이 실패하면 오류·재시도 없이 Save가 계속 차단됨

재해석 GET의 non-2xx 응답은 body만 버리고 반환하며, network/parse 예외도 빈
`catch`에서 무시한다. 주석은 server가 저장 시 profile을 다시 해석하므로 괜찮다고
설명하지만 실제 Save 버튼은 client의 `isCreditFloor(creditFloor)`를 필수 조건으로
사용한다.

재현은 다음과 같다.

1. 최초 proposed ID에 profile이 없어 `profilePrice === null`인 adoption draft를 연다.
2. Registry ID를 profile이 있는 canonical ID로 고친다.
3. 400ms 뒤 재해석 GET이 429, 5xx 또는 network 오류로 실패한다.
4. `profilePrice`와 `adoptUnknowns`는 바뀌지 않고, 현재 ID와 일치하는 inherited
   price가 없으므로 floor는 `price_unknown`으로 남는다.
5. Save는 `!isCreditFloor(creditFloor)` 때문에 비활성화된다. 요청 실패가 어떤
   상태도 바꾸지 않아 effect dependency도 그대로이며 자동 재시도는 없다.

결국 사용자는 ID를 다시 흔들어 요청을 우연히 재발시키거나 form을 다시 열어야 한다.
그렇지 않으면 server의 올바른 재해석 경로에는 도달할 수 없고, 기존 안내를 따라 숫자를
입력하면 다시 영구 override를 만들 수 있다. endpoint 자체가 분당 30회로 제한돼 있어
non-2xx는 이론적인 경우만도 아니다.

또한 profile이 있던 ID에서 profile 없는 ID로 바꿀 때 첫 성공 응답이
`profilePrice`를 object에서 `null`로 바꾸면 effect dependency가 한 번 더 바뀌어 같은
ID를 재조회한다. `null`이 “아직 해석되지 않음”과 “해석했지만 profile 없음”을 함께
뜻하기 때문이다. 이 중복 요청은 같은 상태 모델 문제이며 rate-limit 여유를 불필요하게
줄이므로 P2-A10에 함께 포함한다.

- 실패를 상태 변경 없이 무시:
  `components/admin/AdminModelRegistryPanel.tsx:346-360`
- 재시도 여부를 ID와 `profilePrice.modelId`에만 의존:
  `components/admin/AdminModelRegistryPanel.tsx:330-367`
- 일치하는 가격이 없으면 floor가 `price_unknown`:
  `components/admin/AdminModelRegistryPanel.tsx:321`,
  `components/admin/AdminModelRegistryPanel.tsx:368-392`,
  `lib/modelAdoptionDraft.ts:147-154`
- client floor가 없으면 Save 비활성화:
  `components/admin/AdminModelRegistryPanel.tsx:843-851`
- endpoint rate limit:
  `app/api/admin/model-lifecycle/adoption-draft/route.ts:38-41`

## 새 결함 여부

**새 P2-A10 1건이 있다.** 정상 응답에서 P1-A6을 해결한 재조회 경로가 실패 상태를
표현하지 않고 오류를 무시해, 자동 재시도와 Save 양쪽을 모두 막는다. 위에서 설명한
profile → non-profile 전환의 중복 요청도 같은 resolution state 결손에 포함했다.

## 테스트와 검증

- `git diff 6f427dde^ 6f427dde --check` — 통과
- `npm run typecheck` — 통과
- 변경된 소스 2개 파일 ESLint — 통과
- `tests/model-adoption-draft.test.ts` +
  `tests/modelRegistryPricingInheritance.test.ts` — 53/53 통과
- 보고서 작성 전 `git status --short` — 기존 변경 없이 깨끗함

`6f427dde`에는 route/client 변경을 실행하는 테스트가 추가되지 않았다. 현재 테스트는
`buildAdoptionDraft({ hasPricingProfile: true })`의 상속 문구와 저장 preflight의 profile
fallback을 고정하지만, 편집 ID query가 route에서 새 profile을 반환하는지, client가
그 응답으로 안내와 Save 상태를 갱신하는지, 실패 뒤 복구되는지는 실행하지 않는다.
따라서 53개 green test는 P1-A6의 정상 경로를 직접 증명하지 않으며 P2-A9와 새
P2-A10도 포착하지 못한다.
