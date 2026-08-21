# 이메일 snapshot keyring 만들기와 회전

`EMAIL_SNAPSHOT_KEYS`는 standard lane이 발송 내용의 audit snapshot을 봉인하는
키입니다. 계약은 `docs/policy/email-notifications.md` §10.3이고, 이 문서는 그
값을 **어떻게 만들어 어떻게 넣는가**만 다룹니다.

**이 키가 없으면 메일이 지연되는 게 아니라 사라집니다.** enqueue가 예외를
던지고 호출부 넷이 그것을 삼키므로, 사용자의 본 작업은 성공하고 환영 메일·구독
시작 메일·삭제 예약 메일·복구 메일만 조용히 유실됩니다. `/api/ready`의
`emailSnapshotKeyring`이 그 상태를 거부하는 유일한 신호입니다.

## 1. 형식

```
EMAIL_SNAPSHOT_KEYS=v1:<secret>
EMAIL_SNAPSHOT_KEYS=v1:<secret1>,v2:<secret2>     # 회전 중
EMAIL_SNAPSHOT_KEY_VERSION=v2                      # 키가 둘 이상일 때만
```

- 쌍은 쉼표로 구분하고, 버전과 비밀은 **첫 콜론**으로 나눕니다.
- base64 알파벳(`A–Z a–z 0–9 + / =`)에는 쉼표도 콜론도 없으므로 비밀이
  구분자를 깨뜨릴 일은 없습니다.
- 키가 하나면 `EMAIL_SNAPSHOT_KEY_VERSION`은 두지 않습니다. 고를 것이 없는데
  변수를 요구하면 올바른 설정이 검사에서 떨어집니다.
- **키가 둘 이상이면 반드시 고정합니다.** 고정하지 않으면 새 snapshot을 봉인할
  버전이 나열 순서로 정해지고, `/api/ready`가
  `SNAPSHOT_ACTIVE_VERSION_UNPINNED` 경고를 냅니다.

## 2. 값 만들기

### PowerShell (Windows)

```powershell
.\scripts\New-EmailSnapshotKey.ps1
.\scripts\New-EmailSnapshotKey.ps1 -Version v2 -ExistingKeys "v1:AAAA...="
```

Windows PowerShell 5.1과 PowerShell 7 모두에서 동작합니다. 비밀은 화면에만
나오고 파일에 쓰지 않습니다. 스크립트가 버전 라벨의 구분자, 이미 있는 버전과의
충돌, 회전 시 `EMAIL_SNAPSHOT_KEY_VERSION` 필요 여부를 함께 판정합니다.

**본문을 이 문서에 옮겨 적지 않았습니다.** 두 벌이 되면 한쪽만 고쳐지고, 그
대상은 아무도 다시 유도할 수 없는 키입니다.

`-ExistingKeys`로 넘긴 값은 **명령줄에 남습니다.** PSReadLine이 켜져 있으면
`ConsoleHost_history.txt`에 기록되므로, 회전 뒤에는 그 줄을 지우십시오.

### 한 줄로 (openssl이 있을 때)

```
echo "v1:$(openssl rand -base64 32)"
```

### 한 줄로 (PowerShell, 스크립트 없이)

```powershell
$b=New-Object byte[] 32;$r=[Security.Cryptography.RandomNumberGenerator]::Create();$r.GetBytes($b);$r.Dispose();"v1:"+[Convert]::ToBase64String($b)
```

> `Get-Random`을 쓰지 마십시오. 암호학적 난수원이 아닙니다.

## 3. 넣는 순서

**환경변수를 먼저, 코드를 나중에.** 이 순서를 지키면 `/api/ready`가 빨간색이
되는 구간이 없습니다 — 배포된 코드는 변수가 없으면 무시할 뿐이고, 검사가
들어간 코드는 변수가 이미 있는 환경에 도착합니다.

1. staging에 설정 → 재배포 → `/api/ready`의 `emailSnapshotKeyring`이 `true`
2. production에 설정 → 재배포 → 같은 확인
3. 그 뒤 검사가 든 코드를 배포

`/api/ready`는 **배포된 프로세스의 환경**만 봅니다. 값을 저장했다는 것과 그
프로세스가 그 값을 읽는다는 것은 다른 사실이므로, 저장 후 재배포까지 확인해야
설정이 반영된 것입니다.

## 4. 회전

회전은 **추가**이지 교체가 아닙니다.

1. 새 버전을 만들어 기존 값 뒤에 붙입니다
   (`-Version v2 -ExistingKeys "<현재 값>"`).
2. `EMAIL_SNAPSHOT_KEYS`와 `EMAIL_SNAPSHOT_KEY_VERSION`을 **같은 저장에서**
   바꿉니다. 따로 저장하면 그 사이의 배포가 잘못된 버전으로 봉인하거나
   (`SNAPSHOT_ACTIVE_VERSION_UNKNOWN`) 아무것도 봉인하지 못합니다.
3. 이전 버전은 남겨 둡니다. 그 키로 봉인된 행이 남아 있는 한 계속입니다.

**빼도 되는 시점은 그 버전으로 봉인된 행이 하나도 남지 않았을 때뿐입니다.**
§10.3-3의 보관 기간(transactional·marketing 90일, legal 7년)이 하한이고,
`snapshotPurgedAt`이 찍힌 행은 값이 이미 `NULL`이라 세지 않습니다.

## 5. 확인

```
GET /api/ready
```

```json
{ "ok": true, "checks": { "emailSnapshotKeyring": true } }
```

`false`일 때 무엇이 문제인지는 구조화 로그의 `EMAIL_SNAPSHOT_KEYRING_NOT_READY`
이벤트가 말합니다. **그 메시지는 환경변수 값을 되돌려 적지 않습니다** — keyring
오설정은 대개 값을 엉뚱한 변수에 붙여 넣어 생기고, 여기서 엉뚱한 변수에 담기는
것은 키 자체이기 때문입니다. 버전 개수만 나옵니다.

| 코드 | 뜻 |
|---|---|
| `SNAPSHOT_KEYS_MISSING` | 변수가 없거나 공백입니다 |
| `SNAPSHOT_KEYS_UNPARSEABLE` | 설정돼 있는데 `version:secret` 쌍을 하나도 못 읽었습니다 |
| `SNAPSHOT_ACTIVE_VERSION_UNKNOWN` | `EMAIL_SNAPSHOT_KEY_VERSION`이 keyring에 없는 버전을 가리킵니다 |
| `SNAPSHOT_ACTIVE_VERSION_UNPINNED` | 경고. 키가 둘 이상인데 활성 버전이 고정되지 않았습니다 |
