# iOS·Android Native 앱 준비도 스파이크 (2026-08-30)

- 대상: `mposition/Tomverse` `develop`
- **기준 커밋: `b760383`** (rev.3). Voice Input MVP가 이 커밋까지 병합 완료입니다.
  초판 조사는 `96f012b`에서 시작했고, 이후 `be5aebe` → `8cd3e5e` → `4635eb7` →
  `b760383`을 차례로 병합했습니다. **§1의 성숙도, §2의 수치, §11의 검증은 전부
  `b760383` 트리에서 다시 측정·재실행한 값입니다** — 옮겨 적은 값이 아닙니다.
- 목적: 스토어 출시 앱 구현이 아니라, **Capacitor 로컬 번들 Native 앱으로 전환할 준비가 어디까지 되어 있는지**를 코드와 실행 증거로 확인하고 작업량을 산정하는 것
- 근거 문서: `docs/policy/tomverse-chat-delivery-plan.md`, `docs/policy/shared-packages.md`,
  `docs/policy/tomverse-chat-mobile-authentication.md`, `docs/policy/chat-concurrency-and-identity.md`,
  `docs/ops/tomverse-chat-store-review.md`, `docs/release-gates/tomverse-chat-v1.yaml`
- 플랫폼 사양 근거: Capacitor 8.5.0 배포 패키지 자체(`@capacitor/cli`·`ios`·`android`),
  `developer.apple.com`, `developer.android.com`. 블로그·요약·3자 집계는 근거로 쓰지 않았습니다.

> **이 문서가 주장하지 않는 것.** 실행한 검증은 §11에 전부 나열했습니다. iOS 빌드,
> 실기기 동작, Android Gradle 빌드는 **하나도 실행하지 않았고 통과로 기록하지 않았습니다.**
> 이 컨테이너는 Linux이고 Xcode도 Android SDK도 없습니다.

## 개정 이력

**rev.3 (2026-08-30, 기준 `b760383`)** — 설계 교정이 아니라 **최신성 갱신**입니다.
rev.2 승인 뒤 Voice Input MVP가 병합돼 여섯 가지 사실이 바뀌었습니다.

| # | rev.2 | `b760383` 기준 | 고친 곳 |
|---|---|---|---|
| 1 | 기준 커밋 `96f012b`/`be5aebe` | `b760383` | 머리말 |
| 2 | "`getUserMedia` 0건", "Voice 진행 중" | Voice **병합 완료**. `getUserMedia`·`MediaRecorder` 실제 사용 | §1의 23번, §12 |
| 3 | 마이크 성숙도 **M0** | **M3**(웹 구현, flag default-off) / **M0**(Native 권한·실기기) | §1의 23번 |
| 4 | 단위 테스트 6,960 pass | **7,051 pass** (두 lane 합계, 재실행) | §11.4 |
| 5 | seed 2차 192줄 = "Voice 병합 후 **대기**" | **착수 가능** — 최신 변경 파일 재대조가 조건 | §7.2 |
| 6 | `chat-ui`가 Voice를 기다림 | Voice 선행 조건 **충족**. 남은 것은 N5·N6·N1b | §6, §7.3 |

`b760383`에서 새로 생긴 사실 둘도 반영했습니다 — Voice가 **port 주입 패턴의 실제
선례**(`lib/voiceTranscriptionPort.ts` + `…PortCore.ts`)를 남겼고(§2.3),
framework-neutral한 순수 모듈 **1,197줄**이 추가로 존재합니다(§2.2).

**rev.2 (2026-08-30)** — N0은 승인됐고, 검토에서 지적된 네 가지와 수치 하나를 고쳤습니다.
전부 초판이 틀렸던 것이므로 지운 것이 아니라 무엇이 왜 틀렸는지를 남깁니다.

| # | 초판 | 무엇이 틀렸나 | 고친 곳 |
|---|---|---|---|
| 1 | "`Authorization: Bearer`로 인증된 요청은 별도 경로로 판정" | **헤더의 존재**와 **토큰의 검증**을 구분하지 않았습니다. `proxy.ts`는 route보다 먼저 돌고 그 자리에 검증기가 없으므로, 가짜 헤더 한 줄이 CSRF 검사를 끄는 스위치가 됩니다 | §3.1을 N1a / N2 / N1b로 분리 |
| 2 | N2를 "지금 병렬 가능"으로 분류 | 모바일 인증 정책이 아직 **`draft for Phase 0 approval`** 입니다. 설계·테스트 벡터는 지금 가능하지만 migration과 토큰 발급은 승인 뒤입니다 | §6.1, N2-설계 / N2-구현 분리 |
| 3 | `chat-core` seed 804줄 전체를 "Voice와 무관" | `chatAttachmentErrorCopy`·`chatCreditAllocation`·`chatKeyboardPolicy`가 **`ChatInput.tsx`를 지납니다** | §7.2, 1차 612줄 / 2차 192줄 분리 |
| 4 | AASA·`assetlinks.json`을 "파일 배포일 뿐" | 최종 Bundle/Application ID·Apple Team ID·**서명 인증서 SHA-256 fingerprint**·entitlement가 전부 미정입니다. `appId: "app.tomverse.shell"`은 스파이크 식별자입니다 | §7.1, N4a / N4b 분리 |
| 5 | 단위 테스트를 "6,892 pass"로 보고 | 그것은 server lane의 **`tests`** 수이고 pass는 6,891이었으며, client lane 33건을 더하지 않았습니다 | §11.4 (합계 표) |

4번에 따라 `apps/mobile/capacitor.config.ts`의 `appId`에 잠정 식별자임을 명시하는 주석을
달았습니다.

---

## 0. 한 문단 요약

플랫폼과 서버는 준비돼 있고, **클라이언트 경계가 준비돼 있지 않습니다.** 라우팅·크레딧·
첨부·생성 파일·계정 삭제·데이터 내보내기 같은 서버 계약은 이미 성숙해서 Native가 그대로
씁니다. 반면 Native가 **자기를 증명하는 방법**(bearer token, device family, CORS,
딥링크)은 스키마에 행 하나 없이 전부 M0이고, **화면을 그리는 코드**(`chat-ui`,
`api-client`)도 존재하지 않습니다. 그 사이에서 오늘 확인된 가장 구체적인 사실은
`lib/requestOrigin.ts`가 Capacitor의 두 origin 중 어느 것도 받지 않아 **Native의 모든
비-GET 요청이 라우트에 닿기 전에 403 `INVALID_REQUEST_ORIGIN`으로 거절된다**는
것입니다(§3.1).

**rev.3 시점의 착수 상태**: Voice Input MVP가 `b760383`에서 병합돼 UI 계열 대기가 풀렸고,
지금 막혀 있지 않은 작업은 다섯입니다 — N1a(CORS·`OPTIONS`), N2-설계(승인 패킷),
`chat-core` seed 804줄, N4a(딥링크 형식·도구), PRIVACY 미결정 2건. 우선순위는
**N1a → N2-설계**입니다(§7.3).

그 문제를 푸는 순서가 이 보고서에서 가장 틀리기 쉬운 부분이고, 초판이 실제로 틀렸습니다.
`Authorization` 헤더가 **있다는 이유로** CSRF 검사를 건너뛰면, `proxy.ts`가 route보다 먼저
도는 이상 아무 값이나 담은 헤더 한 줄이 edge 보안 계층 전체를 끄는 스위치가 됩니다. 그래서
CORS(N1a)와 **검증된** bearer identity의 대체 경로(N1b)를 나누고, N1b는 토큰 검증기(N2)
뒤에 둡니다 — §3.1.

---

## 1. 기능별 성숙도 M0~M5

척도: **M0** 없음 · **M1** 결정만 있음(문서) · **M2** 부분 구현 · **M3** 구현됨(웹 기준)
· **M4** Native 경로까지 구현·검증 · **M5** 실기기 증거로 게이트 통과

| # | 영역 | 성숙도 | 근거 |
|---|---|---|---|
| 1 | 서버 chat 오케스트레이션·스트리밍 | **M3** | `app/api/chat/route.ts` 5,909줄, keepalive·idle timeout·취소·정산 전 경로 존재 |
| 2 | 동시 실행·admission·rate limit | **M3** | `lib/chatConcurrencyCore.ts`·`chatAdmissionCore.ts`, all-or-nothing preflight |
| 3 | 크레딧 예약·정산·guardrail | **M3** | `docs/policy/credit-and-cost-limits.md` 계약이 코드로 강제됨 |
| 4 | 계정 데이터 내보내기 | **M3** | `lib/accountDataExport*.ts`, 단발성 티켓·step-up·감사 |
| 5 | 인앱 계정 삭제 | **M3** | `app/api/user/account/route.ts` DELETE + `AuthButton.tsx` 확인 문구 |
| 6 | data-domain registry | **M2** | 58 도메인 등록, **2개가 `unverified`** (§3.4) |
| 7 | 공유 package (`chat-core`·`ui-tokens`) | **M3** | PACKAGE-01 approved. 단 범위는 이 두 개까지 |
| 8 | 모바일 웹 레이아웃 (`MobileChatShell`) | **M3** | 1,752줄, 3개 UI 계약이 회귀를 고정 |
| 9 | OAuth2 + PKCE 클라이언트 | **M2** | `lib/oauthLink.ts`가 이미 자체 PKCE 구현 — **재사용 가능** |
| 10 | 이메일 OTP·매직링크 | **M3**(웹) / **M0**(bearer 교환) | `lib/emailLogin.ts`는 쿠키만 발급 |
| 11 | `chat-ui` package | **M0** | 트리에 없음 |
| 12 | `api-client` package | **M0** | 트리에 없음 |
| 13 | `apps/mobile` 셸 | **M1→M2** | 이번 스파이크로 최소 scaffold 생성(§11) |
| 14 | mobile bearer token lifecycle | **M0** | Prisma 116개 model 중 refresh/device 관련 **0개** |
| 15 | refresh 회전·재사용 탐지·token family | **M0** | 코드·스키마 어디에도 없음 |
| 16 | 기기 목록·기기별 해제 | **M0** | `sessionRevocationCore.ts`는 계정 전체 revocation만 |
| 17 | explicit CORS allowlist | **M0** | `Access-Control-Allow-Origin` 문자열이 저장소에 **0건** |
| 18 | Sign in with Apple | **M0** | provider는 Google·AzureAD·Credentials 셋뿐 |
| 19 | Universal Link / App Link | **M0** | `public/.well-known/`에 microsoft 파일 1개뿐. 식별자도 미확정(§7.1) |
| 20 | 스토어 심사 자격증명 lifecycle | **M1** | `docs/ops/tomverse-chat-store-review.md`는 완성, 구현 0 |
| 21 | 백그라운드·포그라운드 전환 | **M0** | `visibilitychange`·`pagehide` 처리 **0건** — Voice 녹음기도 다루지 않습니다 |
| 22 | 파일 선택 | **M3**(웹) | `<input type="file">` — WebView에서 그대로 동작 |
| 23a | **마이크 (웹)** | **M3** | Voice Input MVP 병합 완료. `navigator.mediaDevices.getUserMedia` + `MediaRecorder` 실사용(`components/chat/useVoiceRecorder.ts`). 단 rollout flag는 default-off이고 production 활성화는 `docs/policy/voice-input.md` §14가 별도로 막습니다 |
| 23b | **마이크 (Native 권한·실기기)** | **M0** | `NSMicrophoneUsageDescription`·`RECORD_AUDIO` 선언 없음. 네이티브 프로젝트 자체가 없고, Voice 정책 §1이 native를 명시적으로 범위 밖으로 둡니다 |
| 23c | 카메라 | **M0** | 사용처 없음 |
| 24 | Google Drive 첨부 | **M3**(웹) / **M0**(Native) | GIS 토큰 클라이언트가 WebView origin을 등록할 수 없음(§3.3) |
| 25 | PWA (manifest·SW) | **M0** | manifest·service worker 모두 없음 |
| 26 | 개인정보 표시·스토어 메타데이터 | **M0** | 산출물 없음 |
| 27 | Sentry 기기·토큰 노출 방어 | **M3** | 브라우저 SDK 미초기화, `sendDefaultPii: false` (§4.2) |
| 28 | Native CI | **M0** | 워크플로에 native 빌드 job 0개 |

**M4 이상은 하나도 없습니다.** 실기기에서 확인된 항목이 아직 존재하지 않기 때문입니다.

---

## 2. 재사용 가능 코드와 추출이 필요한 코드

### 2.1 그대로 재사용 (서버)

API 189개 라우트와 그 뒤의 정책 계층 전부입니다. Native는 **전송 방식만 다른 같은 서버**를
쓰며, 라우팅·크레딧·moderation·첨부 검증을 다시 만들지 않습니다. 이것이 이 스파이크에서
가장 큰 자산입니다.

### 2.2 포트 없이 지금 옮길 수 있는 것

`lib/chat*.ts`·`lib/comparison*.ts` 중 **`@/` alias도, framework import도, 브라우저/Node
전역도, `process.env`도 쓰지 않는** 모듈을 실제로 세었습니다. 그중 클라이언트가 실제로
import하는 것만 추리면 다음 8개(합 **804줄**)이고, 이것이 `chat-core` 다음 seed입니다.

| 모듈 | 줄 | client | server |
|---|---:|---:|---:|
| `lib/comparisonReadiness.ts` | 212 | 3 | 2 |
| `lib/chatCostSafetyCore.ts` | 147 | 2 | 6 |
| `lib/chatModelSummary.ts` | 110 | 1 | 0 |
| `lib/chatRuntimeStatus.ts` | 107 | 3 | 0 |
| `lib/chatAttachmentErrorCopy.ts` | 92 | 1 | 1 |
| `lib/chatCreditAllocation.ts` | 56 | 2 | 5 |
| `lib/chatKeyboardPolicy.ts` | 44 | 3 | 0 |
| `lib/comparisonReviewCost.ts` | 36 | 1 | 0 |

`comparisonReadiness.ts`는 UI 계약(`docs/ui-contracts/comparison-action-rail.md`)이
"desktop과 mobile이 같은 함수로 판정한다"를 이미 강제하고 있으므로, 세 번째 클라이언트가
생겨도 그 계약이 그대로 따라옵니다 — 옮길 이유가 가장 분명한 모듈입니다.

#### rev.3 추가 — Voice가 순수 모듈 1,197줄을 더 남겼습니다

`b760383`에서 같은 기준(주석 제거 후 alias·framework import·전역·`process.env` 없음)으로
다시 세면 Voice 모듈 여섯 개가 통과합니다.

| 모듈 | 줄 | 쓰는 곳 |
|---|---:|---|
| `lib/voiceClipDuration.ts` | 417 | server (컨테이너 파싱) |
| `lib/voiceRecorderMachine.ts` | 348 | client ×2 |
| `lib/voiceInputFormats.ts` | 172 | **client ×3 + server ×4** |
| `lib/voiceInputGuardrails.ts` | 127 | server ×2 |
| `lib/voiceTranscript.ts` | 72 | **client ×1 + server ×1** |
| `lib/voiceInputErrorCopy.ts` | 61 | client ×1 |
| **합계** | **1,197** | |

**이 보고서는 이것들의 이관을 제안하지 않습니다.** 두 가지 이유입니다. Voice의 production
활성화가 `docs/policy/voice-input.md` §14의 B-1~B-6에 막혀 있어 아직 움직이는 표면이고,
`chat-core`의 seed 기준은 `docs/policy/shared-packages.md` §7.4의 "이미 공유된 코드를
옮긴다"입니다 — 여섯 중 그 기준을 확실히 만족하는 것은 client와 server가 함께 쓰는
`voiceInputFormats`(172)와 `voiceTranscript`(72) 둘입니다.

기록하는 이유는 하나입니다. **`voiceRecorderMachine.ts`는 전역을 하나도 쓰지 않는 348줄짜리
상태 기계**이고, 그것은 `chat-core`가 존재하는 이유 그 자체의 형태입니다 — 다음에 seed 범위를
넓힐 때 후보 목록이 `chat*`에서 끝나지 않는다는 사실을 여기 남겨 둡니다.

### 2.3 포트가 필요한 것 (전역을 쓰는 스트리밍 코어)

`chat-core`의 tsconfig는 `lib: ["ES2022"]`·`types: []`라 `window`·`TextDecoder`·`fetch`가
**해석되지 않는 식별자**입니다. 이것은 버그가 아니라 §4.2가 의도한 두 번째 그물이므로,
아래 모듈은 "옮기기"가 아니라 "포트를 설계해서 옮기기"입니다.

| 모듈 | 줄 | 필요한 포트 |
|---|---:|---|
| `lib/chatStreamLiveness.ts` | 352 | timer, `AbortController`, transport |
| `lib/chatContentState.ts` | 214 | storage (`localStorage` → Capacitor Preferences) |
| `lib/chatStreamConsumer.ts` | 185 | text decoder |
| `lib/chatIdentityNamespace.ts` | 121 | storage |
| `lib/chatStreamRuntime.ts` | 500 | storage + `AbortController` (단 `components/chat/types` 의존) |

`chatStreamRuntime.ts`가 `@/components/chat/types`를 import한다는 점이 중요합니다 — 즉
**메시지 타입 자체가 먼저 package로 가야** 스트림 런타임이 갈 수 있습니다. 이것이
`chat-core` 확장의 실제 임계 경로입니다.

#### rev.3 추가 — 포트 패턴의 선례가 저장소 안에 생겼습니다

초판을 쓸 때 "포트를 설계해서 옮긴다"는 이 저장소에 사례가 없는 추상적 계획이었습니다.
`b760383`에는 있습니다.

```
lib/voiceTranscriptionPortCore.ts   225줄  결정 전부 — 요청 모양, 실패 분류, 허용 응답
lib/voiceTranscriptionPort.ts        90줄  `server-only`. process.env를 넣어 주기만 함
```

`voiceTranscriptionPort.ts`의 주석이 분담을 직접 적습니다 — *"every decision … lives in
`lib/voiceTranscriptionPortCore.ts`, and this file supplies `process.env` and nothing else."*
그리고 그 형태를 `lib/emailProviderPort.ts`에서 가져왔다고 밝힙니다. 즉 이 저장소에는 이제
**같은 패턴의 구현이 둘** 있습니다.

storage·timer·transport 포트를 설계할 때 새 규약을 발명하지 말고 이 둘을 따릅니다. 다만
§4.3의 제약은 그대로입니다 — **토큰 저장과 대화 상태 저장은 서로 다른 포트**여야 하며,
하나로 합치면 refresh token이 `localStorage`에 들어가는 길이 열립니다.

### 2.4 옮기면 안 되는 것

- `components/chat/ChatInput.tsx` (4,601줄), `ChatPageClient.tsx` (6,820줄),
  `ChatApp.tsx` (약 1,800줄). 계획서 §4가 "전체 composer와 IME/view 동작을 한 번에 core로
  옮기지 말라"고 명시합니다. 이번 스파이크에서도 복제하지 않았습니다.
- `lib/chatAdmissionCore.ts`(`Buffer`·`crypto`), `lib/chatConcurrencyCore.ts`(`process.env`).
  둘 다 서버 판정이며, 클라이언트가 알면 안 되는 값을 다룹니다.

### 2.5 UI 재사용 범위

`components/chat`는 60개 파일·26,414줄이고 그중 `next/*`를 import하는 것은 **10개뿐**입니다.
`MobileChatShell.tsx` 자체는 `next/*`를 **직접 쓰지 않습니다.** 즉 `chat-ui` 추출의 장애물은
프레임워크 결합이 아니라 **`@/` alias를 통한 앱 루트 의존**이고, 이는 기계적이지만 넓은
작업입니다(모든 import 경로가 바뀝니다).

---

## 3. Blocking gate와 non-blocking 항목

`docs/release-gates/tomverse-chat-v1.yaml`은 40개 게이트 **전부 blocking**이고 39개가
`pending`입니다(PACKAGE-01만 approved). Native에 직접 걸리는 것은 다음 9개입니다.

| Gate | 상태 | 오늘 무엇이 없는가 |
|---|---|---|
| AUTH-01 | pending | Apple provider·link/unlink·token revoke 전부 없음 |
| AUTH-02 | pending | bearer 교환 엔드포인트 없음, 심사 코드 없음 |
| AUTH-03 | pending | refresh·family·재사용 탐지·기기 해제 전부 없음 |
| AUTH-04 | pending | CORS allowlist 없음, AASA/assetlinks 없음 |
| PRIVACY-01 | pending | 삭제는 구현됨. `unverified` 2건이 남아 metric ≠ 0 |
| PRIVACY-02 | pending | 내보내기는 구현됨. 같은 2건이 export state `unverified` |
| STORE-01 | pending | clean-device E2E 없음 |
| STORE-02 | pending | 심사 자격증명·일일 synthetic login 없음 |
| UI-02 | pending | "native-shell E2E report"를 만들 셸이 없었음 |
| PUSH-01 | pending(부재로 충족) | `check:push-scope` 통과 — **건드리지 않는 것이 통과 조건** |

### 3.1 가장 구체적인 blocker — Native origin이 CSRF 검사에 막힌다

`proxy.ts`가 모든 비-GET 요청에 `hasValidMutationOrigin()`을 걸고, 그 함수는
`lib/requestOrigin.ts:29`에서 **`http:`/`https:` 이외의 protocol을 즉시 버립니다.**
그다음 `isAllowedRequestHost()`가 `localhost`를 명시적으로 제외합니다
(`lib/originProtection.ts` `isLocalHost`).

Capacitor 8.5.0이 실제로 만드는 origin은 패키지 선언에서 직접 읽었습니다.

| 플랫폼 | 옵션 | 기본값 | origin |
|---|---|---|---|
| iOS | `server.iosScheme` | `capacitor` | `capacitor://localhost` |
| Android | `server.androidScheme` | `https` | `https://localhost` |

- `capacitor://localhost` → protocol에서 탈락.
- `https://localhost` → host allowlist에서 탈락.
- `Sec-Fetch-Site` 대체 경로도 안 됩니다. WebView에서 API 호출은 cross-site이므로
  `same-origin`이 아닙니다.

**결론: 오늘 Native 셸을 만들면 `POST /api/chat`도, 첨부 준비용 `PUT /api/chat`도
`proxy.ts`의 `blockedMutationOriginResponse()`에서 403 `INVALID_REQUEST_ORIGIN`을
받습니다.** (호스트 allowlist 위반의 421 `Misdirected Request`와는 다른 검사입니다 —
Native는 `Host: tomverse.app`로 보내므로 호스트 검사는 통과하고 origin 검사에서 걸립니다.) 이것은 CORS를 추가하기 *전에* 풀어야 하는 별개
문제입니다 — CORS는 브라우저가 응답을 읽게 해 주는 것이고, 이쪽은 서버가 요청을 아예
받지 않는 것입니다.

#### 고치는 순서 — 헤더의 *존재*로 검사를 건너뛰지 않는다

**초판의 이 문단은 틀렸습니다.** 원문은 "`Authorization: Bearer`로 인증된 요청은 CSRF
대상이 아니므로 별도 경로로 판정한다"였는데, 이 문장은 **헤더가 있다는 사실**과 **토큰이
검증됐다는 사실**을 구분하지 않습니다. `proxy.ts`는 route보다 먼저 돌고 그 자리에는 토큰
검증기가 없으므로, 그렇게 구현하면 아무 값이나 담은 `Authorization: Bearer x` 한 줄이
mutation-origin 검사 전체를 끄는 스위치가 됩니다.

이것은 새로운 통찰이 아니라 **이 파일이 이미 적어 둔 규칙**입니다. `proxy.ts`의 prefetch
분기 주석이 같은 말을 합니다 — *"gating those on request headers would let any caller opt
out of the entire edge security layer."* 그 규칙이 prefetch에 적용되는 이유가 bearer에는
적용되지 않을 이유가 없습니다.

그래서 하나의 작업을 셋으로 나눕니다.

| 단계 | 하는 일 | 검증된 토큰이 필요한가 |
|---|---|---|
| **N1a** | 두 origin literal에 대한 CORS 응답과 **`OPTIONS` preflight 처리**, hostile origin 거절 | 아니오 |
| **N2** | bearer 발급·검증·회전·family·재사용 탐지 | — (여기서 만듭니다) |
| **N1b** | **검증된** bearer identity에 한해 mutation-origin 검사를 대체하는 경로 | 예 |

**N1b는 N2 뒤입니다.** 검증기가 없는 동안에는 "대체할 자격"을 판정할 방법이 없고, 판정할
수 없는 것을 통과시키는 코드가 곧 우회로입니다. 순서를 지키면 최악의 중간 상태가
"Native가 아직 mutation 요청을 못 보낸다"이고, 순서를 어기면 최악의 중간 상태가
"누구나 CSRF 검사를 끌 수 있다"입니다.

N1a가 N2 없이 먼저 갈 수 있는 이유는 CORS가 **다른 질문에 답하기 때문**입니다. CORS는
브라우저에게 응답을 읽어도 되는지 알려 주는 것이고 서버의 수락 여부와 무관합니다. 그리고
지금 `OPTIONS`는 `lib/requestOrigin.ts`의 `SAFE_METHODS`에 있어 검사를 통과하지만
**저장소 전체에 `OPTIONS` 핸들러가 0개**이므로, preflight가 CORS 헤더 없는 응답을 받습니다.
N1a는 그 구멍을 메우는 일이며 bearer와 무관합니다.

N1b를 설계할 때의 계약: 대체 조건은 "헤더가 있다"가 아니라 **"토큰 서명·만료·subject
결속이 검증됐고, 그 identity가 이 요청의 주체다"** 입니다. 검증을 proxy에서 할지 route에서
할지는 열린 결정이고, edge에서 검증하려면 서명 검증이 Edge runtime에서 가능해야 합니다 —
`lib/chatAdmissionCore.ts`가 `Buffer`·`node:crypto`를 쓰는 것과 같은 제약이 걸립니다.
쿠키 요청의 mutation-origin 검사는 어느 쪽에서도 **완화하지 않습니다.**

### 3.2 게스트 쿠키는 Native에서 전달되지 않는다

`lib/chatSecurity.ts:852`의 게스트 쿠키는 `HttpOnly; SameSite=Lax`입니다. Lax 쿠키는
cross-site 요청에 실리지 않으므로, WebView에서는 `access.subjectKey`가 매 요청 새로
만들어집니다. `docs/policy/chat-concurrency-and-identity.md` §2가 정확히 이 값을 동시 실행
scope로 정했으므로, **Native 게스트는 동시 실행 한도와 rate limit이 모두 무너집니다.**
게스트 subject를 헤더로 옮기는 결정이 필요하며, 이는 서명 검증 로직 재사용으로 충분합니다
(`signGuestId`는 그대로 씁니다).

### 3.3 Google Drive 첨부는 Native에서 성립하지 않는다

`components/chat/ChatInput.tsx:2534`가 `accounts.google.com/gsi/client`를 WebView 안에
로드해 `initTokenClient`로 access token을 받습니다. Google Identity Services는 **승인된
JavaScript origin**을 요구하는데 `capacitor://localhost`는 Google Cloud Console에 등록할 수
있는 형식이 아니고, 임베디드 WebView OAuth는 설치형 앱 지침에도 어긋납니다
(정책 문서가 이미 "system browser + PKCE"로 결정한 이유와 같습니다).

선택지는 둘뿐입니다. (a) Native에서 Drive 행을 잠금 상태로 노출하고 이유를 말한다,
(b) Drive 선택을 system browser + 서버 측 파일 가져오기로 재설계한다. **(a)가 v1의
정답**입니다 — `canConnectGoogleDrive` 플래그가 이미 존재하고 게스트에게 잠금 UI를
그리는 경로가 있으므로, 재사용하면 S 규모입니다.

### 3.4 PRIVACY-01/02는 코드가 아니라 결정 2건에 막혀 있다

`npm run check:data-domain-registry` 실행 결과(병합 후):

```
OK docs/policy/tomverse-chat-data-domain-registry.yaml: 58 data domains, all user-linked models registered.
   Deletion action: 42 delete, 9 anonymise, 2 unverified, 5 retain.
   2 domain(s) have an unverified deletion path and 2 an unverified export state
```

도메인 수는 병합으로 55에서 58로 늘었지만 **`unverified`는 여전히 정확히 2건**입니다 —
새 테이블이 조용히 빠져나가지 못한다는 registry의 약속이 실제로 지켜지고 있다는 뜻이고,
동시에 이 2건이 새 작업이 아니라 **오래 남아 있는 결정 공백**이라는 뜻입니다.

두 도메인은 `FeedbackLifecycleEvent`와 `RefundRequestTimelineEvent`이고, registry의 note가
무엇이 미결인지 이름을 댑니다 — 전자는 `userReply` 스냅샷과 운영자 `actorUserId`의 처리,
후자는 `actorEmail`의 익명화 여부와 금융 분쟁 기록의 보존 기간입니다. **후자는
finance-ops 결정이지 스키마 문제가 아닙니다.** Native가 이 둘을 만들지 않았고, Native
때문에 늘어나지도 않지만, **PRIVACY-01/02가 blocking이므로 스토어 제출 전에 반드시
닫혀야 합니다.** 코드 작업이 아니라 결정 작업이므로 지금 병행할 수 있습니다.

### 3.5 non-blocking (틀려도 고쳐서 배포하면 되는 것)

AGENTS.md "검증 범위는 되돌릴 수 없는 것에 비례합니다"의 기준을 그대로 적용합니다.

- 라벨·문구·아이콘·스플래시·탭 배치
- PWA manifest·오프라인 셸 (Native와 독립)
- Drive 잠금 문구의 표현
- 셸의 안전영역 여백, 다크 모드 세부

**차단인 것**: 토큰 유출·재사용 탐지 부재·딥링크 탈취·기기 해제 불가·계정 삭제 누락.
전부 "고쳐서 배포"로 회수되지 않습니다.

---

## 4. 보안·개인정보·스토어 심사 위험

### 4.1 도입되는 새 공격면 (AUTH-04)

정책 문서가 이미 둘로 좁혀 두었고, 이번 조사에서 그 둘 다 **오늘 방어가 0**임을
확인했습니다.

- **CORS.** 저장소 전체에 `Access-Control-Allow-Origin`이 한 번도 나오지 않습니다.
  Native를 위해 origin을 열 때 `*`나 origin reflection을 쓰면, bearer 엔드포인트가 임의
  페이지에 열립니다. allowlist는 `capacitor://localhost`와 `https://localhost` **두 값
  literal**이어야 하고, `credentials`를 켜면 안 됩니다(bearer는 쿠키가 필요 없습니다).
- **딥링크 탈취.** `public/.well-known/`에 AASA도 `assetlinks.json`도 없습니다. Android
  공식 문서는 `autoVerify="true"`가 `http`/`https` scheme만 검증하고, 검증 실패 시
  Android 12+에서는 기본 핸들러가 되지 않는다고 명시합니다 — 즉 **custom scheme만으로는
  어떤 암호학적 소유 증명도 없습니다.** OAuth 반환을 custom scheme으로 받으면 같은
  scheme을 선언한 다른 앱이 코드를 가져갑니다.

### 4.2 진단 로그·Sentry (현재는 낮은 위험)

- 브라우저 Sentry SDK는 **초기화돼 있지 않습니다.** `instrumentation-client.ts`는 zod
  `jitless` 설정만 합니다. 서버·edge만 `sendDefaultPii: false`로 초기화됩니다.
- 따라서 오늘은 기기 식별자·토큰이 Sentry로 갈 경로 자체가 없습니다.
- **위험은 미래형입니다.** Native에서 crash reporting을 켜는 순간 device ID·OS 버전이
  기본 수집되고, Apple 개인정보 표시에서 "Identifiers → Device ID"를 선언해야 합니다.
  `Authorization` 헤더가 breadcrumb에 실리지 않도록 `beforeBreadcrumb` 스크러빙을
  **켜는 시점에 함께** 넣어야 합니다.
- 기존 `lib/traceErrorEvidence.ts`의 provenance 구분
  (`docs/policy/trace-feedback-automation.md`)이 Native에서도 그대로 유효합니다 — 앱이
  보낸 Trace ID는 `client_supplied`이지 인증 수단이 아닙니다.

### 4.3 저장 위치

정책이 못 박은 대로 refresh token은 Keychain/Keystore이고 `localStorage`가 아닙니다.
그런데 **현재 클라이언트는 대화 상태를 `localStorage`에 씁니다**(`chatContentState.ts`,
`chatIdentityNamespace.ts`, `chatStreamRuntime.ts`). 이 세 파일이 storage 포트로 가는 순간
"어느 저장소인가"가 주입값이 되므로, **토큰과 대화 상태가 같은 포트를 쓰지 않도록**
포트를 두 개로 나눠 설계해야 합니다. 하나로 만들면 토큰이 `localStorage`에 들어가는 길이
열립니다.

### 4.4 스토어 심사 (Apple 공식 문구 기준)

`developer.apple.com/app-store/review/guidelines/`에서 직접 확인한 것:

- **4.8**: 제3자/소셜 로그인으로 기본 계정을 만들면, 이름·이메일만 수집하고 이메일 비공개를
  허용하며 광고 목적 상호작용을 수집하지 않는 **동등한 로그인**을 함께 제공해야 합니다.
  현재 Google 로그인이 있으므로 **4.8이 적용되고**, Sign in with Apple(또는 동등물)이
  필요합니다. 이메일 OTP/매직링크가 동등물로 인정되는지는 심사 판단 영역이며, 이 저장소가
  단독으로 답할 수 없습니다 — 그래서 `AUTH-01`이 blocking입니다.
- **5.1.1(v)**: 계정 생성을 지원하면 **앱 안에서 계정 삭제를 제공해야** 합니다. 서버 경로는
  이미 있습니다(§1의 5번). Native에서 그 화면에 도달할 수 있는지가 남은 일입니다.
- **2.5.2**: 앱은 번들 안에서 자족해야 하고, 기능을 도입·변경하는 코드를 내려받아 실행하면
  안 됩니다. **이것이 `server.url` 금지의 심사 측 근거**이고, 이번에 게이트를
  만들었습니다(§11).
- **5.1.2(i)**: 개인 데이터를 **third-party AI와 공유하는 경우 명시적으로 공개하고 동의를
  받아야** 합니다. 이 앱의 본질이 여러 provider에 사용자 텍스트를 보내는 것이므로,
  개인정보 표시와 앱 내 고지가 **선택이 아니라 요건**입니다.

Android 쪽에서 확인한 것: Google Play는 **2026-08-31부터 신규 앱과 업데이트에 targetSdk
36(Android 16)** 을 요구합니다. Capacitor 8.5.0의 기본값이 이미 `targetSdk 36`이므로
override가 필요 없습니다.

### 4.5 심사 계정 (STORE-02)

`docs/ops/tomverse-chat-store-review.md`는 완성된 운영 문서이고 구현은 0입니다. 문서가 스스로
경고하는 부분을 그대로 옮깁니다: **제출 빌드 식별자 주장은 클라이언트가 하는 것이므로
격리 보증이 아니며**, 실제로 막는 것은 해시 저장된 코드·계정 결속·시도 제한·종료 상태
revoke입니다. `AUTH-02` 증거에서 build binding을 하드 경계로 제시하면 안 됩니다.

---

## 5. 기능별 예상 크기 S/M/L/XL

기준: **S** ≤2일 · **M** 3~5일 · **L** 1.5~3주 · **XL** 3주 초과. 1인 기준, 검증 포함.

| 작업 | 크기 | 비고 |
|---|---|---|
| `apps/mobile` 로컬 번들 scaffold | **S** | *이번에 완료* (§11) |
| `chat-core` 무-포트 seed 1차 5모듈(612줄) | **S** | Voice와 겹치지 않음 (§7.2) |
| `chat-core` seed 2차 3모듈(192줄) | **S** | **Voice 병합 후** — `ChatInput.tsx` 경유 |
| storage / timer / transport 포트 설계 | **M** | 토큰용과 상태용을 분리하는 것이 핵심 |
| 메시지 타입 + 스트림 런타임 이관 | **L** | `chatStreamRuntime`이 `components/chat/types`에 묶임 |
| `api-client` (cookie/bearer 이중 transport) | **M** | 라우트 계약은 이미 안정 |
| `chat-ui` 추출 (message list·renderer·composer shell) | **XL** | `ChatInput` 4,601줄이 실질 경계 |
| bearer 설계·위협 모델·테스트 벡터 | **M** | 승인 패킷 — 지금 가능 |
| bearer migration·발급·회전·family·재사용 탐지 | **L** | **정책 승인 이후** (§6.1) |
| 기기 목록·기기 해제 UI + API | **M** | 위 스키마에 종속 |
| 이메일 OTP → bearer 교환 | **M** | `emailLogin.ts` 재사용, 쿠키 발급부만 분기 |
| system-browser OAuth + PKCE (Native) | **M** | `lib/oauthLink.ts` PKCE 로직 재사용 |
| Sign in with Apple (서버+클라) | **L** | private relay 신원, 삭제 시 token revoke 포함 |
| N1a: CORS allowlist + `OPTIONS` + hostile-origin 테스트 | **M** | bearer 불필요 — 지금 가능 |
| N1b: 검증된 bearer의 mutation-origin 대체 | **M** | **bearer 검증기 이후** (§3.1) |
| N4a: AASA/assetlinks 형식 + 검증 도구 | **S** | 식별자는 플레이스홀더 — 지금 가능 |
| N4b: `.well-known` 배포 + entitlement + intent-filter | **M** | **식별자 확정 이후** (§7.1) |
| 딥링크 탈취 실기기 테스트 | **M** | N4b 이후 |
| 게스트 subject를 헤더로 이동 | **M** | 동시 실행 계약을 깨지 않아야 함 |
| 백그라운드·포그라운드 스트림 복구 | **L** | 오늘 관련 처리 0건 |
| R2 업로드 origin 대응 | **S~M** | 버킷 CORS 확인 필요(§10 미검증) |
| Drive 잠금 처리 | **S** | 기존 잠금 UI 재사용 |
| 계정 삭제·내보내기 Native 도달 경로 | **S** | 서버는 이미 있음 |
| PRIVACY `unverified` 2건 해소 | **S**(작업) | 크기는 작고 **결정 대기**가 실제 비용 |
| 스토어 심사 자격증명 lifecycle + synthetic login | **L** | 상태 기계·롤링 연장·알림 |
| 개인정보 표시·스토어 메타데이터 | **M** | Apple·Play의 데이터 항목이 registry 58개 도메인과 대조돼야 함 |
| Native CI (Android 빌드) | **M** | iOS는 macOS runner 필요 |
| 실기기 보안 회귀 세트 | **L** | AUTH-01·04가 요구하는 증거 |

---

## 6. 선행 의존성과 병렬화

세 종류의 선행 조건이 있고, 섞으면 잘못된 순서가 나옵니다. **코드 의존**(A가 없으면 B가
컴파일되지 않는다), **승인 의존**(사람이 결정해야 시작할 수 있다), **보안 의존**(먼저 하면
그 자체가 취약점이다). 다이어그램에서 승인 의존은 점선, 보안 의존은 굵은 선입니다.

```mermaid
flowchart TD
    APPROVE{{"모바일 인증 정책 승인<br/>(오늘 Phase 0 draft)"}}
    IDS{{"최종 Bundle/Application ID<br/>Team ID · 서명 인증서 digest"}}
    VOICE{{"Voice Input MVP 병합<br/>(b760383에서 충족)"}}

    N1A["N1a CORS + OPTIONS (M)"]
    N2D["N2-설계 위협모델·테스트벡터 (M)"]
    N2I["N2-구현 migration·발급·회전 (L)"]
    N1B["N1b 검증된 bearer의<br/>mutation-origin 대체 (M)"]
    N3["N3 기기 해제 + OTP 교환 (M)"]
    N4A["N4a AASA/assetlinks 형식·도구 (S)"]
    N4B["N4b .well-known 배포·entitlement (M)"]
    N4C["N4c system-browser OAuth (M)"]
    N5A["N5 1차 seed 5모듈 612줄 (S)"]
    N5B["N5 2차 seed 3모듈 192줄 (S)"]
    N5C["포트 설계 → 스트림 런타임 (M+L)"]
    N6["N6 api-client 이중 transport (M)"]
    N7["N7 chat-ui (XL)"]
    N8["N8 Native 핵심 흐름 (L)"]
    N9["N9 Sign in with Apple (L)"]
    N10["N10 실기기 보안 회귀 (L)"]
    N11["N11 심사 자격증명·개인정보 표시 (L)"]
    PRIV["PRIVACY unverified 2건 (결정)"]
    SUBMIT["스토어 제출"]

    N2D -.-> APPROVE
    APPROVE -.-> N2I
    N2I ==> N1B
    N2I --> N3
    N2I --> N4C
    N4A --> IDS
    IDS -.-> N4B
    N4B --> N4C
    VOICE -. 충족 .-> N5B
    VOICE -. 충족 .-> N7
    N5A --> N5C
    N5B --> N5C
    N5C --> N6
    N1A --> N6
    N1B --> N6
    N6 --> N7
    N7 --> N8
    N4C --> N9
    N8 --> N10
    N9 --> N10
    N10 --> N11
    N11 --> SUBMIT
    PRIV --> SUBMIT
```

**지금 즉시 병렬로 가능한 것 (서로 닿지 않고, 무엇도 기다리지 않음):**

1. **N1a — 두 origin CORS + `OPTIONS` preflight + hostile-origin 테스트.** bearer가
   필요 없는 유일한 보안 작업입니다.
2. **N2-설계 — bearer 수명주기 설계·위협 모델·테스트 벡터.** 코드가 아니라 승인 패킷입니다.
3. **N4a — AASA·`assetlinks.json` 형식과 검증 도구.** 식별자 자리는 플레이스홀더입니다.
4. **N5 seed 8모듈(804줄).** rev.2에서는 1차 612줄만 열려 있었지만 Voice가 병합돼 2차
   192줄도 열렸습니다(§7.2). 1차부터 가는 것은 되돌리기가 싸기 때문이지 막혀서가 아닙니다.
5. **PRIVACY `unverified` 2건 결정.** security-privacy와 finance-ops의 결정입니다.
6. **개인정보 표시 초안** — registry 58개 도메인에서 유도합니다.

**세 가지 게이트 때문에 지금 시작하면 안 되는 것:**

| 하지 않을 것 | 게이트 | 어기면 |
|---|---|---|
| **N1b** — bearer로 mutation-origin 대체 | **N2-구현**(보안 의존) | 검증되지 않은 헤더 한 줄이 CSRF 검사를 끕니다(§3.1) |
| **N2-구현** — Prisma migration·토큰 발급 | **정책 승인**(승인 의존) | 승인 전 스키마가 굳고, 되돌리려면 migration을 또 씁니다 |
| **N4b** — 실제 `.well-known` 배포 | **식별자 확정**(§7.1) | 틀린 fingerprint가 **실패한 상태로 캐시**됩니다 |
| ~~**N5 2차 seed 3모듈**~~ | ~~Voice 병합~~ → **해소됨** | rev.3에서 착수 가능. 착수 직전 소비자 재대조만 남습니다(§7.2) |
| **N7 `chat-ui`** | ~~Voice 완료~~ → **N5·N6·N1b** | Voice 조건은 충족됐지만 코드 의존이 남습니다 — 포트 설계와 `api-client`, 그리고 `api-client`가 필요로 하는 N1b |

### 6.1 모바일 인증 정책이 아직 draft라는 사실

`docs/policy/tomverse-chat-mobile-authentication.md`의 첫 줄은 **`Status: draft for Phase 0
approval`** 이고, 결정 소유자는 Backend/AI와 Mobile/Release **공동**입니다. 계획서 Phase 0의
나가는 문도 "mobile auth ADR 승인"을 명시합니다.

그러므로 N2를 **설계와 구현으로 나눕니다.**

- **지금 할 수 있는 것**: 위협 모델, 토큰 수명·회전 규칙의 구체화, family 무효화 시맨틱,
  기기 레코드 필드 목록, **테스트 벡터**(재사용 탐지·만료·타 subject·동시 회전 경합),
  그리고 §3.1의 N1b 대체 조건. 전부 저장소에 코드를 남기지 않고 승인 대상을 만듭니다.
- **승인 후에 할 것**: Prisma migration과 토큰 발급 구현.

이 저장소는 1인 조직이고 registry가 `soleApproverAllowed: true`이므로 승인은 **다른 사람을
기다리는 일이 아니라 문서를 읽고 서명하는 일**입니다. 그래도 순서는 지킵니다 — 승인 전에
migration을 넣으면 스키마가 결정보다 먼저 굳고, 되돌리는 비용이 migration 한 번 더입니다.
그리고 `AUTH-03`은 회전·재사용 탐지·로그아웃·기기 해제를 **함께** 채점하므로, 넷 중 하나만
먼저 만든 스키마는 나머지 셋이 정해질 때 다시 바뀝니다.

---

## 7. 1인 조직 기준 현실적인 구현 순서

계획서 §11의 3-엔지니어 스윔레인은 이 저장소에 그대로 적용되지 않습니다(AGENTS.md
"이 저장소는 1인 조직입니다"). 병렬 3레인을 직렬 1레인으로 접되, **순서를 되돌릴 수 없는
것부터** 놓습니다.

| 마일스톤 | 내용 | 규모 | 선행 조건 | 나가는 문 |
|---|---|---|---|---|
| **N0** *(완료)* | 로컬 번들 scaffold, `server.url` 게이트, 준비도 보고서 | S | — | 이 문서 |
| **N1a** | 두 origin CORS + `OPTIONS` preflight + hostile-origin 거절 | M | — | 브라우저가 응답을 읽을 수 있음 |
| **N2-설계** | bearer 수명주기 설계·위협 모델·테스트 벡터 | M | — | 정책 승인 요청 패킷 |
| **N2-구현** | Prisma migration + 발급·검증·회전·family·재사용 탐지 | L | **정책 승인** | AUTH-03 증거의 절반 |
| **N1b** | **검증된** bearer identity의 mutation-origin 대체 경로 | M | **N2-구현** | Native가 mutation을 보낼 수 있음 |
| **N3** | 기기 목록·로그아웃·기기 해제 + OTP→bearer 교환 | M | N2-구현 | AUTH-03 나머지, AUTH-02 절반 |
| **N4a** | AASA·`assetlinks.json` **형식과 검증 도구** | S | — | 배포 직전까지 준비 완료 |
| **N4b** | 실제 `.well-known` 배포 + entitlement + intent-filter | M | **식별자 확정**(§7.1) | AUTH-04 절반 |
| **N4c** | system-browser OAuth/PKCE | M | N2-구현, N4b | 로그인 왕복 성립 |
| **N5** | `chat-core` seed(1차 5모듈) → 포트 → 메시지 타입·스트림 런타임 | S+M+L | 1차는 즉시, 2차는 **Voice 병합 후**(§7.2) | `api-client` 착수 가능 |
| **N6** | `api-client` 이중 transport | M | N5, N1b | 셸이 실제 요청을 보냄 |
| **N7** | `chat-ui` 추출 (Review 회귀 E2E 고정 후) | XL | N6, **Voice 완료** | UI-01·UI-02 대상 생김 |
| **N8** | Native 핵심 Chat 흐름 + 게스트 subject 헤더 이동 + 백그라운드 복구 | L | N7 | 앱이 쓸 만해짐 |
| **N9** | Sign in with Apple + 계정 삭제·내보내기 도달 경로 | L | N4c | AUTH-01, PRIVACY-01 |
| **N10** | 실기기 보안·회귀 (CORS·딥링크·토큰 재생·기기 해제) | L | N9 | AUTH-04 완결 |
| **N11** | 심사 자격증명 lifecycle + synthetic login + 개인정보 표시 | L | N10 | STORE-01·02 |
| **N12** | 제출·심사 대응 | M | N11 | — |

**N1a를 맨 앞에 두는 이유**는 크기가 작아서가 아니라, 유일하게 **아무것도 기다리지 않는
보안 작업**이기 때문입니다. 반대로 **N1b는 의도적으로 뒤**입니다 — §3.1이 설명하듯 검증기
없이 먼저 만들면 그 자체가 우회로입니다.

### 7.1 N4를 셋으로 나눈 이유 — 식별자가 없으면 파일을 쓸 수 없다

초판은 AASA·`assetlinks.json`을 "파일 배포일 뿐"이라고 적었습니다. **틀렸습니다.** 두 파일은
전부 **아직 확정되지 않은 식별자**로 채워집니다.

| 파일 | 필요한 값 | 오늘 상태 |
|---|---|---|
| `apple-app-site-association` | Apple Team ID + 최종 Bundle ID (`TEAMID.com.example.app`) | **둘 다 미정** |
| `assetlinks.json` | 최종 `applicationId` + **서명 인증서 SHA-256 fingerprint** | **둘 다 미정** |
| iOS entitlement | `applinks:<도메인>` + Associated Domains capability | 네이티브 프로젝트 자체가 없음 |
| Android manifest | `autoVerify="true"` intent-filter | 같음 |

`apps/mobile/capacitor.config.ts`의 `appId: "app.tomverse.shell"`은 **스파이크 식별자**이며
제품 식별자가 아닙니다. 그리고 `assetlinks.json`의 fingerprint는 **어떤 키로 서명하느냐**에
달려 있으므로, Play App Signing을 쓸지 자체 upload key를 쓸지 정해지기 전에는 값을 적을 수
없습니다. 잘못된 fingerprint를 올린 `assetlinks.json`은 없는 것보다 나쁩니다 — 검증이
**실패한 상태로 캐시**되기 때문입니다.

그래서 N4a는 **형식·검증 도구·테스트 절차**까지만 만들고(플레이스홀더가 들어간 템플릿,
`pm verify-app-links`/`pm get-app-links` 실행 스크립트, 두 번째 앱의 최소 매니페스트),
실제 `.well-known` 배포는 식별자가 확정된 뒤 N4b에서 합니다.

### 7.2 N5의 이관 범위 — rev.3에서 2차가 열렸습니다

**rev.2에서는 대기, rev.3에서는 착수 가능입니다.** Voice가 `b760383`에서 병합됐고,
`components/chat/ChatInput.tsx`에 실제로 82줄을 더했습니다(`VoiceInputButton`,
`useVoiceRecorder`, `appendVoiceTranscript`). 그 작업이 끝났으므로 rev.2가 걱정한 동시 편집은
더 이상 성립하지 않습니다.

다만 **"Voice가 끝났으니 그냥 옮긴다"가 아니라 "최신 변경 파일로 다시 대조한 뒤 옮긴다"** 입니다.
아래는 `b760383`에서 다시 센 소비자 목록이고, 착수 직전에 같은 명령으로 한 번 더 확인합니다.

```
$ for m in chatAttachmentErrorCopy chatCreditAllocation chatKeyboardPolicy; do
    grep -rln "@/lib/$m\"" components "app/(site)"; done

chatAttachmentErrorCopy  ChatInput.tsx
chatCreditAllocation     ChatInput.tsx, ChatPageClient.tsx
chatKeyboardPolicy       ChatInput.tsx, ChatApp.tsx, ImageGenerationWorkspace.tsx
```

소비자 목록은 rev.2와 **동일**합니다 — Voice는 이 세 모듈의 import를 늘리지도 줄이지도
않았습니다. 그러므로 1차·2차 구분은 이제 **순서의 근거가 아니라 배치의 편의**이며, 둘을
한 번에 옮겨도 됩니다. 그래도 나눠 두는 이유는 1차 5모듈이 `ChatInput.tsx`를 전혀 건드리지
않아 되돌리기가 더 싸기 때문입니다.

원래의 분할 근거는 아래에 그대로 둡니다 — 왜 나뉘었는지가 지워지면 다음에 같은 판단을 다시
해야 합니다.

| 1차 (즉시, Voice와 무관) | 줄 | 클라이언트 소비자 |
|---|---:|---|
| `lib/comparisonReadiness.ts` | 212 | DesktopChatShell, MobileChatShell, ComparisonActionRail |
| `lib/chatCostSafetyCore.ts` | 147 | ChatApp, ChatPageClient |
| `lib/chatModelSummary.ts` | 110 | MobileChatShell |
| `lib/chatRuntimeStatus.ts` | 107 | DesktopChatShell, MobileChatShell, ChatApp |
| `lib/comparisonReviewCost.ts` | 36 | ComparisonActionRail |
| **소계** | **612** | |

| 2차 (**Voice 병합 후**) | 줄 | 클라이언트 소비자 |
|---|---:|---|
| `lib/chatAttachmentErrorCopy.ts` | 92 | **ChatInput** |
| `lib/chatCreditAllocation.ts` | 56 | **ChatInput**, ChatPageClient |
| `lib/chatKeyboardPolicy.ts` | 44 | **ChatInput**, ChatApp, ImageGenerationWorkspace |
| **소계** | **192** | |

612 + 192 = 804로 §2.2의 합과 같습니다. 나뉜 것은 순서일 뿐 범위가 아닙니다.

경계선은 **`ChatInput.tsx`**였습니다. rev.2는 "Voice가 `ChatApp.tsx`까지 손대면
`chatCostSafetyCore`·`chatRuntimeStatus`도 1차에서 빠져야 한다"고 적었는데, `b760383`에서
확인한 결과 Voice가 실제로 건드린 것은 `ChatInput.tsx`(+82), `DesktopChatShell.tsx`(+4),
`MobileChatShell.tsx`(+4), `ReviewWorkspaceShell.tsx`이고 **`ChatApp.tsx`는 아닙니다.**
그러므로 선을 다시 그을 필요가 없었고, 1차 5모듈은 rev.2가 정한 그대로입니다.

**N7(`chat-ui`)이 늦은 이유**는 계획서 §12의 유예 순서와 같습니다. 셸은 `chat-ui` 없이도
N1~N6의 인증 경계를 실기기에서 검증할 수 있고, 인증은 유예 금지 목록에 있습니다.

### 7.3 일정 감각과, 그 안에서 지금 시작하는 것

1인, 하루 실질 4~5시간 기준으로 **인증·보안 기반(N1a~N4c) 7~9주**,
**공유 코드·UI(N5~N8) 10~14주**, **Apple·실기기·심사(N9~N12) 8~10주**로 **총 25~33주**
입니다. 초판보다 1주 늘어난 것은 N1을 둘로 나누면서 N1b가 N2 뒤로 갔기 때문이고, 이것은
비용이 아니라 **초판이 세지 않았던 순서 제약**입니다.

rev.3에서 Voice가 끝났지만 **총량은 줄지 않습니다.** Voice는 `chat-ui`의 선행 조건이었을 뿐
그 작업 자체를 대신하지 않고, 임계 경로는 여전히 N2-구현 → N1b → N6 → N7입니다. 줄어든 것은
**대기**이고, 그만큼 3순위 작업을 앞당겨 채울 수 있습니다.

계획서의 3인 22~30주와 숫자가 비슷해 보이지만 같은 뜻이 아닙니다 — 3인 계획은
Router·Planner·Memory를 포함하고, 이 추정은 **Native 경로만**입니다. 그 둘을 한 사람이
동시에 진행할 수는 없습니다.

**그래서 지금의 병행 구도는 다음과 같습니다.**

`b760383`에서 Voice가 완료됐으므로 rev.2의 "Voice 대기" 칸은 사라지고, 표는 이렇게
바뀝니다.

| 순위 | 무엇 | 상태 | 왜 지금/나중인가 |
|---|---|---|---|
| **1** | **N1a** CORS·`OPTIONS`·hostile-origin 거절 | **착수 가능** | 아무것도 기다리지 않는 유일한 보안 작업 |
| **2** | **N2-설계** + 정책 승인 패킷 | **착수 가능** | 코드가 아니라 승인 대상. `AUTH-03` 넷을 함께 설계(§6.1) |
| 3 | `chat-core` seed — 1차 612줄, 이어서 2차 192줄 | **착수 가능** | Voice 조건 해소. 착수 직전 소비자 재대조(§7.2) |
| 3 | N4a AASA/assetlinks 형식·검증 도구 | **착수 가능** | 식별자 자리는 플레이스홀더(§7.1) |
| 3 | PRIVACY `unverified` 2건 | **착수 가능** | security-privacy·finance-ops 결정 |
| 3 | 개인정보 표시 초안 | **착수 가능** | registry 58개 도메인에서 유도. Voice가 새 항목(오디오) 추가 |
| 4 | 포트 설계 → 메시지 타입 → 스트림 런타임 | seed 뒤 | 선례는 `voiceTranscriptionPort*`(§2.3) |
| 5 | **N2-구현** → N3 | **정책 승인 뒤** | 승인 의존(§6.1) |
| 6 | **N1b** | **N2-구현 뒤** | 보안 의존(§3.1) |
| 6 | N4b `.well-known` → N4c OAuth | **식별자 확정 뒤** | 틀린 fingerprint는 캐시됨(§7.1) |
| 7 | N6 `api-client` | N5 + N1b 뒤 | 두 transport 중 하나가 아직 없음 |
| 8 | N7 `chat-ui` → N8 | N6 뒤 | **Voice 조건은 충족됐고, 남은 것은 코드 의존입니다** |
| 9 | N9 Apple → N10 실기기 → N11 심사 → N12 제출 | 순차 | — |

**우선순위는 N1a → N2-설계 승인 패킷**이고, 3순위 넷은 서로 닿지 않으므로 사이사이에
채웁니다.

rev.2의 "Native UI 본개발은 Voice 완료 이후"는 여전히 맞지만 **이유가 바뀌었습니다.**
rev.2에서는 파일 충돌 회피였고, 지금은 **`chat-ui`가 `api-client`를, `api-client`가 N1b를,
N1b가 N2-구현을 기다리기 때문**입니다. Voice는 더 이상 그 사슬에 없습니다.

---

## 8. iOS·Android 공통 영역과 플랫폼별 영역

### 공통 (한 번 만들면 둘 다)

웹 자산 전체(Vite 번들), `chat-core`·`chat-ui`·`api-client`·`ui-tokens`, 서버 API,
bearer lifecycle, CORS, 계정 삭제·내보내기, 개인정보 표시의 데이터 목록, PKCE 흐름 로직.

### 플랫폼별

| | iOS | Android |
|---|---|---|
| WebView | WKWebView | Chromium WebView |
| origin | `capacitor://localhost` | `https://localhost` |
| 최소 버전 | iOS 15.0 *(`Capacitor.podspec`)* | `minSdk 24` *(`capacitor/build.gradle`)* |
| 대상 | — | `compileSdk`/`targetSdk 36`, AGP 8.13.0, Java 21 |
| 딥링크 | Associated Domains 엔타이틀먼트 + AASA | `autoVerify` intent-filter + `assetlinks.json` |
| 필수 로그인 | **Sign in with Apple (4.8)** | 해당 없음 |
| 빌드 | **macOS + Xcode 필수** | Linux/Windows 가능 |
| 심사 | App Review + 개인정보 표시 | Play Console + Data safety |
| 백그라운드 | WebView 정지 공격적 | 상대적으로 관대 |

**1인 조직에서 가장 비대칭적인 항목은 "macOS 필수"입니다.** iOS 빌드·서명·실기기 테스트가
전부 하나의 기계에 묶이므로, iOS를 뒤로 미루면 AUTH-01과 AUTH-04 절반이 통째로 미뤄집니다.
**Android를 먼저 완주하고 iOS를 나중에** 하는 순서가 1인 기준으로 현실적입니다 — 공통 영역이
크므로 Android에서 얻은 증거의 상당 부분이 iOS 작업을 줄여 줍니다.

---

## 9. PWA로 먼저 검증할 수 있는 것 / Native에서만 되는 것

**PWA(또는 모바일 웹)로 충분히 검증되는 것** — 여기서 확인하고 Native로 넘기면 실기기
시간을 아낍니다.

- 반응형 레이아웃, 안전영역, 200% 텍스트 배율, 320px 폭
- 한국어 IME 입력·제출 (`docs/ui-contracts/mobile-chat-composer.md`)
- 스트리밍·중단·재시도의 상태 기계 (`UI-02`의 대부분)
- 비교 액션 레일 상태 행렬
- 첨부 선택·업로드·오류 문구
- 계정 삭제·내보내기 화면 흐름
- `chat-core`·`chat-ui` 회귀 전부

**Native에서만 가능한 것** — PWA로 대체할 수 없습니다.

- Capacitor origin에서의 CORS·mutation-origin 동작 (§3.1)
- Keychain/Keystore 저장과 앱 삭제 시 잔존 여부
- Universal Link / App Link **소유권 검증** — Android 공식 문서가 말하듯 이것은 기기
  수준 등록이고, 시뮬레이터가 재현하지 않습니다
- 딥링크 탈취(같은 링크를 주장하는 두 번째 앱)
- Sign in with Apple 네이티브 시트
- system browser 왕복과 앱 복귀
- 백그라운드 진입 시 스트림 중단·복구
- 파일 선택기의 실제 MIME 보고 (AGENTS.md "사람만 할 수 있는 것" 1번)
- 카메라·마이크 **네이티브 권한 다이얼로그**와 거부 후 동작 (웹 권한 흐름은 Voice가 이미 구현했고 브라우저에서 검증됩니다 — 네이티브에서만 다른 것은 OS 다이얼로그와 설정 앱 복귀입니다)
- 스토어 심사 빌드 그 자체

---

## 10. 스토어 제출 전 필요한 실기기 검증

AGENTS.md "사람만 할 수 있는 것은 사람만 할 수 있는 것뿐입니다"에 맞춰, **에이전트가 준비할
수 있는 것은 준비물로 넘기고** 사람이 해야 하는 것만 남깁니다.

| # | 항목 | 기기 | 차단? | 근거 게이트 |
|---|---|---|---|---|
| 1 | Universal Link 소유권 (정상 + 미검증 도메인) | iOS 실기기 | 예 | AUTH-04 |
| 2 | App Link 검증 상태 (`pm get-app-links`) | Android 실기기 | 예 | AUTH-04 |
| 3 | 같은 링크를 주장하는 두 번째 앱 설치 후 OAuth 반환 | 양쪽 | 예 | AUTH-04 |
| 4 | hostile origin에서 bearer 엔드포인트 호출 | 브라우저 | 예 | AUTH-04 |
| 5 | refresh 재사용 → family 전체 무효화 | 양쪽 | 예 | AUTH-03 |
| 6 | 기기 해제 후 그 기기만 끊기고 웹 세션 유지 | 양쪽 | 예 | AUTH-03 |
| 7 | Sign in with Apple 링크·해제·삭제·token revoke | iOS 실기기 | 예 | AUTH-01 |
| 8 | 앱 내 계정 삭제 완주 + 모든 device family revoke | 양쪽 | 예 | PRIVACY-01 |
| 9 | 데이터 내보내기 단발성 링크·5분 만료 | 양쪽 | 예 | PRIVACY-02 |
| 10 | clean device에서 신규 Free 계정 → 답변 1건 → 히스토리 저장 | 양쪽 | 예 | STORE-01 |
| 11 | 심사 자격증명으로 제출 빌드 로그인 | 제출 빌드 | 예 | STORE-02 |
| 12 | 파일 선택기 MIME 보고 (특히 Android 제조사별) | 양쪽 | 아니오 | — |
| 13 | 백그라운드 30초 후 복귀 시 스트림 상태 | 양쪽 | 예 | UI-02 |
| 14 | 저사양 기기 첫 화면 표시 시간 | Android | 아니오 | — |

**1~11과 13이 차단이고 12·14는 아닙니다.**

1~11은 "틀렸을 때 되돌릴 수 없는가" 기준으로 차단입니다 — 토큰 유출·계정 탈취·삭제 실패는
회수되지 않습니다. **13은 그 기준으로는 차단이 아닙니다**: 잃어버린 스트림의 피해는 잘못된
과금이고, AGENTS.md가 그것을 명시적으로 "되돌릴 수 있음"에 넣습니다(환급됩니다). 그런데도
차단인 이유는 **UI-02가 blocking gate이고 그 증거 항목이 "native-shell E2E report"이기
때문**입니다. 게이트가 요구하면 위험 판단과 무관하게 차단이며, 이 둘을 섞지 않는 것이
중요합니다 — "중요해 보인다"가 아니라 "게이트가 이름을 댔다"가 근거입니다.

에이전트가 미리 만들어 건네야 하는 것: 시료 파일 세트와 정답지 manifest, 딥링크 테스트용
두 번째 앱의 최소 매니페스트, hostile-origin 페이지, `pm get-app-links` 실행 스크립트,
기록 파일 초안. **사람이 하는 것은 실기기 실행과 판정·서명뿐입니다.**

---

## 11. production 자격증명 없이 검증한 범위

### 11.1 실제로 성공한 것

**아래는 전부 `b760383` 트리에서 실행한 결과입니다.** rev.1·rev.2 때의 값을 옮겨 적은 행은
없습니다.

| 검증 | 명령 | 결과 |
|---|---|---|
| 공유 package 순수성 | `npm run check:shared-packages` | `forbidden_nextjs_imports_in_shared_packages = 0`, 2 package |
| Vite 빌드 매트릭스 | `npm run verify:package-build-matrix` | 통과 (번들 실행·CSS 값 확인 포함) |
| Next.js 프로덕션 빌드 | `npm run build` | 성공 (병합 후 재실행 포함) |
| Next.js 타입체크 | `npm run typecheck` | 성공 |
| ESLint 전체 | `npm run lint` | 0 error / 0 warning |
| **Capacitor 원격 server.url 부재** | `npm run check:capacitor-local-bundle` | `remote_server_config_findings = 0` |
| 위 게이트의 역방향 확인 | 일부러 `server.url`+`cleartext` 주입 | **2건 검출, exit 1** — 그리고 원복 |
| **Vite 셸 빌드** | `npm run build:mobile-shell` | `vite v8.2.1`, 20 modules, 성공 |
| 셸 타입체크 | `tsc -p apps/mobile/tsconfig.json` | 성공 |
| **셸 실행 (Chromium)** | `vite preview` + Playwright Chromium | light·dark **각 7/7 통과, 페이지 오류 0** |
| 셸 번들 정적 검사 | 수동 grep | env 변수·API host·토큰 **0건** |
| 비밀 정적 검사 | 변경 파일 대상 패턴 스캔 | 0건 |
| PUSH-01 | `npm run check:push-scope` | 통과 (1,281 파일, 47 의존성 — Capacitor 4개 추가 후에도) |
| data-domain registry | `npm run check:data-domain-registry` | 58 도메인, `unverified` 2건 (§3.4) |
| 릴리스 게이트 registry | `npm run verify:tomverse-chat-release-gates` | 40 gates, 40 blocking, draft |
| 릴리스 게이트 뷰 | `npm run check:tomverse-chat-release-gate-view` | 일치 |
| 게이트 커버리지 | `npm run check:release-gate-coverage` | **45** CI 강제 (새 검사 포함) |
| 문서 참조·정책 인용·인코딩·accent·릴리스 기록·staging 기록·UI tier·구제품명 | 각 `npm run check:*` | 전부 통과 |
| 공유 package 단위 테스트 | `tests/sharedPackages.test.mjs` (저장소 러너 플래그) | 23 tests: 22 pass / 0 fail / 1 skip |
| 전체 단위 테스트 | `npm run test:unit` | 두 lane 합계 **7,051 pass / 0 fail / 1 skip** (§11.4) |

셸 실행 결과 원문:

```
### colorScheme=light  --background=#fff
  [pass] Running in a browser :: origin = "http://127.0.0.1:4173"
  [pass] Assets are served from the local bundle
  [pass] @tomverse/chat-core resolves and evaluates :: LENGTH_RAW_FINISH_REASONS carries 6 entries
  [pass] A finished answer is reported as normal :: finishReason "stop" -> status "normal"
  [pass] A truncated answer is reported as incomplete :: rawFinishReason "MAX_TOKENS" -> status "incomplete", reason "length"
  [pass] @tomverse/ui-tokens stylesheet carries its values :: --background = "#fff"
  [pass] Brand accent tokens resolve outside the Tailwind build :: --tomverse-accent-mid = "#2563eb"
  SUMMARY: All 7 checks passed.   page errors: none

### colorScheme=dark  --background=#0a0a0a
  ... SUMMARY: All 7 checks passed.   page errors: none
```

**이것이 증명하는 것**: 기존 `chat-core`와 `ui-tokens`가 Next.js 없이 브라우저 번들에서
**해석되고, 실행되고, 값이 같습니다.** `prefers-color-scheme` 블록까지 살아 있습니다.

**이것이 증명하지 않는 것**: Capacitor WebView 안에서의 동작. 위 실행은 Chromium이고
`Capacitor.isNativePlatform()`은 `false`를 반환했습니다.

### 11.2 검증하지 못한 것 (통과로 기록하지 않음)

| 항목 | 왜 |
|---|---|
| iOS 빌드·서명·실행 | macOS·Xcode 없음. 이 컨테이너는 Linux |
| Android Gradle 빌드 | Android SDK·JDK 21 툴체인 없음 |
| `npx cap add android` / `add ios` | 위와 같음 — 네이티브 프로젝트를 **생성하지 않았습니다** |
| 실기기 딥링크·CORS·토큰 재생 | 기기 없음 |
| Capacitor WebView origin 실측 | 위와 같음. §3.1의 origin은 **패키지 선언에서 읽은 값**이지 관측값이 아닙니다 |
| R2 버킷이 `capacitor://` origin을 CORS AllowedOrigin으로 받는지 | Cloudflare 자격증명 없음. **미검증 위험으로 남깁니다** |
| Apple AASA 파일 세부 요건 | `developer.apple.com` 문서 페이지가 JS 렌더링이라 본문을 받지 못했습니다. 심사 지침(4.8·5.1.1(v)·2.5.2·5.1.2)은 받았습니다 |
| Sign in with Apple 심사 통과 여부 | 심사 판단 영역 |
| `npm run check` / E2E 전체 | 이번 변경 범위 밖 |

### 11.3 생성·수정한 것

**새 파일**

| 경로 | 내용 |
|---|---|
| `apps/mobile/package.json` | 워크스페이스 셸 매니페스트 |
| `apps/mobile/capacitor.config.ts` | `webDir: "dist"`. **`server` 블록 없음** |
| `apps/mobile/vite.config.ts` | 플러그인 0개, `base: "./"`, sourcemap 끔 |
| `apps/mobile/tsconfig.json` | 자체 config (`@/` alias 없음) |
| `apps/mobile/index.html` | 진입 문서 |
| `apps/mobile/src/main.tsx` | React DOM 마운트 |
| `apps/mobile/src/ReadinessScreen.tsx` | 준비도 화면 (미인증) |
| `apps/mobile/src/readinessChecks.ts` | 7개 검사 |
| `apps/mobile/src/styles.css` | `@tomverse/ui-tokens/tokens.css` import |
| `apps/mobile/README.md` | 셸 범위·플랫폼 요구사항·origin 문제 |
| `scripts/check-capacitor-local-bundle.mjs` | `server.url`/`cleartext`/`allowNavigation` 게이트 |
| `.github/audits/2026-08-30-native-mobile-readiness.md` | 이 문서 |

**수정한 파일 (전부 scaffold에 필요한 최소 범위)**

| 경로 | 변경 | 이유 |
|---|---|---|
| `package.json` | `workspaces`에 `apps/*` 추가; `check:capacitor-local-bundle`·`build:mobile-shell` script 2개 | 워크스페이스 심볼릭 링크가 없으면 `@tomverse/*` specifier가 해석되지 않음 |
| `package-lock.json` | 항목 **76개 추가** | 아래 §11.5 |
| `tsconfig.json` | `exclude`에 `apps` 추가 | 셸을 Next.js 앱 설정으로 타입체크하지 않기 위해 |
| `eslint.config.mjs` | `globalIgnores`에 `apps/*/dist/**` | Vite 산출물을 lint하면 minified 번들에서 경고 714건이 나오고 `npm run check`(`--max-warnings=0`)가 실패 |
| `.gitignore` | `/apps/*/dist/` | 빌드 산출물 |
| `.github/workflows/pr-fast-gate.yml` | 새 검사 step 1개 | 아래 |
| `.github/RELEASE_CHECKLIST.md` | 같은 검사 1줄 | `check:release-gate-coverage`가 CI와 체크리스트의 불일치를 실패로 만듦 |

새 검사를 CI에 넣은 이유는 `docs/policy/shared-packages.md` §6이 이름을 댄 구분 때문입니다 —
**트리에 script가 있다는 것과 게이트가 있다는 것은 다릅니다.** 돌지 않는 검사는 산출물이지
보증이 아닙니다.

### 11.4 전체 단위 테스트

`npm run test:unit` — **exit 0**. **`b760383` 트리에서 재실행한 값**입니다(rev.3).

`scripts/run-unit-tests.mjs`는 프로세스를 둘로 나누므로(`--conditions=react-server`가
프로세스 전역이라 client component lane이 분리됩니다) 요약이 **두 번** 출력됩니다.
`/tmp` 로그의 7107행과 7159행이 각각의 블록이고, 값은 다음과 같습니다.

| lane | tests | pass | fail | skipped |
|---|---:|---:|---:|---:|
| server (`--conditions=react-server`) | 7,008 | 7,007 | 0 | 1 |
| client (`tests/client/**`, 4개 파일) | 44 | 44 | 0 | 0 |
| **합계** | **7,052** | **7,051** | **0** | **1** |

**보고할 수치는 마지막 행 — 7,051 pass입니다.**

`7,007`은 **server lane 하나의 pass**입니다. 이 숫자가 두 번 잘못 옮겨졌으므로 셈하는
방법을 여기 고정합니다.

| 잘못 옮긴 값 | 실제로 그 숫자였던 것 | 맞는 총계 |
|---|---|---|
| rev.1의 "6,892 pass" | server lane의 `tests` | 6,960 |
| rev.3 검토의 "7,007 pass" | server lane의 `pass` | **7,051** |

두 실수의 모양이 다릅니다 — 앞은 `tests`와 `pass`를 바꿔 읽었고, 뒤는 값은 맞게 읽었지만
**client lane 44건을 더하지 않았습니다.** 공통점은 하나뿐이고 그것이 원인입니다:
**출력이 두 번 나오는데 한 번만 읽었습니다.**

셈하는 규칙: `npm run test:unit`의 출력에는 `ℹ tests` 블록이 **정확히 두 개** 있고, 총계는
둘을 더한 값입니다. 하나만 인용하려면 어느 lane인지 함께 적습니다.

skip 1건은 `packages/ui-tokens does not inherit the app's tsconfig`로, 그 package에
TypeScript가 없어 의도적으로 건너뜁니다 — 실패가 아닙니다.

이 저장소의 워크스페이스에 `apps/*`를 추가하고 root `tsconfig`/`eslint`/`.gitignore`를
바꾼 뒤에도 전량 통과합니다. `tests/sharedPackages.test.mjs`의 "the root manifest declares
the workspace"가 워크스페이스 선언을 직접 읽으므로, 이 변경이 조용히 넘어가지 않았다는
것까지 확인됩니다.

### 11.5 lockfile 변경 — 별도 보고

root `package-lock.json`에 **76개 패키지 항목**이 추가됐습니다. 직접 추가한 의존성은 4개
(`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/ios`, 전부 8.5.0)이고,
나머지는 **`@capacitor/cli`의 추이 의존성**입니다(`@ionic/utils-*`, `fs-extra`,
`bplist-parser`, `elementtree` 등).

줄이는 방법이 있습니다: `@capacitor/cli`를 빼면 항목이 ~4개로 줄지만, 그러면
`cap add android`·`cap sync`를 실행할 수 없어 **셸이 로컬 번들 셸이기를 그만둡니다.**
그래서 넣었습니다. `@vitejs/plugin-react`는 **넣지 않았습니다** — Vite의 esbuild가
tsconfig의 `jsx: "react-jsx"`로 TSX를 처리하므로 fast refresh를 위해서만 필요했고,
이 스파이크에 fast refresh는 필요 없습니다.

`react`·`react-dom`은 root와 **같은 버전(19.2.8)** 을 선언해 중복 설치를 만들지 않습니다.


---

## 12. Voice Input MVP와 충돌하거나 재사용할 영역

**rev.3: Voice Input MVP는 `b760383`에서 병합 완료입니다.** 이 절은 "동시에 진행 중인
작업과 어떻게 겹치지 않을 것인가"에서 "무엇이 실제로 들어왔고 Native에 무엇이 남았는가"로
바뀝니다.

이 스파이크가 Voice 파일을 건드리지 않았다는 사실은 그대로입니다 — `apps/mobile/`,
`scripts/check-capacitor-local-bundle.mjs`, root 설정, 보고서 외에는 수정한 파일이 없습니다.

### 실제로 들어온 것

| | |
|---|---|
| 새 파일 | `components/chat/VoiceInputControl.tsx`, `useVoiceRecorder.ts`, `voiceInputCopy.ts`, `lib/voice*.ts` 9개 |
| 기존 파일 수정 | `ChatInput.tsx` **+82**, `DesktopChatShell.tsx` +4, `MobileChatShell.tsx` +4, `ReviewWorkspaceShell.tsx`, `PrivacyPolicy.tsx` |
| locale | 7개 언어 각 +30~31줄 |
| 정책·운영 | `docs/policy/voice-input.md` (508줄), `docs/ops/voice-input-staging-checklist.md` |
| 테스트 | 단위 5개 파일, client 1개, server-contract 1개, E2E 1개, fixture 3개 |

**활성화 상태**: rollout flag `AppSetting["feature.voiceInputEnabled"]`는 **default-off**이고,
kill switch `VOICE_INPUT_KILL_SWITCH`가 따로 있습니다. production 활성화는
`docs/policy/voice-input.md` §14의 **B-1~B-6이 막고 있습니다** — 오디오 1초의 가격,
실패 시 과금, provider 원가 검증, audio provider 예산, provider 데이터 보존, 실기기 검증.
**Native 계획은 이 여섯 개를 기다리지 않습니다.** Voice가 production에서 켜지든 아니든
`getUserMedia` 코드는 트리에 있고, Native 권한 선언이 필요한 시점은 그 코드가 네이티브
WebView에서 실행될 때입니다.

### 충돌 가능성 — 해소된 것과 남은 것

| 영역 | rev.2 걱정 | `b760383` 결과 |
|---|---|---|
| `ChatInput.tsx` | N7 `chat-ui`가 같은 파일을 크게 움직임 | **해소.** Voice가 +82줄로 끝났습니다. N7이 늦은 이유는 이제 파일 충돌이 아니라 N5·N6·N1b 코드 의존입니다 |
| `chat-core` seed 3모듈 | `ChatInput.tsx` 경유라 import 충돌 | **해소.** Voice는 이 세 모듈의 import를 늘리지도 줄이지도 않았습니다(§7.2) |
| `ChatApp.tsx`로 번질 가능성 | 번지면 1차 5모듈도 다시 나눠야 함 | **번지지 않았습니다.** Voice가 건드린 shell은 Desktop·Mobile·Review 셋이고 `ChatApp.tsx`는 아닙니다 |
| 모바일 composer UI 계약 | Voice 버튼이 textarea 행 침범 | 계약이 금지하고 회귀 테스트가 고정합니다. `tests/e2e/voice-input-composer.spec.ts`가 460줄로 들어왔습니다 |
| `locales/*.ts` | Voice가 문구 추가 | 7개 언어 각 +30~31줄. Native는 v1에서 새 제품 문구를 만들지 않으므로 접점 없음 |

**남은 충돌은 없습니다.** Voice와 Native 사이에 열려 있던 파일 수준 제약은 전부 닫혔고,
남은 것은 Native 내부의 순서 제약(§6)뿐입니다.

### 재사용 — Voice가 Native에 남긴 것

rev.2는 이것을 예상으로 적었습니다. `b760383`에서는 확인된 사실입니다.

1. **port 주입 패턴의 실제 구현.** `lib/voiceTranscriptionPortCore.ts`(225줄, 결정 전부) +
   `lib/voiceTranscriptionPort.ts`(90줄, `server-only`, `process.env`만 주입). §2.3의
   storage·timer·transport 포트는 이 형태를 따릅니다 — **§4.3의 제약과 함께**: 토큰
   저장과 대화 상태 저장은 다른 포트여야 합니다.
2. **framework-neutral 모듈 1,197줄.** 그중 `voiceRecorderMachine.ts`는 전역을 하나도 쓰지
   않는 348줄 상태 기계입니다(§2.2).
3. **권한 모델의 첫 사례.** `getUserMedia`가 트리에 있으므로 Capacitor에서
   `NSMicrophoneUsageDescription`·`RECORD_AUDIO`가 **필요해질 것**입니다. 아직 선언은
   없습니다 — Voice 정책 §1이 native를 명시적으로 범위 밖에 두었기 때문이고, 그 선언은
   N4b에서 네이티브 프로젝트를 만들 때 함께 들어갑니다.
4. **secure context 요구.** `getUserMedia`는 secure context를 요구하고, Capacitor 설정
   문서가 `server.hostname`을 `localhost`로 유지하라고 권하는 이유가 정확히 그것입니다.
   **§3.1의 origin 결정이 이제 관측 가능한 요구사항입니다** — "origin이 다르다"가 실기기에서
   "마이크가 안 켜진다"로 나타납니다.
5. **개인정보 표시에 새 항목.** Voice 정책 §11.1이 원본 오디오를 저장하지 않는다고 못
   박았고(`tests/voiceInputPrivacy.test.mjs`가 강제), §11.3은 provider 데이터 보존을
   미결(B-5)로 둡니다. Apple 5.1.2(i)의 "third-party AI와 공유"는 오디오에도 걸리므로,
   §11.3이 닫히기 전에는 개인정보 표시의 오디오 항목을 확정할 수 없습니다.

### 예상이 빗나간 것

rev.2는 "음성 캡처가 백그라운드 전환에 민감하므로 그 처리 코드가 §1의 21번 첫 사례가 된다"고
적었습니다. **그렇게 되지 않았습니다** — `b760383`에도 `visibilitychange`·`pagehide` 처리는
**0건**이고, `useVoiceRecorder.ts`도 `voiceRecorderMachine.ts`도 이를 다루지 않습니다.

백그라운드·포그라운드 전환은 여전히 **M0이고, Native가 처음부터 만들어야 합니다.**
Voice에서 물려받을 코드가 없다는 것이 이 항목의 실제 상태입니다.

---

## 부록 A — 이번에 만든 게이트

```
$ npm run check:capacitor-local-bundle
capacitor_configs_scanned = 1 (apps/mobile/capacitor.config.ts)
remote_server_config_findings = 0
```

`server.url` 하나가 아니라 셋을 봅니다. `allowNavigation`은 WebView가 번들 밖으로 나갈 수
있게 하고, `cleartext`는 Android가 API 28부터 꺼 둔 평문 HTTP를 되살립니다 — `url`이 없어도
둘 중 하나만 있으면 앱은 이미 자기 번들을 떠날 수 있습니다. Capacitor 자신의 설정 문서가
셋 다 "not intended for use in production"이라고 적습니다.

**텍스트로 읽습니다.** config를 import해서 평가하면 환경변수로 들어온 URL이 여기서는 빈
문자열이 되어 통과합니다 — 그리고 "server.url이 환경변수에서 온다"가 바로 잡아야 하는
형태입니다. `server` 블록은 중괄호 매칭으로 잘라내므로, 다른 키의 `url:`을 서버 URL로
오인하지 않습니다.
