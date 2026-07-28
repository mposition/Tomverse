# Tomverse accent 역할 정책 (UI-012 / VAL-006)

> **상태: B안 승인·구현 완료.** 역할별 semantic accent token을 정의하고
> guarded component를 token으로 이관했습니다. **색상 값은 하나도 바꾸지
> 않았습니다** — 모든 token이 기존에 쓰던 Tailwind palette step을
> `var(--color-<hue>-<step>)`로 참조하므로 렌더 결과가 동일합니다.
> 유일한 색 변경은 아래 5장의 account avatar 1건이며, UI-012이 아니라
> UI-003의 WCAG AA 실패를 닫기 위한 같은 hue 내 명도 조정입니다.
>
> 규칙 본문은 `AGENTS.md`의 "Accent colour roles", 정의는
> `app/globals.css`, 강제는 `scripts/check-accent-tokens.mjs`
> (`npm run check:accent-tokens`, PR Fast Gate static 단계)에 있습니다.

기준: `origin/develop` `39194ea` 위의 작업 branch
`claude/tomverse-insight-ui-audit-3m2k1c`.

## 0. 승인된 정책 (B안)

1. 현재 시각 결과를 유지한다.
2. 역할별 semantic accent token을 정의한다.
3. `cyan → blue → purple` **전체 gradient 조합은 AI Review 전용으로 예약**한다.
4. Deep Research, Web Search, Model Catalogue, Max plan, Promotion,
   Account identity는 각각 별도 token을 쓴다.
5. 값이 같아도 역할이 다르면 token을 분리한다
   (`accent-promotion` ≠ `status-success`, `accent-model-catalogue` ≠
   `accent-plan-max`).
6. 신규 component가 raw accent utility를 추가하지 못하도록 규칙과 검증을
   문서화한다.

## 0-1. 구현 결과

| 역할 | token 접두사 | palette | 이관한 파일 |
|---|---|---|---|
| AI Review | `accent-ai-review-start\|mid\|end-*` | cyan / blue / purple·violet | `ComparisonReviewDialog`, `AiReviewDemo`, `ModelSelectionBadge`, `ComparisonActionRail` |
| Deep Research | `accent-deep-research-*` | violet | `DeepResearchSetupSheet`, `ChatInput` |
| Web Search | `accent-web-search-*` | sky | `ChatInput` |
| Model Catalogue | `accent-model-catalogue-*` | purple | `ModelPickerPanel`, `ChatInput` |
| Max plan | `accent-plan-max-*` | purple | `AuthButton` |
| Promotion | `accent-promotion-*` | emerald | `PricingPageContent` |
| Account identity | `accent-account-*` | teal | `AuthButton`, `SidebarAccountRailButton` |
| 성공·검증 상태 | `status-success-*` | emerald | `ChatInput`, `AuthButton`, `ComparisonReviewDialog` |

총 62개 token, guarded 파일 10개. AI Review의 3px gradient bar와 review surface는
이미 `--tomverse-accent-*` / `--tomverse-review-*`로 token화돼 있어 그대로 둡니다.

**시각 동일성 근거** `[테스트]` chat state golden 74개가 전부 통과합니다.
AI Review(desktop light·mobile dark), Deep Research, composer를 포함하므로
이관한 색이 렌더 단계에서 바뀌지 않았음을 pixel 수준에서 확인한 것입니다.
(모바일 golden 6장은 `develop`의 `7cd1367` 헤더 레이아웃 변경 때문에
재생성했고, 색이 아니라 세로 배치가 달라진 것을 diff로 확인했습니다.)

**검증 방법** `npm run check:accent-tokens`가 guarded 파일에서
① raw accent utility, ② 등록되지 않은 역할 이름, ③ token 정의 누락,
④ AI Review 외 component의 `accent-ai-review-*` 사용을 각각 실패로 처리합니다.

## 1. 전체 사용량 (이관 전 기준)

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

## 6. 남은 범위

guarded 목록은 역할이 token으로 옮겨진 파일만 담고 있습니다. 아직 대상이 아닌
것:

- admin console 패널의 accent (역할 정의가 없고 소비자 화면이 아님)
- `red` / `amber` 상태 색 (별도 관례로 이미 일관됨)
- `blue` / `zinc` 기본 인상 (accent가 아님)

이들을 넣으려면 역할 정의가 먼저이고, 그 다음 token, 그 다음 guarded 목록
확장입니다. 순서를 바꾸면 검사가 의미를 잃습니다.
