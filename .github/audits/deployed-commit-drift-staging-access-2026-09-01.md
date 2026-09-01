# Deployed Commit Drift 실패 분석 — staging이 Cloudflare Access 뒤로 들어갔습니다

**작성 2026-09-01. 대상 워크플로 `.github/workflows/deployed-commit-drift.yml`
(workflow id 343425610). 상태: 해소됨 — §8.**

§0~§7은 조사 시점(게이트가 열리기 전)의 기록으로 그대로 둡니다. 조치와 그
결과는 §8, 구현은 §9입니다.

## 0. 결론

**워크플로는 고장나지 않았습니다. staging이 답을 안 줍니다.**

`https://staging.tomverse.app/api/build-info` 가 2026-08-26 결정대로 켜진
Cloudflare Access 게이트 뒤로 들어갔습니다. 인증 없는 요청은 앱에 닿지 못하고
Access 로그인 호스트로 302 되며, 스크립트가 그 리다이렉트를 따라가서 받는 것은
로그인 페이지의 `text/html` 200입니다. `commitSha`가 없으므로 판정은 `UNKNOWN`
이고, `--gate`는 `UNKNOWN`을 통과시키지 않습니다.

`UNKNOWN`을 실패로 세는 것은 결함이 아니라 이 워크플로가 존재하는 이유입니다.
스크립트가 그 자리에 주석으로 적어 뒀습니다 — *"'확인 못 했다'는 '괜찮다'가
아니고, 신호의 부재를 문제의 부재로 읽은 것이 바로 production이 한 시간 묵은
커밋을 서비스하게 둔 일"*. 그러므로 **게이트를 느슨하게 하는 방향의 수정은
답이 아닙니다.**

그리고 이 사고의 범위는 워크플로 하나가 아닙니다. §5를 보십시오.

## 1. 관측

### 1.1 실패 이력

20회 실행 전부 `conclusion: failure` 입니다 — 2026-08-27T03:06Z의 최초
`workflow_dispatch` 실행부터 2026-08-31T23:52Z까지. **이 워크플로는 한 번도
초록이었던 적이 없습니다.**

로그는 처음·중간·최신 세 회차를 읽었습니다(run 1 / run 14 / run 20). 세 회차
모두 staging 줄이 동일합니다.

| run | 시각(UTC) | production | staging |
|---|---|---|---|
| 1 (33035373037) | 2026-08-27T03:09 | 4 커밋 뒤, 38분 — 임계 내, 통과 | `cannot compare — no commit reported` |
| 14 (33325467585) | 2026-08-30T17:31 | 2 커밋 뒤, 1177분 — **임계 초과** | `cannot compare — no commit reported` |
| 20 (33452467422) | 2026-08-31T23:52 | `in sync at a37f11a9` | `cannot compare — no commit reported` |

### 1.2 최신 회차 로그 원문

```
production: in sync at a37f11a9.
  branch main, threshold 60 minutes
staging: cannot compare — no commit reported.
  https://staging.tomverse.app/api/build-info: HTTP 200 (text/html) did not
  return JSON. The first bytes were "<!DOCTYPE html>\n<html>\n  <head>\n    <tit"
  — something in front of the app is answering instead of the app.
  branch develop, threshold 60 minutes

1 environment needs attention.
```

### 1.3 게이트 실측 (2026-09-01T00:11Z, 이 컨테이너에서)

```
GET https://staging.tomverse.app/api/build-info
  → HTTP/2 302
    location: https://sparkling-rain-1619.cloudflareaccess.com/cdn-cgi/access/login/staging.tomverse.app?...
    www-authenticate: Cloudflare-Access resource_metadata="https://staging.tomverse.app/.well-known/cloudflare-access-protected-resource/"
    set-cookie: CF_AppSession=...
    server: cloudflare

GET https://staging.tomverse.app/            → 302, 같은 Access 로그인 호스트
GET https://staging.tomverse.app/api/health  → 302, 같은 Access 로그인 호스트
GET https://staging.tomverse.app/robots.txt  → 200  (설계대로 공개)
GET https://tomverse.app/api/build-info      → 200 JSON, commitSha a37f11a9…
```

`redirect_url=%2Fapi%2Fbuild-info`, `auth_status: "NONE"`,
`service_token_status: false`. 게이트가 이 경로에 실제로 걸려 있고, 서비스 토큰도
제시되지 않았다는 뜻입니다.

## 2. 왜 실패하는가 — 코드 경로

`scripts/report-deployed-commit-drift.mjs`의 `fetchDeployedSha()`는 fetch 기본
동작대로 **리다이렉트를 따라갑니다**. 따라간 끝은 Cloudflare Access 로그인
페이지이고, 그것은 정상적으로 `200 text/html`을 냅니다. 그래서 스크립트가 보는
것은 "302 게이트"가 아니라 "JSON을 안 주는 200"입니다.

`{ sha: null }` → `deployedShaKnown = false` → `deployedCommitDrift()`가
`UNKNOWN` → `--gate`가 `exit 1`.

**진단 문구는 정확합니다** — "something in front of the app is answering instead
of the app"는 문자 그대로 맞습니다. 다만 그 앞단이 **Cloudflare Access**라고
이름을 대지 못하고, 그것이 이 실패를 하루 만에 못 읽고 지나가게 만든 부분입니다.

**같은 문제를 이미 푼 코드가 저장소에 있습니다.** `scripts/check-edge-robots.mjs`
는 `redirect: "manual"`로 읽고, 401·403과 *다른 호스트로 나가는 3xx*를 게이트로
인식합니다. 그 파일의 주석이 지금 상황을 미리 적어 놨습니다 — *"리다이렉트를
따라가면 로그인 페이지를 받게 되고, 그것은 '게이트가 켜져 있다'를 말하는 아주
혼란스러운 방식"*. drift 스크립트는 그 교훈을 받지 못했습니다.

## 3. 왜 이렇게 됐나 — 두 변경이 24시간 안에 각자 착지했습니다

| 시각(UTC) | 사건 |
|---|---|
| 2026-08-26 03:31 | `91766bc` — Access 도입 **결정** 및 `check:edge-robots`의 게이트 인식 |
| 2026-08-26 (문서 시점) | `docs/ops/staging-access-boundary.md` §2가 인바운드 호출자 목록을 확정 |
| ~2026-08-26/27 | Cloudflare Access가 **실제로 켜짐** (대시보드 작업, 저장소에 흔적 없음) |
| 2026-08-27 02:34 | `eb1e400` — drift 검사가 production에 착지 |
| 2026-08-27 03:06 | 최초 실행, 이미 staging HTML |

`staging-access-boundary.md` §2의 인바운드 호출자 표는 **2026-08-26에** 만들어
졌습니다. drift 검사는 **2026-08-27에** 태어났습니다. 그 표는 다시 읽히지
않았고, 새 호출자는 목록에 오르지 못했습니다.

반대편에서도 같은 일이 있었습니다. drift 스크립트는 헤더에
`/api/build-info`를 *"공개·비인증 (STG-F010) — 토큰도, 대시보드도 없다"* 고
적었습니다. 그 문장은 쓰일 당시 사실이었고, 하루 뒤 사실이 아니게 됐습니다.

§0의 bypass 목록은 세 접두어입니다 — `/api/internal/*`,
`/api/billing/webhook`, `/api/webhooks/*`(destination으로는 `/robots.txt`를
더해 넷). 전부 자체 인증을 갖고 있다는 것이 근거였습니다.
`/api/build-info`는 그 심사를 받은 적이 없습니다.

### 조사 자체가 같은 실수를 했습니다

이 문서의 §0~§7을 쓸 때 **`main`만 읽었습니다.** 그래서 처음 초안은
`docs/ops/staging-access-boundary.md`가 "Access 설정은 아직 안 됐습니다"라고
말한다며 문서가 낡았다고 적었습니다. `main`에서는 사실이고 **`develop`에서는
아닙니다** — develop은 2026-08-26에 이미 롤아웃을 기록했고, 302 거절 형태도,
path 접두어 매칭도, Railway 생성 도메인이 421로 막힌다는 것도 그쪽에 있습니다.
바로잡아 적습니다: **문서는 낡지 않았고, 이 조사가 한쪽만 봤습니다.**

AGENTS.md가 이미 그 문장을 갖고 있습니다 — *"내용 검사는 release branch마다
따로 합니다. develop과 main의 간격은 이슈마다 다르게 걸치므로, 한쪽만 읽고
'고쳐졌다'고 답하면 반대쪽에 대해 틀립니다."* 여기서는 반대 방향으로
틀렸습니다: 한쪽만 읽고 **"아직 안 고쳐졌다"** 고 답했습니다.

이것이 §3이 말하는 결함과 같은 모양이라는 점이 중요합니다. 인바운드 호출자
표는 **한 시점에** 만들어졌고 다시 읽히지 않았습니다. 이 조사는 **한 브랜치를**
읽고 나머지를 읽지 않았습니다. 둘 다 "확인한 범위"와 "결론의 범위"가 어긋난
것입니다.

## 4. 왜 "어제부터"로 보이는가

staging 줄은 첫 회차부터 계속 같았습니다. 바뀐 것은 **production 줄**입니다.

- 2026-08-30 전후: production도 임계를 넘겨서 `2 environments need attention`.
  이때의 production 실패는 **진짜 drift**였고 (`1177분`), 이 워크플로가 잡으라고
  만들어진 바로 그 사건입니다.
- 2026-08-31: production이 `in sync`로 회복. 남은 원인이 staging 하나가 되면서
  실패가 "매 시간 같은 이유로만 빨간" 모양이 됐습니다.

즉 어제 새로 생긴 고장이 아니라, **어제부터 다른 소음이 걷히고 원래 있던 결함
하나만 남은 것**입니다.

## 5. 이 사고의 진짜 범위 — 워크플로 하나가 아닙니다

`/api/build-info`를 게이트 뒤로 보낸 것은 drift 검사만 막은 게 아닙니다.
**staging 검증 절차 전체가 같은 endpoint를 요구합니다.**

- `docs/ops/assistant-profile-staging-checklist.md`:
  "staging이 서비스 중인 전체 40자리 deploy SHA를 `GET /api/build-info`에서"
- `docs/ops/assistant-package-import-staging-checklist.md`: 같은 문장
- `docs/ops/generated-artifacts-staging-checklist.md` **A-1**:
  "`GET /api/build-info`의 `commitSha`가 검증 대상 SHA와 같다"
- `docs/ops/chat-attachment-staging-checklist.md` **A-1**: 같은 항목, 유료 turn 0
- `.../assistant-knowledge-staging-verification-records/README.md`,
  `.../assistant-profile-staging-verification-records/README.md`,
  `.../chat-attachment-staging-verification-records/README.md`: 모두 같은 요구

기록 README들이 요구하는 첫 줄 — **"이 회차가 어느 커밋을 검증했는가"** — 를
지금은 브라우저로 Access에 로그인하지 않고서는 채울 수 없습니다.
AGENTS.md의 *"에이전트가 만들 수 있는 것을 사람에게 만들라고 하지 않습니다"*
관점에서, 이것은 자동으로 채워지던 칸이 사람 손으로 되돌아간 것입니다.

**그러므로 이것은 CI 하나의 문제가 아니라 staging 검증의 전제가 하나 사라진
문제입니다.** 선택지를 고르는 근거도 여기 있습니다.

## 6. 선택지

### A안 — Access bypass에 `/api/build-info`를 추가 (권고)

Cloudflare Zero Trust 정책에 네 번째 bypass 경로로 `/api/build-info`를
추가합니다. 대시보드 규칙 한 줄, 저장소 변경 0.

- **찬성**: STG-F010 계약(공개·비인증)이 그대로 유지되고, §5의 체크리스트 전부가
  아무 수정 없이 되살아납니다. drift 워크플로는 다음 정시 실행에 저절로
  초록이 됩니다.
- **경계에 관하여**: 이 endpoint는 `getPublicBuildInfo()`의 allowlist 필드만
  돌려주고 (`environment`, `commitSha`, `builtAt`, `deploymentId`,
  `deployedAt`, `deploymentStatus` 등 8개), 상태를 바꾸는 일이 없으며,
  `AUD-R002`와 두 차례 감사(`final-stg-reaudit-2026-07-28`)에서 민감정보 없음이
  확인됐습니다. **§0이 막으려던 위험은 "미출시 화면이 사람에게 읽히는 것"이고,
  커밋 SHA는 그 화면이 아닙니다.** `/robots.txt`를 공개로 남긴 것과 정확히 같은
  근거입니다 — 인증 없이 읽히는 것이 존재 이유인 응답.
- **반대**: bypass 목록이 셋에서 넷으로 늘고, 그 목록은 여전히 대시보드에
  삽니다(§3.A가 지적한 비용 그대로).

### B안 — Access service token을 워크플로에 넣습니다

`CF-Access-Client-Id` / `CF-Access-Client-Secret`을 repository secret으로 두고
스크립트가 staging 요청에만 붙입니다.

- **찬성**: 경계에 구멍을 내지 않습니다.
- **반대**: (1) §5의 사람 손 절차는 **여전히 막힌 채**입니다 — 체크리스트가
  요구하는 `curl`은 토큰을 안 갖고 있습니다. (2) 스크립트의 전제("토큰도
  대시보드도 없다")가 깨지고 staging 전용 분기가 생깁니다. (3) 토큰 수명·회전이
  새 운영 항목이 됩니다. **비용이 A안보다 크고, 문제의 절반만 풉니다.**

### C안 — staging leg를 게이트에서 빼거나 `UNKNOWN`을 통과로

**채택하지 않습니다.** §0에 적은 이유 그대로입니다. 이 워크플로에서 `UNKNOWN`을
통과시키면 남는 것은 production 한 줄이고, staging이 실제로 며칠째 옛 커밋을
서비스해도 아무도 모릅니다 — 지금 이 순간 실제로 아무도 모릅니다.

### 진단 개선 (어느 안을 고르든 별개로 권고)

`fetchDeployedSha()`를 `check-edge-robots.mjs`와 같은 모양으로 —
`redirect: "manual"`, 그리고 다른 호스트로 나가는 3xx·401·403을 "접근
게이트"라고 이름 대게 — 고칩니다. 지금 메시지는 맞지만 원인을 지목하지 못하고,
그래서 5일치 실패가 읽히지 않았습니다. **이것은 실패를 없애는 수정이 아니라
실패를 읽히게 하는 수정입니다.** A안을 적용해도 게이트가 다시 이 경로를 덮으면
그때 바로 이름이 나와야 합니다.

## 7. 확인되지 않은 것

작성 시점(게이트가 열리기 전)의 기록입니다. 첫 항목은 §8에서 답이 나왔습니다.

- ~~**staging이 지금 어느 커밋을 서비스 중인지 모릅니다.**~~ 게이트가 답을 가리고
  있었고, 이 컨테이너에서는 Access에 로그인할 수 없었습니다. drift가 있을 수도,
  없을 수도 있었습니다 — **그것이 이 실패가 오탐이 아니었던 이유입니다.**
  → 열고 보니 `4b618702`로 동기화 상태였습니다(§8). **모른다는 것이 문제였지,
  뒤처져 있었던 것이 문제가 아니었습니다.**
- **Access를 정확히 언제 켰는지는 저장소로 알 수 없습니다.** 대시보드 작업이고
  commit이 없습니다. 2026-08-27T03:09Z 이전이라는 것만 로그로 확정됩니다.
- **bypass 세 접두어가 지금도 살아 있는지 확인하지 않았습니다.** Stripe test
  mode 결제와 크론 한 바퀴는 §0의 절차 4번 항목이고, 이 분석의 범위 밖입니다.
  A안을 적용할 때 같이 확인하는 것이 자연스럽습니다.
- 2026-08-30의 production 1177분 drift는 **별개의 실제 사건**입니다. 지금은
  해소됐지만 원인은 이 문서가 조사하지 않았습니다.

## 8. 해소 (2026-09-01T01:47Z)

1. ~~A안 적용~~ — 완료. Zero Trust에 `/api/build-info` bypass가 추가됐습니다.
2. ~~`docs/ops/staging-access-boundary.md` 갱신~~ — 완료. §0에 "다섯 번째
   destination" 절을 붙이고, §2 호출자 표에 `/api/build-info` 두 행을
   추가했습니다. 그 문서의 롤아웃 기록 자체는 develop에 이미 있었으므로
   덮어쓰지 않고 이어 붙였습니다.
3. ~~`fetchDeployedSha()`의 게이트 인식~~ — 완료. §9.
4. ~~스크립트 헤더 주석의 "토큰도, 대시보드도 없다"를 사실에 맞게~~ — 완료.

**5일 만에 처음으로 통과합니다.**

```
production: in sync at a37f11a9.
staging:    in sync at 4b618702.
exit 0
```

그리고 이 회차가 답한 질문 하나 — **staging은 drift 중이 아니었습니다.**
§7에 "있을 수도, 없을 수도"라고 적었던 항목이고, 게이트가 열리자마자 확인됐습니다.

`check:edge-robots`도 두 origin 모두 통과합니다(§0 순서 3번).

세 bypass 접두어는 다시 확인했습니다 — `/api/billing/webhook` 405,
`/api/webhooks/email/resend` 405, `/api/internal/maintenance/cleanup` 405
(GET이라 405). **새로 알아낸 것은 아닙니다**: boundary 문서가 2026-08-26에 이미
같은 것을 401·503으로 기록해 뒀고, 이번 확인은 build-info destination을 추가한
뒤에도 그 셋이 그대로인지 본 것입니다.

어느 쪽이든 **게이트 층에서만 확인된 것**입니다. 405는 요청이 앱에 닿는다는
뜻이지 서명 검증과 크론이 끝까지 돈다는 뜻이 아니고, 실제 Stripe test mode 결제
한 건과 크론 한 바퀴(§0 순서 4번)는 여전히 회차에 붙여 사람이 볼 항목입니다.

`/api/health`는 게이트 뒤에 남았습니다. §2가 적어 둔 대로 무해합니다 — Railway
healthcheck는 컨테이너로 직접 가므로 Cloudflare 앞단을 지나지 않습니다.

### 남은 것 하나 — 이 워크플로는 감시받지 않습니다

**20회 연속 실패가 5일 동안 아무에게도 닿지 않았습니다.** 이 문서가 조사한 결함은
고쳐졌지만, 그것을 발견하게 만든 것은 알림이 아니라 사람이 우연히 본 것입니다.
`Deployed Commit Drift`는 다른 무엇도 지켜보지 않는 것을 지켜보라고 만든
워크플로인데, 정작 그것이 빨간 것을 지켜보는 것이 없습니다.

이 문서의 범위 밖이고, 여기 적어 두는 것이 그것이 잊히지 않는 유일한 방법입니다.

## 9. 구현한 것 (2026-09-01)

실패를 없애는 수정이 아니라 **읽히게 하는** 수정입니다. 판정은 그대로
`UNKNOWN` → 실패입니다.

**게이트 인식을 순수 함수로 옮겼습니다.**
`classifyBuildInfoResponse()`와 `describeEndpointFailure()`가
`report-deployed-commit-drift-core.mjs`에 있습니다. 판정이 fetch 호출 안에
있었기 때문에 `check-edge-robots.mjs`가 이미 배운 것이 이 파일에 전달되지
못했습니다 — 이제 둘 다 같은 단어(`ACCESS_GATE`)로 같은 관측을 말하고, 이쪽은
테스트가 있습니다(`tests/deployedCommitDrift.test.mjs`, 20개 통과).

**리다이렉트를 나눠서 다룹니다.** `redirect: "manual"`로 읽되, **같은 origin에
머무는 3xx는 따라가고**(최대 3홉) **origin을 떠나는 3xx는 게이트**입니다.
`check:edge-robots`처럼 전부 안 따라가면 `STAGING_APP_URL`로 호스트를 바꾼
평범한 설정이 장애로 보고됩니다.

**메시지는 본 것을 먼저, 해석을 나중에 말합니다.** origin을 떠나는 리다이렉트는
호스트 rename도 같은 모양이고 이 모듈은 둘을 구분하지 못합니다. 그래서
"Cloudflare Access다"라고 단정하지 않습니다.

바뀐 출력:

```
staging: cannot compare — no commit reported.
  https://staging.tomverse.app/api/build-info: HTTP 302 to
  sparkling-rain-1619.cloudflareaccess.com — the request did not reach the app.
  An access gate answers an unauthenticated request this way. This endpoint is
  public by design (STG-F010), so the exemption belongs in the gate
  (docs/ops/staging-access-boundary.md), not in a credential here.
```

**덤으로 고친 것 하나.** JSON은 왔는데 `commitSha` 필드가 없는 응답은 이전에
커밋도 오류 줄도 없이 지나갔습니다 — 로그에서는 endpoint를 아예 안 물어본 것과
같아 보입니다. 이제 그렇게 말합니다(`NO_COMMIT_SHA`).

응답 본문은 모든 경로에서 읽습니다
(`.github/audits/unconsumed-response-bodies-2026-08-13.md`).

**확인한 것**: production은 `in sync at a37f11a9`로 그대로 통과하고(리다이렉트
처리를 바꿔도 회귀 없음), staging은 위 문구로 `--gate` 종료 코드 1입니다.
**확인 못 한 것**: 이 컨테이너에 `node_modules`가 없어 `npm run lint`를 돌리지
못했습니다. PR Fast Gate가 봅니다.
