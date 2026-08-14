# 이미지 생성 v2 staging 검증 — 2026-08-04

> **이 문서는 2026-08-04의 관측 기록이며, 실행할 절차가 아닙니다.**
>
> 현재 절차는 `docs/ops/image-generation-staging-checklist.md`에 있습니다.
>
> 아래 §3이 남긴 항목들은 당시 사실 하나를 전제로 쓰였습니다 — "활성 이미지
> 모델이 GPT Image 2 하나뿐이므로 2개 모델 동시 요청은 Google 모델 가격 검증이
> 끝나기 전까지 실행할 수 없다". **2026-08-14에 그 전제가 사라졌습니다.**
> Nano Banana 2를 Google에 직접 호출하는 경로는 영구히 닫혔고(정책 §16), 같은
> 모델을 fal에서 이미지 단위로 사면서 활성 모델이 둘이 됐습니다. 핵심 계약인
> 멀티 모델 fan-out을 이제 실제로 검증할 수 있습니다.
>
> 전제가 바뀐 문서를 그대로 두면 절차로 읽히고, 그러면 실행할 수 없다고 적힌
> 항목이 영원히 미실행으로 남습니다. 그래서 절차는 template으로 옮기고 이
> 파일은 그날 관측한 것만 남깁니다.

읽기 전용 관측입니다. **이 문서를 만들기 위해 provider 호출을 하거나
크레딧을 사용하지 않았습니다.** 유료 실행이 필요한 항목은 §3에 사람이
실행할 절차로 남겨 두었습니다.

| | |
|---|---|
| Host | `https://staging.tomverse.app` |
| Staging SHA | `d860b7edd1c6178d05adc7691229b66cad8900e5` (PR #344 병합, `develop` tip) |
| Staging deployment | `90da8347-362e-49f7-9115-38bcb7999c5e`, SUCCESS 2026-08-04T03:49:40Z |
| 관측 시각 | 2026-08-04T03:55:56Z |

## 1. 확인된 것

### 1.1 v2 코드가 staging에 배포됨

staging의 마지막 성공 배포가 PR #344 병합 커밋입니다. 즉 멀티 모델 fan-out
API, 이미지 모델 registry, 통합 launcher, 카탈로그 `채팅 | 이미지` 탭이 모두
staging에 올라가 있습니다.

### 1.2 flag가 켜져 있음

`GET /chat`(비로그인)이 돌려준 RSC payload에 `imageGenerationEnabled: true`가
들어 있습니다. 서버가 opt-in flag를 읽어 켜진 상태로 렌더한다는 뜻입니다.

### 1.3 이미지 provider 예산이 준비 상태

`GET /api/ready` → `imageProviderBudget: true`.

staging 환경변수에 `IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY`와
`_PER_MONTH`가 설정돼 있고, `IMAGE_PROVIDER_GOOGLE_*`은 **없습니다**. 이는
정책대로입니다 — Google 모델은 가격 미검증으로 registry에서 비활성이므로
활성 provider가 아니고, 따라서 예산을 요구하지 않습니다. 보류 중인 모델이
배포를 막지 않는다는 §12 계약이 실제로 그렇게 동작하고 있습니다.

## 2. 확인 중 발견한 별개 문제 (이미지 생성과 무관)

`GET /api/ready`가 **503**입니다.

```json
{"ok":false,"checks":{"database":true,"securityEnvironment":false,
 "providerBudgets":false,"imageProviderBudget":true}}
```

이미지 쪽은 통과했고, 실패한 두 항목은 이번 작업과 관련이 없습니다.

### 2.1 `providerBudgets: false` — minimax의 채팅 provider 예산 누락

`getActiveProviders(AVAILABLE_MODELS)`가 돌려주는 활성 provider는 11개입니다:

```
openai, anthropic, google, xai, deepseek, mistral, moonshot,
minimax, qwen, zhipu, perplexity
```

staging 환경변수에는 이 중 **minimax를 제외한 10개**의
`CHAT_PROVIDER_*_COST_MICROUSD_PER_DAY`/`_PER_MONTH`만 있습니다.
`CHAT_PROVIDER_MINIMAX_COST_MICROUSD_PER_DAY`와 `_PER_MONTH`가 없습니다.

`AGENTS.md`의 계약 — "활성 provider에 `CHAT_PROVIDER_*`가 없으면
`/api/ready`가 실패한다" — 이 그대로 발동한 상태입니다. 검사는 의도대로
동작하고 있고, 빠진 것은 환경변수입니다.

**조치**: minimax 모델을 staging에서 쓸 생각이면 두 환경변수를 설정하고,
쓰지 않을 생각이면 모델을 비활성화해야 합니다. 금액은 운영 판단이라
이 문서에서 정하지 않습니다. 환경변수를 **먼저** 배포한다는 순서 규칙은
그대로 적용됩니다.

### 2.2 `securityEnvironment: false`

`getSecurityEnvironmentStatus()`가 보는 값들(NextAuth secret 강도, HTTPS
origin, OAuth token 암호화 키, maintenance secret, Turnstile, Azure OAuth
구성, 알림 채널 등)은 모두 redacted라 어느 항목이 실패했는지 외부에서
판별할 수 없습니다. Railway 콘솔에서 값을 볼 수 있는 사람이 확인해야
합니다.

두 항목 모두 이미지 생성 배포와 무관하며, 이 문서는 원인을 지목하는
데까지만 합니다.

## 3. 사람이 실행해야 하는 검증

아래는 **실제 provider 호출과 크레딧 차감이 발생**하므로 제가 하지
않았습니다. Pro 또는 Max 계정으로 staging에 로그인해 진행합니다.

### 3.1 멀티 모델 fan-out (핵심 계약)

현재 활성 이미지 모델은 GPT Image 2 하나뿐입니다. 따라서 **2개 모델 동시
요청은 Google 모델 가격 검증이 끝나기 전까지 실행할 수 없습니다.** 지금
staging에서 검증 가능한 것은 1-모델 그룹(멀티 모델의 특수 경우)까지입니다.

1-모델 그룹으로 확인할 것:

- [ ] 컴포저가 제출 **전에** 모델별 가격과 합계를 표시한다
- [ ] 제출 후 결과 카드가 target당 1개 렌더된다
- [ ] 새로고침해도 timeline이 서버에서 그대로 복원된다
- [ ] 크레딧이 예약 → 정산으로 한 번만 차감된다

토큰이 적게 드는 프롬프트 예: `a single red apple on white`

### 3.2 진입점 4곳

- [ ] 데스크톱 사이드바 split-button — 기본 클릭은 새 채팅, 캐럿에 이미지 생성
- [ ] 모바일 드로어 — 같은 메뉴가 full-size 행으로 열린다(캐럿 축소 없음)
- [ ] 컴포저 도구 메뉴 → 이미지 생성 — 작성 중 텍스트가 prompt로 이월되고,
      "채팅으로 돌아가기"가 원래 대화의 draft를 그대로 복원한다
- [ ] 모델 카탈로그 → 이미지 탭 — 채팅 목록과 분리, Nano Banana 2가
      "준비 중"으로 보이고 선택되지 않으며, GPT Image 2를 고르면 그 모델로
      workspace가 열린다

### 3.3 잠금 노출

- [ ] 비로그인(Guest) — 네 진입점 모두 보이고 잠금이 표시되며, 클릭하면
      로그인 안내로 간다
- [ ] Free 계정 — 같은 위치에서 잠금이 보이고 클릭하면 `/pricing`으로 간다.
      **prompt 입력창에 도달하지 않아야 한다**

### 3.4 재시도

실패 유도가 필요합니다(정책 위반 프롬프트로 moderation 거절). 확인할 것:

- [ ] 실패 카드에 사유와 환급이 함께 표시된다
- [ ] 재시도하면 **같은 카드가 교체**되고 항목 수가 늘지 않는다
- [ ] 성공한 target에는 재실행 버튼이 없다

### 3.5 관측

관리자 계정으로 `GET /api/admin/image-generation` 확인:

- [ ] provider별 예산 사용량이 보인다
- [ ] registry의 hold 상태(Google = `price_unverified`)가 보고된다

## 4. 남은 차단 요소

| 항목 | 상태 | 필요한 것 |
|---|---|---|
| Google(Nano Banana 2) 활성화 | 차단됨 | 공식 문서로 per-image 가격과 thinking 상한 확인 → 판매 크레딧 승인 |
| 진짜 멀티 모델(2개 이상) 검증 | 차단됨 | 위 항목이 선행 |
| production 활성화 | 대기 | staging 검증 완료 + `develop` → `main` 릴리스 + production flag |

Google 공식 가격 문서는 이 환경에서 2026-08-03 기준 HTTP 403으로 접근되지
않았고, 검색 요약은 같은 페이지에 서로 다른 금액을 귀속시켰습니다. 그래서
registry는 가격 없이 **등록-비활성**으로 두었고, 사람이 직접 확인해야
풀립니다.
