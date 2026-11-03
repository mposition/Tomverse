# 마케팅 webhook 운영 활성화 (Zernio)

운영자 지시 2026-11-03. 정책 정본은 `docs/policy/marketing-automation.md` §8.1.1이고, 이 문서는 그 정책을
운영에서 실제로 켜는 순서만 적습니다. 구현이 이 문서와 다르면 이 문서가 낡은 것입니다.

## 1. 2026-11-03 관측 (읽기 전용)

| 항목 | 관측 |
|---|---|
| Zernio 등록 webhook | 1개: Test 수신기(`https://staging.tomverse.app/api/webhooks/zernio`). `accountIds`는 **Test 계정 6개로 한정**이라 운영 계정의 이벤트는 어디로도 가지 않습니다 |
| Zernio 한도·동작 | 사용자당 최대 50개. `accountIds`·`profileIds`가 비어 있으면 **모든 프로필의 이벤트**를 받습니다. 서명 secret은 webhook마다 직접 지정. 2xx를 5초 안에 못 받으면 최대 7회 재시도, 3일간 성공이 없고 연속 실패하면 자동 비활성 |
| 운영 `ZERNIO_WEBHOOK_SECRET`, `ZERNIO_API_KEY` | 둘 다 설정됨. API key는 Test와 같은 workspace, **secret은 Test와 다른 값** |
| 운영 `RAILWAY_ENVIRONMENT_NAME` | `production`(명시 라벨이라 서명·수신 조건 충족). `MARKETING_AUTOMATION_KILL_SWITCH` 없음 |
| 운영 수신 route | `POST https://tomverse.app/api/webhooks/zernio`에 서명 없는 요청 → 401 `signature_invalid`, `pipeline` 표식 `faf980dd…` (Test와 같음). 404가 아니므로 production 설정 세대가 읽히는 상태 |
| 운영 `webhookProductionConfig` | 세대 1 (2026-10-16), 기록 `2026-10-15__…-scoped`, 지문 `643befaf…`. **현재 빌드 지문 `faf980dd…`와 달라 낡았고**, 그 뒤에 운영 채널 6개가 생겨 digest도 다릅니다 |
| 운영 `webhookApplyScope` | 세대 1 + 위 기록 + `post.platform.published × cmuqszzy8001q02taeknyo0vs` |
| 운영 채널 | instagram-1/2/3, facebook-1/2/3 (모두 `approval_mode`, Zernio 계정 연결됨). YouTube 채널 **없음** |

## 2. 오늘 서명된 범위로는 Instagram을 적용할 수 없습니다

`2026-11-02__zernio-youtube-platform-published-main`이 관측한 쌍은 `post.platform.published × cmuqszzy8001q02taeknyo0vs`
하나이고, 그 채널은 **Test DB의 YouTube 채널**입니다. 이유가 셋입니다. 하나만 있어도 막힙니다.

1. 기록의 쌍은 채널 **id**로 적히고 id는 DB마다 다릅니다. 운영 Instagram 채널(`…41nu9z`, `…jmijxb`, `…r0yqg0`)은
   어떤 기록에도 없으므로 apply scope 저장이 `scope_not_observed`로 거절됩니다. 지금 운영에 저장된 scope의 채널 id는
   운영에 존재하지 않아 어떤 이벤트와도 맞지 않습니다.
2. 어떤 서명 기록도 Instagram 쌍을 관측하지 않았습니다(관측된 쌍은 YouTube 하나). 정책은 검증하지 않은 채널·계정으로 통과를 넓히지 않습니다.
3. 서명된 운영 설정 세대(1)가 낡았습니다. 지문이 다르고(`production_config_fingerprint_stale`), 채널이 늘어
   digest도 다릅니다(`production_config_snapshot_mismatch`). 새 세대 서명이 필요합니다.

**지문을 바꾸는 코드 변경은 하지 않았고 필요하지도 않습니다.** 위 장벽은 모두 운영 절차와 staging 관측으로 풉니다.

## 3. 두 단계로 나눕니다

- **A. 수신만(지금 가능, 게시 상태에 영향 없음):** 운영 webhook만 등록합니다. 현재 운영 수신기는 서명을 검증한 뒤
  판정이 "아직 적용 불가"라고 답하면 게시물을 읽지도 쓰지도 않고 `marketing_webhook.status_refused`
  (`apply_not_permitted`, 닫힌 사유 목록)만 감사에 남기고 2xx를 돌려줍니다. 정책 §8.1은 검증 전 webhook을 상태·공개 여부·
  자동 정지의 근거로 쓰지 않는 것을 요구하고, A는 그것을 어기지 않습니다(shadow가 아니라 이미 구현된 거절 경로입니다. shadow는 staging 전용).
  이점은 다음입니다.
  - Zernio → 운영 경로(WAF, 운영 secret, 응답 5초 이내)를 실제 게시로 미리 확인합니다. 응답 본문의 `pipeline` 표식이 Zernio 로그에 남습니다.
  - 이벤트별 수신 증거: Zernio 로그(eventId, 시각, 상태)와 운영 감사 행(event id digest, event type, 채널 id)을 게시마다 대조할 수 있습니다.
    게시물 id와 도출 상태는 감사 행에 없습니다. 어느 게시의 이벤트인지는 Zernio 로그의 payload로 봅니다.
  - 201 처리 중 응답을 상태 조회로 확정하는 경로(별도 작업)와 독립이라, 둘이 어긋나면 알 수 있습니다.
  - 비용: 이벤트마다 감사 행 1개(해시 체인). 각 행이 "refused"로 보이는 것이 정상입니다.
- **B. Instagram 상태 반영(추가 검증 필요):** 아래 5절. staging 관측 → 새 기록 → release → 서명 → scope 순서입니다.

## 4. 운영자 단계표

공통: **로컬 PC, PowerShell, 저장소 루트**(develop 이상, `npm ci` 완료). `<proj>` = `0c5f17ad-a42a-4fa8-a245-bcd6a3275a35`.
secret과 API key는 Railway가 환경으로 넣어 주며 출력되지 않습니다. 명령은 모두 이 저장소 script입니다.

### A. 수신만

| # | 하는 일 | 위치·명령 | 읽기/쓰기 |
|---|---|---|---|
| A1 | 현재 등록 확인 | `railway run -p <proj> -e production -s Tomverse -- node scripts/marketing/zernio-webhook-setup.mjs status` | 읽기 (Zernio GET) |
| A2 | 생성 요청 미리보기 | `railway run -p <proj> -e production -s Tomverse -- node scripts/marketing/zernio-webhook-setup.mjs create --url https://tomverse.app/api/webhooks/zernio --account-id 6ae6ac2c44b52aadcc1c915e --account-id 6ae6f3b53e52fa618d4075ce --account-id 6ae6f3ee74e3769aea1f54df --account-id 6ae6f479498918de64343179 --account-id 6ae6f47a498918de6434317a --account-id 6ae6f47a498918de6434317b` | 읽기. `problems: []`인지 확인. Instagram만 받으려면 앞의 3개만 |
| A3 | **등록(운영자 몫)** | A2 명령 끝에 `--execute --confirm-url https://tomverse.app/api/webhooks/zernio` | **쓰기**(Zernio에 webhook 생성). 운영 `ZERNIO_WEBHOOK_SECRET`이 Zernio로 전달됨 |
| A4 | 첫 게시 후 수신 확인 | `railway run -p <proj> -e production -s Tomverse -- node scripts/marketing/zernio-webhook-setup.mjs logs --url https://tomverse.app/api/webhooks/zernio` | 읽기. `http: 200`, `answer: not_applied`, `pipeline: faf980dd`가 정상 |
| A5 | 감사 행 확인 | Admin › Audit에서 action `marketing_webhook.status_refused`, 사유 `apply_not_permitted` | 읽기 |

A3 전에 확인할 것: Zernio 대시보드의 같은 URL 중복이 없을 것(스크립트가 거절함), 오늘 Instagram 게시 전에 등록해야 첫 게시의 이벤트를 받습니다.
되돌리기: Zernio 대시보드에서 해당 webhook 삭제 또는 비활성. 앱 쪽 상태는 바뀌지 않습니다.

**A 이후 하지 말 것:** `ZERNIO_WEBHOOK_SECRET`·`ZERNIO_API_KEY`·`APP_ENV`·`RAILWAY_ENVIRONMENT_NAME`·`TOMVERSE_DEPLOY_ENV` 교체,
운영 채널 추가·재연결은 서명된 세대의 digest를 움직입니다. 서명 전이면 무해하고, 서명 후면 새 세대 서명 전까지 적용이 멈춥니다(상태 조회는 그대로).

## 5. B. Instagram 상태 반영

관측 대상은 **실제 운영 Instagram 계정의 이벤트를 운영 채널 id로** 보는 것입니다. 그러려면 staging이 그 계정의 이벤트를 받고, 그 채널을 운영과 같은 id로 알아야 합니다.

| # | 하는 일 | 위치·명령 | 읽기/쓰기 |
|---|---|---|---|
| B1 | Test DB에 운영 채널 id를 가진 행 추가(3개). 값은 Admin › Marketing › Accounts의 운영 채널 id와 위 계정 id. **행은 삭제할 수 없으니 먼저 dry-run** | `railway run -p <proj> -e staging -s Tomverse -- node --conditions=react-server --import tsx scripts/marketing/mirror-channel-to-staging.mjs --channel-id cmvxc448h004u02rkua41nu9z --channel instagram --account-ref 6ae6ac2c44b52aadcc1c915e --slug instagram-11` (나머지 둘은 `--channel-id cmvxk2luj00h602nsx2jmijxb --account-ref 6ae6f3b53e52fa618d4075ce --slug instagram-12`, `--channel-id cmvxk4xjn00hi02ns2ur0yqg0 --account-ref 6ae6f3ee74e3769aea1f54df --slug instagram-13`) | dry-run은 읽기. `--execute`를 붙이면 **Test DB 쓰기**(감사 행 없음) |
| B2 | Test webhook `6abf8be5a395cde1b302b4a9`의 `accountIds`에 운영 Instagram 계정 3개 추가 | Zernio 대시보드(수정 API의 method가 문서에 없어 대시보드로) | **쓰기**(Zernio) |
| B3 | Instagram 게시를 일으킨다(운영 실제 게시). 운영(A)과 staging 둘이 같은 이벤트를 받습니다 | 운영 Admin에서 평소처럼 | 운영 쓰기(원래 하던 게시) |
| B4 | 조건 1–5를 새 staging 설정(채널이 늘어 digest가 바뀜) 아래에서 채웁니다. C3(재전송)은 `railway run -e staging … node <scratch zernio-redeliver 방식>`, C4는 Admin › Marketing › Webhook shadow의 fault arm으로 11-02 때와 같은 방식 | staging | 쓰기(staging만) |
| B5 | 새 기록 초안: staging이 돌리는 commit을 체크아웃하고 `railway run -p <proj> -e staging -s Tomverse -- npm run marketing:webhook-record -- --record-id <날짜>__zernio-instagram-platform-published --executor <이름> --commit <sha> --receiver-url https://staging.tomverse.app/api/webhooks/zernio` (먼저 `--write` 없이: 빠진 조건과 쌍이 출력됨) | staging 읽기, `--write`는 로컬 파일 생성 | 기록은 immutable |
| B6 | 기록 PR → develop → `main:next` 라벨 → release train → 운영 배포. **지문이 그대로여야** 기록이 유효합니다 | GitHub | 병합·배포(운영자) |
| B7 | 운영 Admin › Marketing에서 기록 서명 → 운영 설정 서명(새 세대, 지금 digest 포함) → apply scope 저장(기록이 관측한 Instagram 쌍만) | 운영 Admin(`marketing:write` + step-up) | **쓰기**, 감사 체인 |
| B8 | 다음 Instagram 게시에서 `status_applied` 감사 행과 게시물 상태 이력(`webhook_event`)을 확인 | Admin › Audit | 읽기 |

기록은 **한 세대에 기록 하나**만 묶이므로 적용하려는 쌍을 모두 한 기록에 넣습니다(기록은 수정할 수 없습니다). Facebook도 쓰려면 같은 방식으로 채널을 mirror하고 같은 기록에서 관측합니다.
B7 이후에 운영 채널을 추가하거나 계정을 다시 연결하면 digest가 바뀌어 적용이 멈춥니다(`production_config_snapshot_mismatch`). 그때는 새 세대 서명만 하면 됩니다.
**운영에 mirror는 필요 없습니다.** B1은 Test DB만 바꿉니다.

## 6. 도구와 검증

- `scripts/marketing/zernio-webhook-setup.mjs`: `status`, `logs`, `create`. `create`는 기본 dry-run. URL은 `tomverse.app`/`staging.tomverse.app`의 수신 경로만 허용하고,
  프로세스의 환경 라벨과 URL의 환경이 다르면 거절합니다(Test secret을 운영 수신기에 등록하는 사고 방지). 계정 id를 하나도 주지 않으면 거절합니다.
- `scripts/marketing/mirror-channel-to-staging.mjs`: Test DB 전용(두 신호), dry-run 기본, `connect_pending` 한 행.
- 순수 판정은 `scripts/marketing/webhook-activation-core.mjs`, 테스트는 `tests/marketingWebhookActivationTools.test.mjs`.
- 지문은 `tests/marketingAutomationAccess.test.mjs`의 "pipeline fingerprint is current"가 지킵니다.
