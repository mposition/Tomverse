# Daily Security Audit 실패 분석 — E2E 단계가 예산을 넘겼습니다 (2026-09-01)

대상 run: [#54 · 33454811006](https://github.com/mposition/Tomverse/actions/runs/33454811006)
(schedule, `main` @ `a37f11a`, 2026-09-01 00:27:19Z ~ 03:04:32Z)

## 1. 무엇이 실패했나

**`Enforce security audit result`가 exit 1로 끝났고, 그 안에서 빨간 항목은 하나뿐입니다.**

```
##[error]Full desktop and mobile E2E finished with status failure.
```

나머지 11개 검사는 전부 `success`입니다 — secret history scan, node setup, install,
production dependency audit, security regression, unit·API policy tests, strict
encoding, typecheck, ESLint·production build, Playwright browser setup, report
delivery. **이번 실패는 보안 검사가 무언가를 발견한 것이 아닙니다.**

그리고 E2E 단계가 실패한 이유는 테스트가 틀렸다고 말했기 때문이 아닙니다.

```
2026-09-01T03:04:26.5210779Z ##[error]The action 'Run full desktop and mobile E2E suite' has timed out after 150 minutes.
```

단계 시작 00:34:14, 종료 03:04:26 — **150분 12초, step timeout에 정확히 걸린 값**입니다.
직전 run [#53 · 33341432212](https://github.com/mposition/Tomverse/actions/runs/33341432212)
도 23:25:14 → 01:55:27로 같은 150분 13초입니다.

## 2. 어디까지 갔나

잘리기 직전 마지막 줄:

```
✓  6136 [mobile-chromium] › tests/e2e/mobile-composer-banner-reflow.spec.ts:894:7 ...
```

현재 트리의 전체 규모는 `playwright test --list` 기준 **6832 tests in 132 files**입니다.
즉 스위트의 약 90% 지점에서 시간이 끊겼습니다. 나머지 약 700건은 실행되지 않았고,
**이 run은 그 700건에 대해 아무것도 보고하지 않습니다.**

마지막으로 스위트를 완주한 run은
[#48 · 32901455456](https://github.com/mposition/Tomverse/actions/runs/32901455456)
(8/25)이고, 그 요약은 이렇습니다.

```
2 failed
  [mobile-safari] › tests/e2e/generated-artifact-card.spec.ts:629:5 › a narrow panel in a wide window stacks the card @ui-risk
  [mobile-safari] › tests/e2e/generated-artifact-card.spec.ts:671:5 › a failure in a narrow panel keeps a readable sentence and its own row @ui-risk
1 flaky
  [mobile-safari] › tests/e2e/pricing-promotion-currency.spec.ts:326:7 › ... a fixed-amount promotion in USD subtracts exactly its own amount @ui-risk
1667 skipped
4994 passed (1.9h)
```

**이 두 건은 8/25 이후 한 번도 재확인되지 않았습니다.** 이후 run들은 전부 스위트가
끝나기 전에 잘렸으므로, 고쳐졌는지 남아 있는지 이 저장소는 지금 답할 수 없습니다.

## 3. 왜 예산을 넘었나 — 개수가 아니라 속도입니다

| | run #48 (8/25) | run #54 (9/1) |
|---|---|---|
| 스위트 규모 | 6664 (4994+2+1+1667) | 6832 (현재 트리 기준) |
| E2E 소요 | 112분 48초 (완주) | 150분 (6136에서 잘림) |
| 인덱스당 평균 | 1.02초 | 1.47초 |

테스트 수는 6664 → 6832로 **2.5%** 늘었습니다. 그것만으로는 완주하던 스위트가
150분을 넘길 수 없습니다. 인덱스당 평균이 **1.02초 → 1.47초로 약 44% 느려진 것**이
실제로 예산을 넘긴 원인입니다.

(skip 비율이 두 run에서 같다고 가정하면 실제 실행된 케이스 기준으로는 1.37초 → 1.96초.
#54는 완주하지 못해 자체 skip 수를 보고하지 않으므로 이 환산은 가정 위에 있습니다.
가정 없이 확실한 것은 인덱스당 평균 쪽입니다.)

같은 기간 `tests/e2e`에는 46개 파일이 바뀌며 +2368/-217줄이 들어갔습니다
(`2596e0ec..HEAD`) — web search suggestion/toggle, deep research expansion,
image 관련 스펙들이 새로 붙었습니다.

구조적으로 이 스위트는 CI에서 **worker 1개**로 **4개 프로젝트를 순차 실행**합니다
(`playwright.config.ts`: `fullyParallel: false`, `workers: process.env.CI ? 1 : 4`,
projects = desktop-chromium / desktop-compact / mobile-safari / mobile-chromium).
ubuntu-latest는 4 vCPU이므로 러너의 3/4은 이 두 시간 반 동안 놀고 있습니다.

## 4. 예산을 올리는 것은 이미 한 번 실패한 대응입니다

이 타임아웃은 처음이 아닙니다. 2026-08-19에 job을 120 → 180분으로 올리고 E2E 단계에
150분을 따로 준 커밋이 있고, 그 커밋 메시지 자체가 run #28~#32가 "cancelled라는 이름을
쓴 timeout"이었다고 적고 있습니다.

그 뒤 경과입니다.

```
#45  8/22  success
#46  8/23  failure   job 149분
#47  8/24  failure   job 157분
#48  8/25  failure   job 118분 — 완주, mobile-safari 2건 실패
#49  8/27  failure   job 157분
#50  8/28  failure   job 157분
#51  8/29  failure   job 158분
#52  8/29  failure   job 158분
#53  8/30  failure   job 158분 — E2E 150분 timeout 확인
#54  9/1   failure   job 157분 — E2E 150분 timeout 확인
```

150분 예산은 **6일 만에** 다시 한계에 닿았고(#47), 그 뒤로는 완주한 #48 한 번을 빼면
계속 같은 자리에서 끊기고 있습니다. #53·#54는 로그로 timeout을 직접 확인했고,
#49~#52는 job 총 소요가 157~158분으로 두 건과 동일해 같은 원인이 매우 유력하지만
로그로 직접 확인하지는 않았습니다.

숫자를 다시 올리면 다음 달에 같은 문서를 또 쓰게 됩니다. 스위트는 계속 자라고,
worker는 1개로 고정돼 있기 때문입니다.

## 5. 부수적으로 확인된 결함 — E2E 서버가 매 페이지마다 DB를 때립니다

로그의 대부분은 테스트 결과가 아니라 이 스택 트레이스입니다. 테스트 한 건마다 약 20줄씩,
2시간 30분 내내 반복됩니다.

```
[WebServer] Failed to load guest usage: PrismaClientKnownRequestError:
            Can't reach database server at 127.0.0.1:1
  code: 'P1001'
```

`playwright.config.ts`의 webServer는 `E2E_DISABLE_DATABASE: "true"`와 도달 불가능한
`DATABASE_URL`(`127.0.0.1:1`)로 서버를 띄웁니다. 그런데
`app/api/user/guest-usage/route.ts` → `getGuestUsageSnapshot()`
(`lib/chatSecurity.ts:1108`)은 `isE2EDatabaseDisabled()`를 확인하지 않고 곧장
`prisma.chatUsageBucket.findUnique()` 두 개를 실행합니다. 그래서 이 endpoint는
**E2E 실행 내내 500을 돌려주고 있습니다.**

결과는 두 가지입니다.

- **게스트 사용량 UI는 모든 E2E run에서 오류 상태로 렌더링됩니다.** 그 상태를 통과
  기준으로 삼은 스펙이 있다면, 그것은 배포되는 동작을 검증하고 있지 않습니다.
- **진짜 실패가 로그에 묻힙니다.** 실패 한 줄을 찾으려면 같은 스택 트레이스 수만 줄을
  지나야 하고, 이 문서를 쓰면서 실제로 그 때문에 #54의 개별 실패 목록을 확인하지
  못했습니다(아래 6절).

이것이 3절의 속도 저하 원인이라고 주장하지는 않습니다 — 측정하지 않았습니다.
`127.0.0.1:1`은 즉시 거부되므로 `connect_timeout=1`의 1초를 다 쓰지는 않을 것입니다.
다만 요청마다 Prisma 왕복 두 번과 500 응답 한 번이 추가되는 것은 사실이고,
확인은 별도로 필요합니다.

## 6. 확인하지 못한 것

정직하게 남깁니다.

- **#54에서 timeout 이전에 실제로 실패한 테스트가 있었는지 모릅니다.** GitHub API는
  job 로그의 tail만 돌려주고, 전체 로그 ZIP은 이 컨테이너의 egress proxy가
  `results-receiver.actions.githubusercontent.com`을 막습니다(403). mobile-safari
  구간은 tail에서 약 2만 줄 뒤에 있어 도달하지 못했습니다.
  → 사람이 [run #54 아티팩트](https://github.com/mposition/Tomverse/actions/runs/33454811006)
  (`security-audit-33454811006`, 14MB)의 `test-results/`를 열면 바로 보입니다.
- **8/25의 mobile-safari 실패 2건을 재현하지 못했습니다.** WebKit 바이너리 다운로드를
  proxy가 차단합니다(`playwright.download.prss.microsoft.com` 403). Chromium은
  이 컨테이너에 미리 설치돼 있지만 WebKit은 없고 받을 수 없습니다.
  → mobile-safari 재현은 CI나 실제 macOS/WebKit이 있는 환경의 몫입니다.

## 7. 무엇을 할 수 있나

우선순위 순으로, **아직 구현하지 않았습니다.**

1. ~~**스위트를 샤딩합니다.**~~ **완료 — 8절 참조.**
2. **CI worker 수를 올릴지 판단합니다.** `workers: 1`은 4 vCPU 러너에서 비쌉니다.
   다만 `chat-state-visual-regression.spec.ts`의 screenshot golden이 병렬 부하에
   민감할 수 있으므로, 골든 스펙만 worker 1로 남기고 나머지를 올리는 형태여야 합니다.
   `docs/qa/canonical-visual-baseline.md`를 먼저 읽고 결정할 일입니다.
3. **`/api/user/guest-usage`에 E2E 단락을 넣습니다.** `isE2EDatabaseDisabled()`일 때
   결정적인 스냅샷을 돌려주면, 로그가 조용해지고 게스트 사용량 UI가 E2E에서 실제로
   검증됩니다. 5절의 결함입니다.
4. **mobile-safari 2건을 처리합니다.** `generated-artifact-card.spec.ts:629`와 `:671`.
   1~3번이 되고 나면 매일 자동으로 재확인되지만, 그 전까지는 8/25 이후 아무도 보지
   못한 상태로 남아 있습니다.

1번이 없으면 2·3·4를 다 해도 다음 확장에서 같은 자리로 돌아옵니다.


## 8. 1번 조치 — 샤딩 (구현 완료)

`.github/workflows/daily-security-audit.yml`을 세 job으로 나눴습니다.

```
audit   정적·의존성·단위 검사 + 두 캐시(.next, ms-playwright) 워밍
e2e     matrix 6샤드, needs: audit, fail-fast: false
report  needs: [audit, e2e], if: always() — 리포트 발송과 최종 판정
```

**프로젝트가 아니라 `--shard`로 쪼갰습니다.** 프로젝트 분할은 `e2e.yml`이 이미
두 가지 이유로 거부한 방식입니다 — 프로젝트가 lopsided하고, `npm run test:e2e:run`
대신 프로젝트별 `playwright test` 호출로 바뀌어야 하는데 그 명령은
security-regression이 "아무도 이 실행을 조용히 좁히지 못하도록" 고정해 둔 것입니다.
`--shard`는 그 명령을 그대로 두고, 여섯 샤드의 합집합이 기존 단일 step이 실행하던
것과 정확히 같습니다.

측정한 분할입니다 (`--list --shard=i/6`, 2026-09-01, 이 트리):

```
1/6  1150   desktop-chromium 1150
2/6  1133   desktop-chromium  558   desktop-compact  575
3/6  1138   desktop-compact  1133   mobile-safari      5
4/6  1145   mobile-safari    1145
5/6  1133   mobile-safari     558   mobile-chromium  575
6/6  1133   mobile-chromium  1133
```

개수는 서로 1.5% 안에 들어옵니다. Playwright가 프로젝트 순서대로 자르기 때문에
샤드가 거의 프로젝트 경계와 일치하고, 이는 `e2e.yml`이 기록한 불균형(한 브라우저
안에서 무게가 흩어진 경우)과 다른 모양입니다. **남는 불균형은 엔진**입니다 —
WebKit이 3·4·5의 대부분을 갖고 있고 둘 중 느린 쪽입니다.

### 이 조치가 측정하지 못한 것

**샤드별 실행 시간은 재지 못했습니다.** 이 컨테이너는 WebKit을 받을 수 없고
(proxy 403), 2시간 반짜리 스위트를 돌릴 수도 없습니다. 그래서 `timeout-minutes: 75`는
개수 분할과 "엔진 하나가 더 비싸다"는 여유에서 나온 **ceiling이지 측정값이 아닙니다.**
워크플로 주석에도 그렇게 적혀 있습니다 — **첫 실행의 여섯 job 시간이 측정이고,
그것을 읽고 조여야 합니다.**

### 설계에서 지킨 것

- **`fail-fast: false`** — 실패한 샤드가 형제를 죽이면 빨간 spec 하나가 읽을 수 없는
  run이 됩니다.
- **집계는 `needs.e2e.result`** 하나로 하고, `skipped`·`cancelled`도 실패로 셉니다.
  실행되지 않은 샤드는 아무것도 검증하지 않았고, 그것을 통과로 세는 것이 집계 gate가
  gate 없이 초록이 되는 방식입니다. `e2e.yml`의 같은 판정을 그대로 옮겼습니다.
- **`Playwright browser setup`이 리포트에서 독립 항목으로 남습니다.** 브라우저 설치는
  audit job에 남겨 캐시를 한 번만 채우고, 그 결과를 job output으로 보고합니다.
  "브라우저를 못 깔았다"와 "테스트가 실패했다"의 구분은 run #33~#34에서 mobile-safari가
  몇 주간 조용히 실행되지 않았던 것을 진단 가능하게 만든 바로 그 구분입니다.
- **모든 샤드가 두 브라우저를 설치합니다.** 어느 샤드가 어느 프로젝트를 갖는지는
  현재 테스트 목록의 순서가 정하므로 spec 하나만 추가돼도 움직입니다. 지난달 필요했던
  브라우저만 까는 샤드는 skip이 아니라 launch 실패가 됩니다.
- **리포트 job 이름은 `Security audit and daily report` 그대로**입니다. 샤딩 이전에
  이 워크플로가 보고하던 이름을 지켜, 그 결과를 보던 것이 계속 찾을 수 있게 합니다.
- **아티팩트는 샤드별 이름**을 갖습니다. 하나의 이름을 두고 경쟁하면 첫 업로드만
  살아남습니다.
- `npm run security:regression`(188 checks)과 `npm run check:encoding:strict` 통과.
  이 워크플로에 걸린 substring 계약 — `npm run test:e2e:run`, `chromium webkit`,
  `--grep` 없음, `--update-snapshots` 없음, `check_result` 라벨들 — 이 모두 유지됩니다.

2·3·4번은 아직 그대로입니다.
