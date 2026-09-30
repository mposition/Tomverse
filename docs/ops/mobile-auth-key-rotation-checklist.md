# 모바일 인증 키 회전 실행 점검표

`mobile-auth-key-rotation.md`가 절차와 근거를 설명하고, 이 문서는 **한 번의 실행에서
무엇을 했는지 셀 수 있게** 항목으로 펼칩니다. 결과는 여기에 적지 않습니다 —
`mobile-auth-key-rotation-verification-records/`에 **실행 1회 = 파일 1개**입니다.

template revision: `2026-09-03a`

**이 점검표는 staging flag 검증이 아닙니다.** 다른 점검표들과 기계는 같지만 대상이
다릅니다: 배포된 코드가 아니라 **운영자가 수행한 절차**를 기록합니다. 그래서 §A는
회전이 아닌 실행(§2.1 검사만 돌린 회차)에서도 혼자 쓰일 수 있습니다.

**비밀값을 적지 않습니다.** 링·pepper·access token·refresh token·`secretDigest`,
그리고 `MOBILE_AUTH_*`의 원문 값은 어떤 칸에도 넣지 않습니다. 적는 것은 **key id,
종료 코드, 검사기가 출력한 상태 단어, 남은 초**입니다. 이것이 이 기능에만 있는 규칙이고,
기록 README의 6번입니다.

## A. 배포 전 검사 (§2.1)

- [ ] 어느 값으로 돌렸는지 적었다 — `Active` / `Pending` / 손으로 넣은 값 중 하나
- [ ] `Check-MobileAuthKeyring.ps1`을 실행했고, 종료 코드를 적었다
- [ ] `-RequireConfigured`를 붙였는지 적었다 (모바일 인증을 서비스하는 배포라면 필수)
- [ ] 링 항목마다 검사기가 출력한 상태를 적었다 — `ACTIVE` / `RETIRED … (N s left of …)` /
      `UNDECLARED` / `RETIREMENT IN THE FUTURE`
- [ ] 은퇴 항목이 있다면 **남은 초**를 적었다 (유예는 은퇴 시각부터 흐릅니다)
- [ ] `op run`으로 링을 주입했다면 그 사실과 template 경로를 적었다

## B. 회전 (§3) — 회전을 수행한 회차만

- [ ] `rotationId`를 적었다
- [ ] store의 `Active`에서 현재 링을 읽었다 (읽지 못했다면 §5.1로 갔음을 적는다)
- [ ] `Pending`에 다섯 field를 적었다 — `rotationId` · `createdAt` · fingerprint ·
      target SHA · (배포 후) Railway deployment ID
- [ ] §2.1 검사를 **Pending 값으로** 통과시켰다
- [ ] **`Active`와 Railway가 일치**하는지 배포 **전에** 확인했다 (`-Mode preflight`)
- [ ] 배포 직전에 access token과 refresh token 시료를 **통제된 세션에서** 받았다
- [ ] 배포 직전에 남은 유예를 다시 확인했다
- [ ] 여덟 변수를 **단일 staged 배포**로 적용했고 deployment ID를 적었다

## C. 배포 후 확인 (§3의 6–8번)

- [ ] `Invoke-MobileAuthDeploymentVerify.ps1`을 **`-Mode`를 명시해** 실행하고 종료
      코드를 적었다
- [ ] 사례별 결과를 적었다 — `signing kid` · `signing key material` · `pepper kid` ·
      `pepper material` · `iss` · `aud` · `evidence is fresh` · 은퇴 선언
- [ ] 증거 수집에 쓴 exchange 세션을 **폐기**했다
- [ ] 이전 세대 확인의 **시료 유효성**을 먼저 판정했다 — access는 `exp`, refresh는
      미소비·미무효화와 family·device·계정 상태
- [ ] 감사 기록에서 이유를 읽었다 — `MobileAuthEvent`의 `event`·`reason`
      (공개 오류 코드로 추정하지 않았다)
- [ ] 승격 여부와 그 근거를 적었다. **미판정은 통과가 아니며**, 미판정으로 끝났다면
      §6의 6번에 따라 사람에게 올렸다

## D. 기록 자체

- [ ] 기준 SHA(배포가 서빙 중이던 40자리)를 적었다
- [ ] 실행 환경을 적었다 — 기계, 셸과 그 판본, 저장소 위치
- [ ] 실행한 명령을 **인수까지** 적었다 (비밀값 제외)
- [ ] 실행하지 않은 구획을 `미기록`으로 남겼다 (나중에 통과로 채우지 않았다)
- [ ] 비밀값·토큰·원문 환경변수가 기록에 없다
