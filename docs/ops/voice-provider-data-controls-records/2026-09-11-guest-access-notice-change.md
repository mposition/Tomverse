# 게스트 개방에 따른 고지 문구 변경 — 관측 기록 (승인 미기록)

**이 문서는 승인서가 아닙니다.** 관측만 적고 판정·서명 칸은 비어 있습니다.
채우는 것은 사람의 행위입니다(AGENTS.md "기록을 채우는 경계는 관측과 판정입니다").

## 1. 왜 이 기록이 있는가

`chat.voiceInput`의 마지막 문장이 2026-09-10에 바뀌었고, 그 변경은 **기존
승인이 덮는 revision보다 뒤**입니다. 승인은 문장이 아니라 SHA에 붙습니다
(docs/policy/voice-input.md §11.4).

바뀐 문구는 2026-09-11에 production에 배포됐습니다. **즉 이 문서가 기록하는
것은 "승인을 기다리는 변경"이 아니라 "승인 기록 없이 이미 노출 중인 문구"**
입니다. 그 차이를 흐리지 않기 위해 별도 파일로 둡니다.

## 2. 관측된 사실

| 항목 | 값 |
|---|---|
| 마지막으로 승인된 revision | `e8613a554bfbb22676a1be6552932954d79a88c8` |
| 그 승인 기록 | `2026-09-10-us-regional-endpoint.md` §13-1 |
| 문구를 바꾼 commit | `9b53ed72` (Admit guests to voice input, on the same limits as an account) |
| `main` 병합 | `77da3f41` (PR #1344) |
| production 배포 commit | `d2ebd52a` |
| 배포 완료(UTC) | 2026-09-11T00:55:31Z |
| 대상 locale | en · ko · zh · de · es · fr · pt (7개 전부) |

배포 SHA와 시각은 `GET https://tomverse.app/api/build-info`의 응답에서 읽었습니다.

## 3. 무엇이 바뀌었는가

**이전** — 게스트가 쓸 수 없다는 진술.

> Voice input is available only when you are logged in.
> 음성 입력은 로그인한 경우에만 사용할 수 있습니다.

**이후** — 로그인 여부와 무관하게 사용할 수 있다는 진술, 그리고 미로그인 시의
귀속 대상.

> Voice input is available whether or not you are signed in. When you are not,
> the request is attributed to the same anonymous identifier your other guest
> activity uses, and nothing about the recording is stored either way.
> 음성 입력은 로그인하지 않아도 사용할 수 있습니다. 로그인하지 않은 경우 해당
> 요청은 다른 게스트 이용과 동일한 익명 식별자에 귀속되며, 녹음은 어느 경우에도
> 저장되지 않습니다.

**바꾼 이유는 이전 문장이 거짓이 됐기 때문입니다.** 게스트 개방
(docs/policy/voice-input.md §4.2)이 그 문장의 전제를 없앴습니다. 문구를 그대로
두는 선택지는 없었습니다 — 틀린 고지를 유지하는 것이 승인 없는 고지보다 낫다고
볼 근거가 없습니다.

**국외이전 여덟 항목(`voiceInputTransfer1`–`8`)은 건드리지 않았습니다.** 전송되는
것, 국가, 시점, 수령자, 목적, 보관 기간, 거부 방법, 거부 비용 중 어느 것도 게스트
개방으로 달라지지 않습니다. 바뀐 것은 산문의 마지막 문장 하나뿐입니다.

## 4. 이 변경이 사실과 맞는지 — 대조된 것과 안 된 것

**대조됨.**

- 게스트가 실제로 admit됩니다: `lib/voiceInputAccess.ts`의 `voiceInputRefusal()`이
  `available`만 보고 `isSignedIn`을 읽지 않습니다.
- 미로그인 요청이 귀속되는 대상은 signed guest cookie에서 유도한
  `guest:<hash>`입니다: `identifyChatCaller()`, `lib/chatSecurity.ts`.
- "다른 게스트 이용과 동일한 식별자"가 참인 이유는 같은 `subjectKey`가 기존
  `ChatUsageBucket`을 그대로 쓰기 때문입니다 — 음성용 별도 식별자를 만들지
  않았습니다.
- 녹음을 저장하지 않는다는 진술은 바뀌지 않았고, 그 근거도 그대로입니다
  (docs/policy/voice-input.md §11.1).

**대조되지 않음.**

- **법률 검토.** 이 문서는 문구가 기술적 동작과 일치하는지만 대조했습니다.
  개인정보 처리방침 문장으로서 충분한지는 판정하지 않았습니다.
- **7-2~7-5의 잔여 위험**은 그대로 열려 있습니다
  (`2026-09-10-us-regional-endpoint.md` §7).

## 5. 승인 — 미기록

### 5.1 승인 대상 — 계산해 둔 것

**아래는 관측이지 승인이 아닙니다.** production에 실제로 배포된 commit
`d2ebd52a`에서 읽은 7개 locale 파일의 blob hash이고, 승인하실 때 그대로 인용할
수 있도록 미리 계산해 둡니다. 계산은 저장소 읽기뿐이라 자격증명이 필요 없습니다
(`git rev-parse d2ebd52a:locales/<locale>.ts`).

앞선 두 승인 중 첫 번째는 셋만 대표로 적어 두었다가 문구가 바뀌었을 때 무엇이
승인 대상이었는지 따져야 했습니다. 그래서 두 번째부터 전부 적으며, 여기도
7개 전부입니다.

| 파일 | blob hash @ `d2ebd52a` |
|---|---|
| `locales/en.ts` | `98af6776216bfeed5e4e7b29d900854213e64bdc` |
| `locales/ko.ts` | `ded7a6118178d0a4d51354fabf8708df7093df0c` |
| `locales/zh.ts` | `442796476aa830955654ebe99514b9d08fd97a78` |
| `locales/de.ts` | `2e15f24b80e6cfc0e0d485fcf232664c2db6dd2a` |
| `locales/es.ts` | `71ff4aaf95e59093cf0256320da47d938e472946` |
| `locales/fr.ts` | `fcde53d383182e515f801acac842dbc0127164bf` |
| `locales/pt.ts` | `bde105a0f7f6772bcaf6b80fab2387d4acf597c3` |

**이 파일들은 고지 문구만 담고 있지 않습니다.** locale 파일 전체의 hash이므로,
승인은 "이 revision의 이 파일들"에 붙고 그중 이번에 바뀐 것은 §3이 인용한 문장
하나입니다. 앞선 승인들도 같은 방식이었습니다.

### 5.2 판정과 서명 — 미기록

| 항목 | 값 |
|---|---|
| 판정 | (미기록) |
| 서명 | (미기록) |
| 직책 | (미기록) |
| 일자(UTC) | (미기록) |

**이 네 칸은 에이전트가 채우지 않습니다.** 판정과 서명은 사람의 행위입니다.

## 6. 남은 위험

**되돌릴 수 있는 것과 없는 것을 나눕니다**(AGENTS.md "검증 범위는 되돌릴 수 없는
것에 비례합니다").

- **되돌릴 수 있음** — 문구 자체. 틀렸다고 판정되면 고쳐서 배포하면 됩니다.
- **되돌릴 수 없음** — 이미 그 문구를 읽은 사용자에게 한 진술. 회수가
  성립하지 않습니다. 그래서 이 기록이 배포 이후에도 필요합니다.

**Turnstile 부재는 별개로 열려 있습니다**(docs/policy/voice-input.md §4.2).
cookie를 순환시키는 스크립트가 그날의 provider 예산을 소진시키면 실제 사용자가
거절됩니다 — 청구 위험이 아니라 가용성 위험입니다.
