# Tomverse accent 사용 inventory (UI-012 / VAL-006)

> **이 문서는 inventory이며, recolor를 승인하지 않습니다.**
> 작업명령서 TASK-009는 `[DESIGN DECISION REQUIRED]`가 해결되기 전에는
> component 색상을 변경하지 않도록 명시합니다. 따라서 이번 작업에서 accent
> 색상 자체는 한 곳도 바꾸지 않았습니다. 유일한 예외는 아래 "대비 때문에
> 변경한 항목"에 기록한 account avatar 1건이며, 이는 semantic 역할 변경이
> 아니라 UI-003의 WCAG AA 실패를 닫기 위한 같은 색상 계열 내 명도 조정입니다.

기준 SHA: `e062da8` 기반 작업 branch `claude/tomverse-insight-ui-audit-3m2k1c`.
집계 방법: `components/`, `app/` 전체에서 `(bg|text|border|ring|from|via|to)-<hue>-<step>` utility 출현 수.

## 1. 전체 사용량

| Hue | 출현 수 | 주 사용처 |
|---|---:|---|
| `amber` | 383 | 크레딧·비용·주의 상태 (status semantic) |
| `emerald` | 317 | 성공·활성·할인, admin 지표 |
| `purple` | 58 | AI Review gradient 끝점, Max plan, 모델 카탈로그 아이콘 |
| `sky` | 35 | 웹 검색 도구 |
| `violet` | 24 | Deep Research 도구 |
| `cyan` | 15 | AI Review gradient 시작점 |
| `teal` | 11 | 계정 identity avatar |
| `indigo`·`fuchsia`·`rose` | 0 | 미사용 |

`blue`와 `zinc`는 기본 인상(primary action·중립 표면)이며 이 표에서 제외했습니다.

## 2. 역할별 사용처

| 역할 | 현재 accent | 확인된 파일 |
|---|---|---|
| AI Review (교차검토) | `cyan-*` → `purple-*` gradient | `ComparisonReviewDialog.tsx`, `ModelSelectionBadge.tsx`, `ComparisonActionRail.tsx`, `AiReviewDemo.tsx` |
| Deep Research 도구 | `violet-*` | `DeepResearchSetupSheet.tsx`, `ChatInput.tsx` (tools row 아이콘) |
| 웹 검색 도구 | `sky-*` | `ChatInput.tsx` |
| 모델 카탈로그 진입점 | `purple-*` | `ModelPickerPanel.tsx` (`Boxes` 아이콘) |
| Max plan 배지 | `purple-*` | `AuthButton.tsx` |
| Pricing promotion | `emerald-*` | `PricingPageContent.tsx` |
| 계정 identity avatar | `teal-*` | `AuthButton.tsx`, `SidebarAccountRailButton.tsx` |
| 크레딧·비용 | `amber-*` | `CreditCostBadge.tsx` 및 사용처 전체 |
| 성공/오류/주의 상태 | `emerald` / `red` / `amber` | Chat state surface 전체 |

## 3. 확인된 충돌 지점

두 대안 중 어느 쪽을 택하든 아래 세 가지가 결정 대상입니다.

1. **`purple`이 세 역할을 겸함**: AI Review gradient의 끝점, Max plan 배지,
   모델 카탈로그 진입점. 같은 화면(모델 선택 sheet + 계정 메뉴)에서 동시에
   보일 수 있습니다.
2. **`emerald`가 semantic status와 promotion을 겸함**: 성공 상태와 할인
   배너가 같은 hue를 씁니다. promotion이 활성일 때 `/pricing`에서 둘이 같은
   화면에 있습니다.
3. **`violet`과 `purple`이 인접**: Deep Research(violet)와 AI Review
   gradient 끝점(purple)이 tools 메뉴에서 세로로 이웃합니다.

## 4. 결정이 필요한 두 대안 (`[DESIGN DECISION REQUIRED]`)

- **A안 — AI Review 전용 gradient**: `cyan → purple`은 AI Review에만 남기고,
  Max plan·모델 카탈로그·Deep Research는 `blue`/`zinc` 또는 비인접 palette로
  정리합니다. 장점: gradient가 하나의 기능만 의미하게 됨. 비용:
  `AuthButton`, `ModelPickerPanel`, `DeepResearchSetupSheet` 변경.
- **B안 — 역할별 semantic accent token 유지**: 현재 매핑을 그대로 두되
  `--accent-ai-review`, `--accent-deep-research`, `--accent-web-search`,
  `--accent-plan-max`, `--accent-promotion`, `--accent-account` 형태의 token과
  usage rule을 문서화하고, 신규 component가 raw utility를 추가하지 못하게
  합니다. 장점: 시각 변경 0. 비용: token 정의와 규칙 준수를 강제할 방법 필요.

두 대안 모두 `amber`(크레딧)와 `red`(오류)는 status semantic으로 고정하고
brand accent가 이를 덮지 않는다는 제약을 유지합니다.

## 5. 대비 때문에 변경한 항목 (UI-003, recolor 아님)

| 위치 | 변경 | 근거 |
|---|---|---|
| `SidebarAccountRailButton.tsx`, `AuthButton.tsx` 계정 avatar | `bg-teal-600` → `bg-teal-700` (light) | 흰색 글자 대비 실측 `3.67:1` (14px/900은 WCAG large text가 아니므로 4.5 필요). teal-700에서 통과. hue·역할 불변, dark theme는 이미 teal-700이라 변경 없음 |

이 한 건 외에 `teal`·`purple`·`emerald`·`violet`·`cyan`·`sky`의 역할이나
색상은 변경하지 않았습니다.

## 6. 다음 단계

1. 4장의 A/B 중 하나를 승인합니다.
2. 승인된 정책을 token 이름과 usage rule로 이 문서에 확정합니다.
3. 그때 비로소 TASK-009의 component 변경 ticket을 생성합니다. 승인 전 recolor는
   금지입니다.
