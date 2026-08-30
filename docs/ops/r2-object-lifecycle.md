# R2 object lifecycle — 무엇을 규칙으로 지우고, 무엇을 절대 지우지 않는가

작성일: 2026-08-28. 계약은 `docs/policy/user-attachment-persistence.md` §7·§11.
이 문서는 그 계약을 **live bucket에서** 확인하고 고치는 절차다.

## 1. 왜 이 문서가 있는가

production release `16d98af8`에서 로그인 사용자의 첨부 객체가 업로드 약 26시간
뒤에 사라졌다. `MessageAttachment` 행은 남아 있었고, tombstone은 없었고,
`boundAt`은 정상이었다 — 애플리케이션의 삭제 경로는 어느 것도 그 객체를 지우지
않았다. 22시간 된 두 번째 객체는 남아 있었다. 시간 기반 bucket lifecycle 규칙
말고는 그 패턴을 설명하는 것이 없다.

그 결과는 저장소 오류로 보이지 않았다. 이후 모든 turn이 `AI_PROVIDER_ERROR`로
끝났고 두 개의 provider가 자기와 무관한 장애로 기록됐다(§11.1).

## 2. 보호 prefix — 규칙으로 지우면 안 되는 것

| prefix | 무엇 | 누가 지우는가 |
|---|---|---|
| `attachments/` | 로그인 사용자가 보낸 파일 | 대화·계정 삭제 시 애플리케이션 |
| `message-artifacts/` | 답변이 만든 파일 | 대화·계정 삭제 시 애플리케이션 |
| `images/` | 생성 이미지 | 대화·계정 삭제 시 애플리케이션 |
| `assistant-knowledge/` | assistant profile 지식 | profile 삭제 시 애플리케이션 |

만료가 허용되는 prefix는 `guest-attachments/` 하나뿐이며, 그 sweep조차 bucket
규칙이 아니라 애플리케이션 코드(`listExpiredR2Objects`)다. bucket 규칙을 두는
것은 이중 안전장치일 뿐이다.

목록의 출처는 `scripts/check-r2-lifecycle-policy-core.mjs`의
`PROTECTED_OBJECT_PREFIXES`이고, `tests/r2LifecyclePolicy.test.mjs`가 그것이
`lib/`의 상수와 일치함을 강제한다.

## 3. 현재 상태 읽기 (read-only)

**어디서**: 로컬 PC의 PowerShell, Tomverse clone 폴더 안. Node 22와 `npm ci`가
끝나 있어야 한다. production 서버에 들어갈 필요는 없다 — R2는 인터넷 API이고,
필요한 것은 버킷 설정을 읽을 권한이 있는 토큰뿐이다. 환경변수는 그 PowerShell
창에서만 유효하다.

```powershell
$env:R2_ACCOUNT_ID        = "..."
$env:R2_ACCESS_KEY_ID     = "..."
$env:R2_SECRET_ACCESS_KEY = "..."
$env:R2_BUCKET_NAME       = "..."

npm run check:r2-lifecycle-policy
npm run check:r2-lifecycle-policy -- --json > lifecycle-before.json
```

규칙을 **보기만** 할 것이라면 clone도 `npm ci`도 필요 없다: Cloudflare
대시보드의 R2 → 버킷 → Settings → Object lifecycle rules에 prefix와 만료
일수가 그대로 나온다. 이 스크립트는 그 화면을 판정으로 바꾸고 기록 파일을
남기기 위한 것이다.

- S3 호출 **한 번**(`GetBucketLifecycleConfiguration`)이고 아무것도 쓰지 않는다.
- 종료 코드: `0` 문제 없음 · `2` 보호 prefix를 덮는 활성 삭제 규칙 있음 ·
  `1` 설정을 읽지 못함(= 확인하지 못한 것이지 문제없는 것이 아니다).
- prefix가 없는 규칙은 **전체 bucket**으로 취급한다. S3가 그렇게 취급하기
  때문이다. 이것이 사고의 형태였다.
- 출력에 object key·bucket 이름·endpoint·자격증명은 없다. 규칙 id와 규칙
  prefix는 출력된다 — 그것이 발견 내용 자체다.

토큰에 `s3:GetLifecycleConfiguration` 권한이 없으면 `1`로 끝난다. 권한을 준
토큰으로 다시 실행한다. 실패를 `0`으로 만들지 않는다.

## 4. 변경 절차 — 순서를 바꾸지 않는다

1. **애플리케이션을 먼저 배포한다.** 누락 객체 처리(§11.4)와 provider 경계
   축소(§11.5)가 production에 올라간 뒤에야 lifecycle을 만진다. 순서가 반대면
   그 사이에 누락된 파일이 계속 provider 장애로 기록된다.
2. `/api/ready`, chat smoke, provider health 기록을 확인한다.
3. `lifecycle-before.json`을 남긴다(3절).
4. 변경안을 적는다 — **현재 JSON, 변경 후 JSON, 영향 prefix, rollback 방법**.
5. **승인을 받는다.** lifecycle 편집은 bucket의 모든 객체에 한 번에 적용되며,
   되돌려도 이미 지워진 bytes는 돌아오지 않는다. 승인 없이 실행하지 않는다.
6. 적용 후 `npm run check:r2-lifecycle-policy`로 read-back 한다.
7. 전수 감사(5절)를 돌린다.

### 4.1 사고 당시의 규칙과 대체안

빈 prefix에 1일 만료가 걸려 있었다면(= 사고의 형태), 대체안은 다음 둘 중
하나다. **더 좁히는 쪽이 기본이다.**

```jsonc
// 변경 후 — guest 전용으로 좁힌다
{
  "Rules": [
    {
      "ID": "expire-guest-attachments",
      "Status": "Enabled",
      "Filter": { "Prefix": "guest-attachments/" },
      "Expiration": { "Days": 1 }
    }
  ]
}
```

또는 규칙 자체를 제거한다. 게스트 sweep은 애플리케이션이 이미 수행하므로
규칙이 없어도 게스트 객체는 정리된다.

**rollback**: `lifecycle-before.json`의 `Rules`를 그대로 다시
`PutBucketLifecycleConfiguration` 한다. rollback은 설정만 되돌리며, 그 사이에
규칙이 지운 객체는 되돌리지 못한다 — 그래서 rollback은 안전망이 아니라
마지막 수단이다.

## 5. 전수 감사

**어디서**: 로컬 PC의 PowerShell, Tomverse clone 폴더 안 — 3절과 같은 곳이다.
R2 환경변수 넷에 더해 **production `DATABASE_URL`**이 필요하다(행을 읽어야
하므로). Railway 컨테이너 안에서는 돌리지 않는다: `tsx`가 devDependency라
production 이미지에 없을 수 있다.

**먼저**: 이 clone이 최신인지 확인한다. 운영자의 작업 폴더는 대개 배포된
schema보다 오래됐고, 그러면 Prisma client가 가용성 컬럼을 모른다.

```powershell
git pull
npm ci        # postinstall이 Prisma client를 다시 만든다
```

그리고 **migration이 production DB에 적용돼 있어야 한다**
(`20260828090000_message_attachment_availability`). 적용은 배포가 하는 일이며
여기서 하지 않는다 — `prisma migrate dev`를 production에 대고 실행하지 않는다.
읽기 전용 확인만 한다면 `npx prisma migrate status`가 `DIRECT_DATABASE_URL`
또는 `DATABASE_URL`을 읽어 무엇이 적용됐는지 보고한다.

둘 중 하나가 어긋나면 감사 도구가 Prisma stack trace 대신 어느 쪽 문제인지와
고치는 방법을 한 문단으로 말하고 멈춘다. 아무것도 읽지 않고 아무것도 쓰지
않는다.

```powershell
$env:DATABASE_URL         = "<production Postgres URL>"
$env:R2_ACCOUNT_ID        = "..."
$env:R2_ACCESS_KEY_ID     = "..."
$env:R2_SECRET_ACCESS_KEY = "..."
$env:R2_BUCKET_NAME       = "..."

npm run audit:message-attachments -- --json > attachment-audit.json
npm run audit:message-attachments -- --cursor='<이전 실행이 출력한 값>'
```

**npm script로 부른다.** 이 스크립트는 `--conditions=react-server`가 없으면
뜨지 않는다 — `lib/r2.ts`가 `server-only`를 import 하는 모듈을 거치고, 그
조건 없이는 "This module cannot be imported from a Client Component module"로
죽는다. package.json의 script가 그 플래그를 들고 있으므로, script를 부르면
플래그를 빠뜨릴 수 없다. 직접 부를 때는 이 형태여야 한다.

```powershell
node --conditions=react-server --import tsx scripts/audit-message-attachment-objects.mjs --json > attachment-audit.json
```

- 기본은 dry run. 아무것도 쓰지 않는다.
- 상태는 넷이다: `available` · `missing` · `temporarily_unreachable` ·
  `metadata_mismatch`. **`temporarily_unreachable`을 손실로 세지 않는다** —
  자격증명 회전이나 bucket 장애 중에 돌리면 이 칸이 커지고, 그것을 손실로
  보고하면 잘못된 숫자가 인시던트 채널에 붙는다.
- 보고서에는 attachment id, conversation id, 생성 시각, media type, 상태,
  storage status만 들어간다. object key·파일명·본문·이메일은 없다.
- 요약은 검사하지 **않은** 행 수를 함께 말한다. 부분 실행을 전체 실행처럼
  읽는 것이 이 도구가 막으려는 실패다.

dry run 결과를 검토한 뒤에만 기록한다.

**어디서**: 위와 같은 PowerShell 창(같은 환경변수). **이 명령만 DB에 쓴다.**

```powershell
npm run audit:message-attachments -- --apply --ticket=OPS-<번호>
```

`--apply`는 **확정된 404 행에만** `unavailableAt`을 쓴다. 행도 객체도 지우지
않고, 메시지도 카드도 건드리지 않는다.

## 6. 사라진 bytes는 복구되지 않는다

lifecycle 규칙을 고치는 것은 **앞으로의 손실만** 막는다. 이미 삭제된 객체는
백업이나 원본이 없는 한 복구할 수 없고, 이 저장소에는 첨부 객체의 백업이 없다.

- DB 행을 지우지 않는다. `unavailable`로 표시하고 카드를 남긴다.
- 사용자의 복구 경로는 **다시 첨부하는 것** 하나다. 제품이 그것을 안내한다
  (`ATTACHMENT_UNAVAILABLE`, `chat.attachmentUnavailable`).
- 감사 보고서에 "복구 가능"이라고 적지 않는다.

## 7. 오염된 provider health

사고 기간에 `AI_REQUEST_FAILED.NotFound`로 기록된 이벤트 중 일부는 R2 404였다.

- **감사 이벤트를 삭제하거나 소급 수정하지 않는다.** `ProviderErrorEvent`는
  기록이며, 잘못된 기록을 지우면 잘못이 있었다는 사실도 지워진다.
- **aggregate bucket을 직접 수정하지 않는다.**
- 확정적으로 local/storage로 분류할 수 있는 것은 **알려진 trace와 누락
  attachment가 연결된 사건**뿐이다(§11.1의 두 trace). 나머지는 그대로 둔다.
- 차단 상태 해제는 기존 절차만 쓴다: `POST /api/admin/provider-health/verify`
  로 **실제 live verification**을 성공시킨 뒤 `POST
  /api/admin/provider-health/recover`. verification 없이 recover 하지 않는다.
- 앞으로는 storage·application 오류가 `ProviderErrorEvent`,
  `ProviderHealthState.consecutiveFailures`, `model-health-5m`,
  `provider-health-5m/day`에 들어가지 않는다 — 진단 코드 root가
  `PROVIDER_CALL_DIAGNOSTIC_ROOTS` 밖이고, route가 `ProviderCallRecord` 없이는
  기록 자체를 하지 않기 때문이다.

## 8. drift 감시

- `npm run check:r2-lifecycle-policy` — live bucket, fail-closed. 운영 점검이며
  PR gate가 아니다(자격증명이 없는 환경에서는 `0`으로 "not configured").
- `tests/r2LifecyclePolicy.test.mjs` — 판정 로직과 보호 prefix 목록. PR에서
  `npm run test:unit`으로 돌아간다.
- 릴리스 점검 때 3절을 다시 실행하고 `--json` 출력을 기록에 첨부한다.
