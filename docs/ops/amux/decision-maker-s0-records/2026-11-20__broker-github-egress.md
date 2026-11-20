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
채운다. 집합은 `flags interval; auto-merge`다. 허용 포트(443)와 대상(GitHub뿐), DM 공급사 계정의 규칙은 그대로다.
meta를 읽지 못하거나 IPv4 대역이 8개보다 적으면 실행이 실패하고 이전 규칙이 남는다.

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

## 남는 것

DM 공급사 계정(`openai`, `anthropic`)의 집합은 여전히 DNS 답으로 채운다. `chatgpt.com`처럼 CDN 뒤의 이름은 같은 이유로
가끔 막힐 수 있다. 실제 실패가 보이면 같은 방식(공급사가 공개한 대역 또는 누적 집합)으로 바꾼다.
