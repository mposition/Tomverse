# 음성 대화와 Voice Recovery 설정 안내

이 문서는 설정 방법을 설명합니다. 문서를 열거나 APK를 설치하는 것만으로 서버 음성이 활성화되지는 않습니다.
음성 운영 활성화와 실제 유료 음성 시작 검증은 모바일 대화 관리 기능 배포 승인과 별개입니다.

## 1. 변수는 어디에 입력하나요?

운영 서버 설정은 **PC 폴더가 아니라 Railway 웹 대시보드**에 입력합니다.

1. Railway에서 **Tomverse 프로젝트**를 엽니다.
2. 상단 환경을 **production**으로 선택합니다. `dev`나 `staging`이 아닌지 확인합니다.
3. 아래 표에 표시한 **서비스 카드**를 클릭합니다.
4. 서비스 안의 **Variables** 탭을 엽니다.
5. **New Variable**로 이름과 값을 하나씩 추가합니다. 여러 개는 **Raw Editor**에 `이름=값` 형식으로 입력할 수 있습니다.
6. 저장 후 변경 목록을 검토하고 **Deploy**합니다. 저장만 하고 배포하지 않으면 실행 중인 프로세스에는 반영되지 않습니다.

| Railway 위치 | 담당 기능 | 입력할 주요 변수 |
| --- | --- | --- |
| Tomverse 프로젝트 → production → **Tomverse** → Variables | 앱의 음성 시작 요청과 크레딧 예약 | `VOICE_CONVERSATION_ENABLED`, `VOICE_CONVERSATION_API_KEY` |
| Tomverse 프로젝트 → production → **Voice Recovery** → Variables | 연결이 끊긴 세션 종료·정산 복구, 생존 신호 기록 | `VOICE_CONVERSATION_WATCHDOG_ENABLED`, 같은 운영 DB·서명키·음성키·예산 참조 |

같은 프로젝트 안에서도 **서비스별·환경별 Variables는 다릅니다**. 웹 서비스에 넣은 값이 worker에 자동으로 생기지 않습니다.
앱 내부 설정, Android Studio, `apps/mobile`, Windows 환경변수에 넣어도 Railway 운영 서버 설정은 바뀌지 않습니다.

## 2. 900초 제한 제거와 크레딧 예약

연속 음성 대화 버전은 `VOICE_CONVERSATION_MAX_SECONDS`를 사용하지 않습니다. **이 버전의 서버와 Voice Recovery 배포가 완료된 뒤** production → Tomverse → Variables에서 기존 변수를 삭제할 수 있습니다. 이전 서버에서는 변수를 삭제해도 기본 300초가 적용되므로 제한이 없어지지 않습니다.

- 한 연결의 총 시간을 제한하는 대신 짧은 구간씩 크레딧과 공급자 예산을 추가 예약합니다. 최초 예약은 종료 여유 30초를 포함해 최대 60초·36크레딧이며, 잔액이 적으면 더 작은 구간으로 시작합니다.
- 기존 요금제·구매 크레딧과 사용자·공급자의 일/월 시간 및 비용 한도를 그대로 적용합니다. 갱신할 예산이 없으면 이미 예약한 범위 안에서 종료합니다.
- 정상 연결에서는 같은 세션을 유지합니다. 공급자의 세션 만료나 연결 끊김이 발생했을 때 새 유료 세션을 자동으로 시작하지 않습니다.
- 사용하지 않은 크레딧은 정산 후 반환하며, 세션 누적 시간으로 한 번 반올림합니다. 분당 36크레딧 요율은 바뀌지 않습니다.
- 앱·웹 프로세스가 끊기면 Voice Recovery가 DB의 최신 예약 마감 시각을 읽어 종료·정산합니다.

## 3. Voice Recovery 서비스를 먼저 준비합니다

이 worker는 웹 서버와 별도로 계속 실행됩니다. 앱이나 웹 프로세스가 끊겨도 남은 세션을 종료하고 정산 상태를 복구합니다.
실제 스크립트는 저장소 루트의 `scripts/voice-conversation-watchdog.mjs`, 실행 명령은 `npm run voice:watchdog`입니다.

production에 Voice Recovery 카드가 없다면 기존 dev 서비스의 production 인스턴스를 준비합니다.
Railway의 **production → Sync → 원본 dev**를 사용할 때는 변경 상세를 보고 **Voice Recovery 추가 항목만** 남깁니다.
다른 운영 웹·DB 설정을 dev 값으로 바꾸지 않습니다. 봉인된(sealed) 비밀값은 Sync로 복사되지 않으므로 비밀 관리 경로에서 별도로 등록합니다.

**Voice Recovery → Settings**에 적용할 값:

| 항목 | 값 |
| --- | --- |
| Repository | `mposition/Tomverse` |
| Branch | 음성 코드가 반영된 `main` |
| Root Directory | `/` — 저장소 루트 |
| Builder | Railpack |
| Build Command | `npx prisma generate` |
| Start Command | `npm run voice:watchdog` |
| Replicas | 항상 실행되는 1개 |
| Restart Policy | Always |
| Cron Schedule | 비워 둠 |
| Public Domain / HTTP Healthcheck | 불필요 — 이 worker는 HTTP 서버가 아님 |
| Pre-deploy migration | 비워 둠 — 웹 서비스에서 적용한 DB 스키마 사용 |

`C:`나 `H:`로 시작하는 PC 경로는 Railway의 Root Directory에 넣지 않습니다.

## 4. Voice Recovery → Variables에 넣을 값

먼저 다음 네 항목을 **Voice Recovery 서비스**에 입력합니다.

```dotenv
VOICE_CONVERSATION_WATCHDOG_ENABLED=true
NODE_ENV=production
APP_ENV=production
TOMVERSE_DEPLOY_ENV=production
```

아래 값은 **동일한 production Tomverse 서비스의 값**을 참조합니다. 기존 승인된 예산을 유지합니다.

```dotenv
DATABASE_URL=${{Tomverse.DATABASE_URL}}
DIRECT_DATABASE_URL=${{Tomverse.DIRECT_DATABASE_URL}}
NEXTAUTH_SECRET=${{Tomverse.NEXTAUTH_SECRET}}
ADMIN_AUDIT_INTEGRITY_KEY=${{Tomverse.ADMIN_AUDIT_INTEGRITY_KEY}}
VOICE_CONVERSATION_API_KEY=${{Tomverse.VOICE_CONVERSATION_API_KEY}}
VOICE_PROVIDER_SECONDS_PER_DAY=${{Tomverse.VOICE_PROVIDER_SECONDS_PER_DAY}}
VOICE_PROVIDER_SECONDS_PER_MONTH=${{Tomverse.VOICE_PROVIDER_SECONDS_PER_MONTH}}
CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY=${{Tomverse.CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY}}
CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH=${{Tomverse.CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH}}
```

이는 비밀값을 문서에 복사하는 대신 Railway의 서비스 참조를 입력하는 예입니다.
원본에 없는 변수의 참조를 그대로 만들지 않습니다. 먼저 원본 서비스에 실제 값이 등록되어 있는지 확인합니다.
봉인된 값은 읽을 수 없는 상태여도 이미 설정된 것입니다. 누락으로 판단해 덮어쓰지 않습니다. 참조가 지원되지 않는 경우 비밀 관리 경로에서 worker에 직접 등록합니다.

웹 서비스에 다음 값도 명시되어 있다면 worker에 같은 값/참조를 설정합니다.

- `ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS`
- `VOICE_INPUT_SECONDS_PER_DAY`

worker에는 `VOICE_CONVERSATION_ENABLED`나 `VOICE_CONVERSATION_MAX_SECONDS`를 별도로 넣을 필요가 없습니다.
복구는 DB에 저장된 각 세션의 마감 시각과 예약 정보를 사용합니다.

## 5. Tomverse → Variables에 넣을 값

worker를 먼저 실행하고 생존 신호를 확인한 뒤, **음성 운영 활성화 승인이 있을 때** 다음 값을 웹 서비스에 적용합니다.

```dotenv
VOICE_CONVERSATION_ENABLED=true
```

`VOICE_CONVERSATION_API_KEY`에는 전용 음성 공급자 키를 Railway의 비밀값 입력란으로 등록합니다.
위 예시에 키를 덧붙여 Git·채팅·Start Command에 저장하지 않습니다.
worker에서도 같은 운영 키를 사용해야 합니다. 일/월 시간 및 공급자 비용 예산도 기존 승인 범위의 값이 필요합니다.

**두 서비스 모두** `VOICE_CONVERSATION_KILL_SWITCH`는 정상 운영 시 없거나 빈 값이어야 합니다.
`false`라는 글자도 비어 있지 않은 문자열이어서 긴급 중지로 처리됩니다. `false`를 넣어 끄려 하지 않습니다.

## 6. 반영 순서와 성공 확인

1. 운영 웹 배포와 음성 DB 스키마 적용이 성공했는지 확인합니다.
2. Voice Recovery 설정을 배포하고 상태가 **SUCCESS**인지 확인합니다.
3. worker가 계속 실행되며 DB 생존 신호가 갱신되는지 확인합니다. 약 2초마다 갱신하고 서버는 최근 15초 이내 신호를 요구합니다.
4. 그다음 승인된 웹 음성 활성화 설정을 배포합니다.
5. 로그인된 계정으로 `/api/products/chat/capabilities`를 읽어 `voiceConversation.enabled: true`를 확인합니다. 비로그인 응답만으로 판단하지 않습니다.
6. 업데이트된 APK를 완전히 종료했다가 다시 열어 기능 상태를 새로 읽습니다.

DB 확인이 필요하면 **운영 DB에 연결된 승인된 SQL 클라이언트에서 다음 읽기 전용 쿼리**를 사용합니다. 운영 DB 읽기 권한이 필요합니다.

```sql
SELECT "key", "updatedAt"
FROM "ChatUsageBucket"
WHERE "key" = 'voice-conversation:watchdog';
```

새로고침할 때 `updatedAt`이 계속 갱신되어야 합니다. `VOICE_RECOVERY_UNAVAILABLE`는 worker 생존 신호가 충분히 최신이 아니라는 뜻입니다.
`Voice recovery cycle deferred.`가 반복되면 DB 연결·스키마·공급자 키·운영 환경 참조를 점검합니다.
worker는 새 유료 음성 세션을 만들지 않지만 기존 세션 종료·정산 상태를 기록합니다. 앱의 실제 음성 **시작**은 유료 호출이므로 별도 승인 범위입니다.

## 7. PC에서 진단할 때의 폴더

로컬 PC PowerShell에서 **스크립트와 package.json이 모두 있는 checkout 루트**를 사용합니다.
먼저 Node 22와 의존성을 준비하고, 위 환경변수는 승인된 비밀 관리 경로로 주입합니다. 아래 명령은 worker를 실행해 DB에 기록하는 작업이며 단순 읽기 검사가 아닙니다.

```powershell
Set-Location '<checkout>'
$env:VOICE_CONVERSATION_WATCHDOG_ENABLED='true'
npm run voice:watchdog
```

이 명령은 `.env.local`을 자동으로 읽지 않습니다. 스위치 한 개만 넣고 나머지 DB·키를 생략하면 정상 실행되지 않습니다.
로컬 진단은 테스트 DB로 하고, 운영 자격증명을 넣으면 실제 운영 복구 상태를 변경한다는 점을 구분합니다.
운영에서는 PC 절전·터미널 종료의 영향을 받지 않도록 Railway worker를 사용합니다.

공식 참고: [서비스별 Variables 입력 및 참조](https://docs.railway.com/variables), [환경 구분과 Sync](https://docs.railway.com/environments).
