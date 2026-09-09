# Daily Security Audit 실패 분석 — Next.js RCE advisory와 WebKit에 없는 recorder (2026-09-09)

대상 run: [#63 · 34289773698](https://github.com/mposition/Tomverse/actions/runs/34289773698)
(schedule, `main` @ `4b2a0cf`, 2026-09-08 23:15:06Z ~ 23:58:07Z)

전날 보고서 `daily-security-audit-gitleaks-npm-audit-2026-09-08.md`의 두 항목
(secret scan, 그날의 advisory 6건)은 PR #1275·#1276 병합 뒤 이 run에서 초록으로
돌아왔습니다. 이번에 빨간 것은 **다른 둘**입니다.

```
##[error]Production dependency audit finished with status failure.
##[error]Full desktop and mobile E2E finished with status failure.
```

나머지 10개 — secret scan 포함 — 는 `success`입니다.

## 1. Production dependency audit — 하루 사이에 새로 공개된 advisory

`npm audit --omit=dev`를 `main` @ `4b2a0cf`의 lockfile로 로컬 재현한 결과,
critical 1·high 1입니다. 둘 다 전날 run 뒤에 공개됐고, 둘 다 **직접 의존성**
입니다.

| 패키지 | 설치됨 | advisory | 조치 |
|---|---|---|---|
| `next` | 16.3.1 | GHSA-p293-qw3h-jr36 (critical, `>=16.0.0 <16.3.3`) — Windows 호스트 서버의 인증 없는 RCE / GHSA-2xp9-vwfh-vxw4 (critical, 같은 범위) — Image Optimization API의 AVIF 처리에서 인증 없는 RCE | `16.3.1` → `16.3.4`(npm이 이름 댄 fix 버전, semver patch). `eslint-config-next`도 같은 버전으로 |
| `sharp` | 0.35.3 | GHSA-rgj7-g3m4-5g8c (high, `<0.35.4`) — 번들된 libheif의 취약점 둘 | `^0.35.3` → `^0.35.4`. `overrides.sharp`는 `$sharp`라 함께 움직입니다 |

두 번째 advisory가 이 앱에 실제로 닿는지는 판단하지 않았습니다 — 배포는
Linux이고 `next/image`가 AVIF를 받는지는 설정에 달려 있지만, **critical
등급의 RCE에 대해 "우리는 해당 없음"을 근거로 patch를 미루는 것은 이 gate가
막으려는 결정입니다.** patch 버전이고 build·typecheck·unit·E2E가 그대로
통과하므로 올립니다.

dev 의존성 쪽 `js-yaml` 4.3.1(GHSA-2883-xcg3-v3hh, high)도 같이 4.3.2로
올렸습니다. nightly는 `--omit=dev`라 이것 때문에 붉어지지는 않지만, 전체
`npm audit`도 0건으로 두는 편이 다음 사람이 읽을 때 덜 헷갈립니다.

## 2. E2E — shard 5, `mobile-safari`의 voice input 14건

shard 5/6에서 14 failed / 773 passed. 실패는 **전부**
`tests/e2e/voice-input-composer.spec.ts`의 `mobile-safari` project이고, 다른
다섯 shard와 `mobile-safari`의 다른 spec은 통과했습니다.

이 spec은 PR #1288("Bring Voice Input to main, flag off")로 `main`에 들어왔고,
**WebKit에서 실행된 것은 이 run이 처음입니다.** PR gate와 `Main Chromium
Regression`은 Chromium project만 돌리고, `mobile-safari`를 돌리는 workflow는
daily audit 하나뿐입니다(`grep -l webkit .github/workflows/*`).

### 2.1 무엇이 보였나

열세 건은 같은 줄에서 같은 모양으로 죽었습니다.

```
Locator: getByTestId('voice-input-status-row')
Expected: visible
Error: element(s) not found
```

열네 번째(`a denied microphone explains itself`)가 답을 말해 줍니다.

```
Locator:  getByTestId('voice-input-error')
Expected: "VOICE_PERMISSION_DENIED"
Received: "VOICE_UNSUPPORTED_BROWSER"
```

즉 버튼을 누르는 순간 앱이 **"이 브라우저는 녹음할 수 없다"**고 판정해
status row 대신 오류를 그렸습니다. 이 판정은 `useVoiceRecorder.ts`의
`pickMimeType()`이고, `MediaRecorder.isTypeSupported()`가
`VOICE_RECORDER_MIME_PREFERENCE`의 네 컨테이너(`audio/webm;codecs=opus`,
`audio/webm`, `audio/mp4;codecs=mp4a.40.2`, `audio/mp4`) 전부에 `false`를
돌려줄 때만 나옵니다.

**제품 결함이 아닙니다.** docs/policy/voice-input.md §8.6이 요구하는 fail-closed
동작 그대로입니다. 결함은 spec에 있습니다 — "모든 project가 실제 `MediaRecorder`로
녹음할 수 있다"는 전제로 쓰였는데, Playwright가 Linux에 배포하는 WebKit은 그
class는 있으되 codec이 없습니다. 실제 Safari는 `audio/mp4`를 녹음하고, 그
Safari는 정책 문서 §5.2가 이미 "이 컨테이너에서 관측할 수 없는 유일한 엔진"
으로 적어 둔 것입니다.

같은 파일에서 통과한 것들이 이 진단과 맞습니다: `installUnsupportedRecorder`로
`MediaRecorder`를 일부러 지우는 spec, flag off spec, 녹음 없이 rect만 재는
geometry spec.

### 2.2 무엇을 고쳤나

`installFakeMicrophone`이 이제 페이지 로드 전에 엔진에게 묻습니다 —
`MediaRecorder.isTypeSupported()`가 제품이 요구하는 네 컨테이너 중 하나에라도
`true`인가. 그러면 지금까지처럼 **실제 recorder**를 씁니다. 아니면, 그리고
그때만, 어댑터가 부르는 것과 같은 표면(`start`·`stop`·`state`·세 handler)을
가진 **stub**을 세우고, 녹음 길이에 비례하는 크기의 클립을 실제 recorder와
같은 순서(`stop()` 반환 뒤 `dataavailable`, 그다음 `onstop`)로 돌려줍니다.

- **allowlist를 넓히지도, spec을 skip하지도 않습니다.** `mobile-safari`에서
  이 14건은 이제 실행되고, WebKit의 layout 위에서 machine·draft·session
  경계·geometry를 증명합니다.
- **증명하지 않는 것도 적어 둡니다.** 그 project에서 컨테이너 바이트는 검증되지
  않습니다. 그것은 실제 Safari에서 하는 staging 검증의 몫이고(정책 §5.2),
  어느 recorder로 돌았는지는 각 test에 `voice-recorder: native|stub`
  annotation으로 남아 보고서가 둘을 섞지 못합니다. `MediaRecorder`를 일부러
  지운 spec은 `none`입니다.
- **"녹음할 수 없는 브라우저" spec은 그대로입니다.** 그 spec은 marker를 먼저
  놓고 `MediaRecorder`를 지우므로, stub이 그 자리를 대신 채우지 않습니다.
- **stub 경로는 Chromium에서 먼저 돌려 봤습니다.** `VOICE_E2E_STUB_RECORDER=1`이
  엔진에 실제 recorder가 있어도 stub을 강제하는 검증용 스위치이고, 아래
  표가 그 결과입니다. 이 컨테이너는 proxy가 Playwright CDN을 막아 WebKit을
  받을 수 없으므로, WebKit 자체에서의 실행은 **다음 nightly가 첫 확인**입니다.
  (Chromium 실행도 같은 이유로 컨테이너에 미리 깔린 build를
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE`로 지정해 돌렸습니다 — 이 spec에는 screenshot
  golden이 없어 canonical 여부는 결과에 영향이 없습니다.)

## 3. 검증

| 검사 | 결과 |
|---|---|
| `npm audit --omit=dev` / 전체 `npm audit` | 0건 / 0건 |
| `npm run check` (ESLint + production build, next 16.3.4) | 통과 |
| `npm run typecheck` | 통과 |
| `npm run test:unit` | 통과 |
| `npm run security:regression` | 통과 |
| voice spec, desktop-chromium + mobile-chromium, native recorder | 38 passed / 6 skipped(geometry는 desktop 전용), annotation `native` 36 |
| voice spec, 같은 두 project, `VOICE_E2E_STUB_RECORDER=1` | 38 passed / 6 skipped, annotation `stub` 34 + `none` 2("녹음 불가 브라우저" spec) |
| WebKit(`mobile-safari`)에서의 실행 | 이 컨테이너에서 불가 — 다음 nightly |

## 4. 병합

`main`과 `develop` 양쪽에 필요합니다. spec은 두 branch가 같은 파일이고,
`package.json`의 세 줄도 같습니다. lockfile은 전날과 같은 이유(develop은
prisma 7.10.0)로 develop 쪽에서 다시 해석합니다.
