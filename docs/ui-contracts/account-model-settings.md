# Account model settings (new conversation default combination)

로그인 계정의 "새 대화 기본 조합" 설정 UI 계약입니다. `AuthButton.tsx`의
preferences 탭, `components/onboarding/ModelFinder.tsx`의 저장 동선,
`lib/newConversationModels.ts` resolver의 사용자-보이는 결과를 바꾸기 전에
읽습니다. 저장 계층의 계약은
`docs/policy/default-model-luna-migration.md` §1.2가 정의하며, 이 문서는 그
계약이 화면에서 지켜지는 방식을 고정합니다.

## 개념 분리 (비타협)

- **게스트 선두 모델**(`AppSetting["guestDefaultModelId"]`), **플랫폼·계정 대표
  모델**(`DEFAULT_MODEL_ID` / `UserSettings.defaultModel`), **새 대화 기본
  조합**(`UserSettings.newConversationModelIds`)은 서로 다른 세 결정입니다.
  설정 UI는 셋을 하나의 컨트롤로 합치지 않습니다.
- 새 대화 기본 조합은 기존 두 기본 모델 개념을 **대체하지 않습니다**.

## 설정 화면 요구사항

- 제목은 "새 대화 기본 조합"(en: "New chat default combination")입니다.
  "기본 AI 엔진 모델"이라는 단일 모델 표현으로 되돌리지 않습니다.
- 1~3개의 모델을 선택·표시합니다. 조합의 **첫 모델에 "대표 모델" 배지**를
  붙이고, 대표 모델 변경 또는 순서 변경이 가능해야 합니다.
- **모델별 기본 크레딧과 조합 전체의 기본 크레딧 합계를 저장 전에 표시**합니다.
  크레딧 계산은 runtime catalogue usage profile을 쓰는 기존 클라이언트 경로
  하나만 사용합니다. 서버 응답의 별도 합계 필드를 만들지 않습니다.
- 모델을 하나만 선택하면 그것이 단일 AI 시작입니다. 별도 `startMode`나
  "마지막 사용 조합" 상태를 추가하지 않습니다.
- 기존 사용자는 조합을 저장한 적이 없으면 `[defaultModel]` 단일 조합으로
  표시됩니다. UI가 임의로 모델을 추가해 두지 않습니다.
- Advanced·Research 모델을 조합에 **새로** 넣어 저장하려면, 반복 기본 사용
  비용임을 알리는 문구와 명시적 동의(별도 컨트롤)를 거쳐야 합니다. 동의 없이
  저장 요청을 보내지 않습니다.

## 저장·응답 계약 (UI가 지켜야 하는 것)

- 저장 성공 후 화면에 적용하는 조합은 **서버가 반환한 canonical 배열**입니다.
  요청 당시의 로컬 배열을 그대로 신뢰하지 않습니다.
- theme·language만 바꾸는 저장이 모델 필드를 다시 보내지 않도록 dirty field만
  전송합니다. GET이 돌려준 effective replacement가 사용자 동의 없이 POST로
  재저장되는 일이 없어야 합니다.
- 조합 저장 후 새 대화·새로고침에서도 동일 조합으로 시작해야 합니다
  (`tests/e2e/model-finder.spec.ts`가 검증).

## stored/effective 안내

- 저장된 조합의 모델을 lifecycle(비활성·delist·은퇴)이나 플랜 제한으로 그대로
  쓸 수 없으면, 조용히 교체하지 않고 **이유와 대안을 사용자 문구로 안내**합니다.
  내부 lifecycle 코드나 원시 진단을 그대로 노출하지 않습니다.
- 같은 `reason + stored/effective 모델 조합`의 시각적 안내는 브라우저 탭
  (세션) 당 한 번만 표시합니다. reason이나 조합이 달라지면 다시 표시합니다.
- 설정 화면에는 해결되지 않은 상태를 계속 확인할 수 있는 비방해성 표시를 둘 수
  있습니다.
- 안내는 "조합을 다시 저장하면 변경이 확정된다"는 경로를 함께 제시합니다.
  읽기 경로가 DB를 대신 고쳐 주지 않기 때문입니다.

## 회귀 범위

- 관련 변경은 `tests/e2e/model-finder.spec.ts`(저장 → 새 대화 → 새로고침
  지속성)와 `npm run check:default-models`의 C 섹션을 통과해야 합니다.
- 이 계약을 위반하는 변경은 릴리스 차단 사유입니다.
