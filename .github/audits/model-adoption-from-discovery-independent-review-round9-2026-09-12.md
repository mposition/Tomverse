# 발견 큐 → 레지스트리 채택 기능 독립 재검토 (Round 9)

- 검토일: 2026-09-12
- 검토 기준: `git show d754fd53` 및 현재 소스 트리
  `d754fd5356ed2376d9c0b77b0835f13e3da8d0ec`
- 이전 지적: `codex-review-round8.md`의 P2-A9, P2-A10
- 판정: **수정 후 재검토 필요**

결론부터 말하면 **P2-A9는 해결됐지만 P2-A10은 부분 해결에 그쳤다.** 상속 가격은
이제 “이미 정해진 값”으로 분리되고, 판매 등급 안내도 “상속 가격으로 계산”된다고
말하므로 서로 반대되는 행동을 요구하지 않는다.

P2-A10은 재해석 GET의 non-2xx와 `fetch` 예외에서는 Save 차단을 해제한다. 그러나
HTTP 2xx 응답의 JSON 해석이 실패하면 `null`을 조용히 반환한 뒤 아무 상태도 바꾸지
않아 Round 8과 같은 영구 차단이 남는다. 또한 이번 실패 상태 추가로, 취소된 이전 ID
요청의 늦은 non-2xx가 현재 ID의 성공 상태를 실패로 덮는 **새 P2-A11**이 생겼다.

따라서 **남은 결함 있음: P2-A10 1건 미종결, 새 P2-A11 1건.**

## 판정 요약

| 항목 | 판정 | 핵심 근거 |
|---|---|---|
| P2-A9 상속 안내와 “가격을 넣으면 계산” 문구 충돌 | **해결** | 상속 안내를 `notes`로 분리하고, profile이 있을 때 판매 등급 문구를 “상속 가격으로 계산”으로 바꿈 |
| P2-A10 재해석 실패 후 Save 영구 차단 | **부분 해결 / 미종결** | non-2xx와 `fetch` 예외는 우회하지만, 2xx의 빈·손상 JSON은 `null` 반환 후 상태 변경 없이 끝나 Save가 계속 비활성화됨 |
| 새 P2-A11 취소된 이전 요청의 실패가 현재 성공을 덮음 | **미해결** | non-2xx 분기만 `cancelled`를 확인하지 않고 실패 상태를 기록하여, 현재 ID의 성공 뒤에도 경고와 floor 우회를 다시 켤 수 있음 |

## 닫힌 항목

### P2-A9. 상속 안내와 직접 가격 입력 안내의 충돌 — 해결

`buildAdoptionDraft()`는 profile이 있는 경우 가격 상속 문구를 미결정 목록
`unknowns`가 아니라 별도 `notes`에 넣는다. 같은 경우 판매 등급 문구도 “가격을
넣으면 계산됩니다”가 아니라 “상속 가격으로 계산됩니다”로 바뀐다. profile이 없는
경우에만 공식 가격을 입력하라는 문구와 “가격을 넣으면 계산” 문구를 유지한다.

panel도 `notes`를 “이미 정해진 값 — 그대로 두세요”라는 별도 제목과 목록으로
렌더링한다. 따라서 상속 가격을 비워 두라는 확정 안내가 “아직 사람이 정해야 하는
값” 목록 안에 섞이지 않고, 바로 옆 문구도 가격 입력을 요구하지 않는다. Registry ID
재해석 응답은 `unknowns`와 `notes`를 함께 갱신하므로 ID를 profile 유무가 다른 값으로
편집하는 경우에도 두 안내가 같이 전환된다.

핵심 근거:

- profile 유무에 따른 `notes`/`unknowns` 분리:
  `lib/modelAdoptionDraft.ts:308-344`
- 확정값 별도 구획 렌더링:
  `components/admin/AdminModelRegistryPanel.tsx:738-759`
- ID 재해석 뒤 두 목록을 함께 교체:
  `components/admin/AdminModelRegistryPanel.tsx:359-368`
- 순수 로직 회귀 테스트:
  `tests/model-adoption-draft.test.ts:692-730`

## 남은 결함

### P2-A10. 2xx 응답의 JSON 해석 실패에서는 Save가 여전히 영구 차단됨

이번 변경은 재해석 GET이 non-2xx를 반환하면 `profileLookupFailed=true`로 만들고,
`fetch` 또는 바깥 `try`의 예외도 같은 상태로 만든다. Save 버튼은 이 상태에서 client
credit floor 검사를 우회하므로 두 실패 경로에서는 서버의 authoritative preflight에
도달할 수 있다.

하지만 성공 status의 응답 본문이 비었거나 전송 중 잘려 JSON 해석이 실패하면
`response.json().catch(() => null)`이 오류를 삼킨다. 바로 다음 줄의
`if (cancelled || !data) return`이 아무 상태 변경 없이 종료하므로 바깥 `catch`에도
도달하지 않는다.

재현은 다음과 같다.

1. profile이 없는 최초 proposed ID로 adoption form을 열어 `profilePrice=null`인
   상태를 만든다.
2. Registry ID를 profile이 있는 canonical ID로 고친다.
3. 재해석 GET은 HTTP 200을 받지만 응답 body가 비었거나 손상되어 `json()`이
   reject되게 한다.
4. `profileLookupFailed`는 계속 `false`, 현재 ID와 일치하는 `profilePrice`도 계속
   없으므로 `creditFloor`는 계산 불가 상태에 남는다.
5. effect dependency를 바꾸는 상태 갱신이 없어 자동 재시도도 없고, Save는
   `!isCreditFloor(creditFloor)` 때문에 계속 비활성화된다.

이는 “재해석 실패가 form을 영구 차단하지 않는다”는 P2-A10의 완료 조건에 포함되는
응답 해석 실패를 놓친 것이다. `!data`를 active request의 실패 상태로 처리하고,
빈·손상 2xx 응답에서도 경고와 Save fallback이 켜지는 client 회귀 테스트가 필요하다.

- JSON 오류를 `null`로 축약한 뒤 조용히 종료:
  `components/admin/AdminModelRegistryPanel.tsx:359-364`
- 일치하는 가격이 없으면 floor가 계산되지 않음:
  `components/admin/AdminModelRegistryPanel.tsx:329`,
  `components/admin/AdminModelRegistryPanel.tsx:382-406`
- 실패 flag가 없을 때 계산 불가 floor로 Save 차단:
  `components/admin/AdminModelRegistryPanel.tsx:880-882`
- 서버 preflight는 Save 요청이 도달했을 때만 현재 ID를 다시 해석:
  `app/api/admin/models/route.ts:268-273`

### 새 P2-A11. 취소된 이전 ID 요청의 늦은 non-2xx가 현재 성공 상태를 덮음

ID가 바뀌면 effect cleanup은 이전 요청의 `cancelled`를 `true`로 만들지만 실제
`fetch`를 중단하지는 않는다. 성공 응답과 바깥 `catch`는 상태를 쓰기 전에
`cancelled`를 확인한다. 반면 새로 추가된 non-2xx 분기는 body를 버린 뒤 조건 없이
`setProfileLookupFailed(true)`를 호출한다.

따라서 다음 순서가 가능하다.

1. ID A의 재해석 요청이 시작된 뒤 운영자가 ID B로 바꾼다.
2. B 요청이 먼저 성공해 B의 `profilePrice`, 안내 목록과
   `profileLookupFailed=false`를 기록한다.
3. 이미 취소 표시된 A 요청이 나중에 non-2xx로 끝나
   `profileLookupFailed=true`를 다시 기록한다.
4. B의 `profilePrice.modelId`는 현재 ID와 이미 일치하므로 effect는 재조회 없이
   바로 반환한다. 잘못 켜진 실패 경고와 Save floor 우회는 이 form에서 계속 남는다.

서버 preflight가 가격과 credit floor를 다시 검사하므로 이 경쟁 조건만으로 잘못된
registry row가 저장되지는 않는다. 그러나 화면은 성공한 현재 조회를 실패했다고
표시하고, 현재 계산된 floor보다 낮은 credit도 Save 가능하다고 보여 준 뒤 서버에서
거절한다. 새 fallback 상태가 요청 세대나 현재 ID에 결속되지 않아 생긴 회귀다.

- non-2xx에서 취소 여부 없이 상태 기록:
  `components/admin/AdminModelRegistryPanel.tsx:354-357`
- 성공·예외 경로에는 존재하는 취소 확인:
  `components/admin/AdminModelRegistryPanel.tsx:364`,
  `components/admin/AdminModelRegistryPanel.tsx:369-374`
- cleanup은 boolean만 바꾸고 요청을 abort하지 않음:
  `components/admin/AdminModelRegistryPanel.tsx:377-380`
- 성공한 현재 ID는 추가 재조회를 막음:
  `components/admin/AdminModelRegistryPanel.tsx:339-342`

모든 응답 경로에서 active request 여부를 확인하거나 `AbortController`/요청 세대로
결과를 현재 ID에 결속하고, “이전 요청 실패가 현재 성공 뒤에 도착”하는 순서를 client
테스트로 고정해야 한다.

## 새 결함 여부

**새 P2-A11 1건이 있다.** P2-A10을 풀기 위해 추가한 실패 상태가 취소된 요청의
non-2xx 경로에서만 현재 요청과 결속되지 않아, 최신 성공을 오래된 실패가 덮을 수
있다.

## 테스트와 검증

- `git diff d754fd53^ d754fd53 --check` — 통과
- 관련 순수 로직 테스트 2개 파일 — **54/54 통과**
  - `tests/model-adoption-draft.test.ts`
  - `tests/modelRegistryPricingInheritance.test.ts`
- 변경 파일 ESLint — 통과
- `npm run typecheck` — 통과
- 보고서 작성 전 현재 `HEAD`는 `d754fd53`, tracked 변경은 없음

추가된 테스트는 P2-A9의 `unknowns`/`notes` 문구 분기만 실행한다. 현재 client unit
test와 admin E2E에는 adoption form의 재해석 실패 상태 전이를 실행하는 사례가 없다.
따라서 위 54개 green test는 P2-A10의 빈·손상 2xx 응답이나 P2-A11의 out-of-order
응답을 검출하지 못한다.

참고로 `npm run test:unit -- <두 파일>`도 시도했으나 이 저장소의 runner는 전달된
파일 인수를 사용하지 않고 669개 서버 테스트 전체를 실행한다. 해당 실행은 120초
제한으로 완료되지 않았고, 중간에 이 커밋의 변경 범위 밖인
`only the shared module writes body.style.overflow` 실패도 관측되어 위 통과 수치에는
포함하지 않았다. 관련 테스트 54개는 runner와 동일한 서버 조건 및 test 플래그로
별도 실행한 결과다.
