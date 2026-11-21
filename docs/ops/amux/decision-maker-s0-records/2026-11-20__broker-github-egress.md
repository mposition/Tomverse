# Decision Maker broker의 GitHub egress — 2026-11-20

> 운영자 `mposition`이 2026-11-20 대화에서 승인했고, box에서 직접 설치했다. 출력은 운영자가 대화에 붙여 넣은 것을
> 에이전트(Claude)가 옮겨 적었다.

## 증상

- 2026-11-20 12:03Z와 12:22Z의 DM 요청 3건이 모두 `AMUX_DM_RUN_UNAVAILABLE`로 끝나고 질문이 운영자에게 갔다.
- broker log는 세 건 모두 `"launch":"broker_refused","reasons":["workspace_unavailable"]`,
  `"workspace":"failed:git_failed:fetch"`였다. 실패까지 0.2~1.5초였다.
- box 기록 전체에서 작업 공간의 git fetch가 성공한 적이 없었다. 2026-11-16까지의 DM 실행은 작업 공간이 없었다.

## 원인

`/usr/local/libexec/amux-dm-egress`(10분 timer)는 broker에 `getent ahostsv4 api.github.com raw.githubusercontent.com github.com`의
그 순간 답만 허용했다. `github.com`은 몇 분마다 다른 주소로 응답한다. 측정 당시 허용 목록은
`4.237.22.34, 4.237.22.38, 185.199.108-111.133`였고 `github.com`의 답은 `4.195.217.80`이었다. 목록에 없는 주소로의
연결은 `reject with tcp reset`으로 바로 끊겨 fetch가 실패했다.

확인한 것:

| 실행 | 결과 |
|---|---|
| tommy, production과 같은 git 플래그·환경변수, depth 1000 | `exit=0`, 18.7초 |
| `amux-dm-broker`, broker unit과 같은 격리 설정(`systemd-run`), 답이 목록 안의 주소였던 순간 | `exit=0`, 16.5초 |
| `amux-dm-broker`, 격리 없이 egress 규칙만 | `exit=0`, 19.0초 |

격리 설정은 원인이 아니고, 허용 목록과 DNS 답이 어긋나는 순간에만 실패한다.

## 변경

broker의 `github` 집합을 GitHub이 공개한 git·API 주소 대역(`https://api.github.com/meta`의 `git`과 `api`, IPv4만)으로
채운다. 집합은 `flags interval; auto-merge`다. 허용 포트(443)와 DM 공급사 계정의 규칙은 그대로다.
meta를 읽지 못하거나 IPv4 대역이 8개보다 적으면 실행이 실패하고 이전 규칙이 남는다.

이 규칙은 IP 단위다. 호스트 이름(SNI)은 보지 않는다. 이전 규칙도 IP 단위였고, 허용한 것이 DNS 답 몇 개에서
GitHub이 자기 서비스 주소로 공개한 대역 전체로 넓어졌다. 그 대역 안에 GitHub이 아닌 서비스가 있으면 broker는 그곳에도
443으로 연결할 수 있다. GitHub은 이 대역을 자기 git·API 서비스의 주소로 공개하므로 그런 경우는 없다고 보고, 아래
차단 검증으로 대역 밖이 막히는 것을 확인했다. broker는 공개 저장소의 commit 조회와 fetch만 하고 자격증명이 없으므로(`docs/policy/amux-decision-maker.md` §5),
대역 안의 다른 곳에 닿아도 보낼 비밀이 없다. 호스트 이름까지 검사하는 egress(SNI 허용 목록 proxy)는 두지 않았다.

| 파일 | SHA-256 |
|---|---|
| `/usr/local/libexec/amux-dm-egress` (설치 뒤, `0755`) | `9ec7aefdfb05e5c6efc14e9918679eab48e086bee2e678cc431d8147e83a841f` |
| `/usr/local/libexec/amux-dm-egress.before-20261120b` (설치 전) | `9c13d61857c2b49dcb748dc0982ea8d058d030e7ab94698f14909bfbda290988` |

설치 전 파일과의 차이:

```diff
-# broker only GitHub's public hosts. Names are re-resolved on every run; a name
-# that resolves to nothing leaves the previous table in place.
+# broker only GitHub's hosts. Vendor names are re-resolved on every run.
+# GitHub is the address ranges GitHub publishes for git and its API
+# (https://api.github.com/meta, keys "git" and "api"), not one DNS answer:
+# github.com answers with a different address every few minutes, and a
+# 10-minute snapshot of one answer refused the broker's workspace fetch
+# (2026-11-20, failed:git_failed:fetch). A run whose meta read or a name
+# that resolves to nothing fails leaves the previous table in place.
-GITHUB=$(v4 "api.github.com raw.githubusercontent.com github.com")
+META=$(curl -fsS --max-time 20 -H "Accept: application/vnd.github+json" https://api.github.com/meta)
+GITHUB=$(printf '%s' "$META" | /usr/bin/node -e '
+  const m = JSON.parse(require("fs").readFileSync(0, "utf8"));
+  const cidr = /^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/;
+  const v4 = [...new Set([...(m.git || []), ...(m.api || [])].filter((c) => cidr.test(c)))];
+  if (v4.length < 8) process.exit(1);
+  process.stdout.write(v4.join(","));')
-  set github { type ipv4_addr; elements = { $GITHUB } }
+  set github { type ipv4_addr; flags interval; auto-merge; elements = { $GITHUB } }
```

## 설치와 확인

운영자가 tomverse-admin으로 `sudo bash /home/tommy/.tmp-amux-sweep-box/install-dm-egress.sh`를 실행했다. 이 스크립트는
설치 전 파일을 `.before-20261120b`로 두고, egress 실행이 실패하면 그 파일로 되돌린다. 출력:

```text
+ /usr/local/libexec/amux-dm-egress (9ec7aefdfb05e5c6)
github set: elements = { 4.149.173.80/28, 4.158.254.48/28, 4.159.108.160/28, 4.159.197.192/28, 4.163.8.144/28, 4.186.157.192/28, 4.187.247.160/28, 4.195.217.80/28, ... }
github.com now: 4.195.217.80
== broker sandbox
exit=0 ms=18181
== same user, no sandbox (egress rule only)
exit=0 ms=18902
```

`github.com`이 이전 규칙에서는 막히던 `4.195.217.80`으로 답하는 동안, broker 계정과 격리 설정 그대로 fetch가 성공했다.

되돌리기: `sudo cp -p /usr/local/libexec/amux-dm-egress.before-20261120b /usr/local/libexec/amux-dm-egress` 뒤
`sudo systemctl start amux-dm-egress.service`.

## 차단 검증 (2026-11-21)

독립 검토(`r-20261120-124157-900bdc`, reject)가 GitHub 밖으로의 연결이 막히는지 확인하라고 했다. 운영자가
tomverse-admin으로 `sudo bash /home/tommy/.tmp-amux-sweep-box/dm-egress-negative-check.sh`를 실행했다. 이 스크립트는
`amux-dm-broker`로, broker unit과 같은 격리 설정 아래에서 각 주소에 `curl`로 연결한다. 출력(`000`은 연결 실패):

```text
allowed  https://github.com -> 200
allowed  https://api.github.com/meta -> 200
refused? https://api.openai.com -> 000
refused? https://api.anthropic.com -> 000
refused? https://example.com -> 000
refused? https://www.google.com -> 000
refused? https://login.microsoftonline.com -> 000
refused? https://registry.npmjs.org -> 000
```

검증 스크립트:

```bash
#!/usr/bin/env bash
# Read-only check of the DM broker's egress, as amux-dm-broker under the broker
# unit's sandbox: GitHub's hosts connect, every other destination is refused.
# Changes nothing on the box.
set -u
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 2; }
probe() { # url
  systemd-run --quiet --wait --pipe --collect -p User=amux-dm-broker -p Group=amux-dm-broker \
    -p PrivateTmp=true -p ProtectSystem=strict -p ProtectHome=read-only -p PrivateDevices=true \
    -p ProtectProc=invisible -p ProcSubset=pid -p "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6" \
    -p NoNewPrivileges=true \
    /usr/bin/curl -sS -o /dev/null -m 8 -w '%{http_code}' "$1" 2>&1 | tail -1
}
for url in https://github.com https://api.github.com/meta; do
  echo "allowed  $url -> $(probe "$url")"
done
for url in https://api.openai.com https://api.anthropic.com https://example.com https://www.google.com \
  https://login.microsoftonline.com https://registry.npmjs.org; do
  echo "refused? $url -> $(probe "$url")"
done
```

GitHub의 두 host만 닿고, 다른 공급사와 일반 사이트는 막혔다. GitHub 대역과 같은 클라우드(Azure)에 있는
`login.microsoftonline.com`도 막혔다.

## 남는 것

DM 공급사 계정(`openai`, `anthropic`)의 집합은 여전히 DNS 답으로 채운다. `chatgpt.com`처럼 CDN 뒤의 이름은 같은 이유로
가끔 막힐 수 있다. 실제 실패가 보이면 같은 방식(공급사가 공개한 대역 또는 누적 집합)으로 바꾼다.
