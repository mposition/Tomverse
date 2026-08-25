# 검색 색인 경계 — 어떤 배포가 크롤러를 받는가

정본은 코드입니다: `app/robots.ts`, `lib/robotsPolicyCore.ts`, `next.config.ts`.
이 문서는 **왜 그렇게 됐는지**와 **저장소 밖에서 해야 하는 일**을 기록합니다.

## 1. 결정 (2026-08-25)

> A안을 채택한다. Cloudflare managed robots.txt를 비활성화하고 애플리케이션이
> production과 staging의 최종 robots 정책을 소유한다. Production에서는 현재 AI
> crawler 차단 정책과 필요한 Content-Signal 정책을 보존하고, staging은
> sitemap·host 없이 전체 크롤을 거부한다. 추가로 staging의 모든 색인 가능한
> 응답에 `X-Robots-Tag: noindex, nofollow, noarchive`를 적용한다. 변경 후 검증은
> origin 응답이 아니라 Cloudflare를 통과한 실제 edge 응답을 대상으로 수행한다.
> B안의 DNS-only 전환은 origin 보호 경계 변경 때문에 채택하지 않는다.

B안(staging을 Cloudflare 프록시에서 제외)을 버린 이유는 범위입니다. robots 충돌
하나를 고치려고 origin secret 검증, WAF, bot protection, origin IP 노출, TLS·캐시
동작을 한꺼번에 건드리게 됩니다. staging에는
`REQUIRE_CLOUDFLARE_ORIGIN_SECRET`이 설정돼 있어 특히 그렇습니다.

## 2. 무엇이 잘못돼 있었나

`app/robots.ts`는 원래 모든 배포에서 같은 본문을 냈습니다 — `allow: "/"`,
production sitemap, `host: https://tomverse.app`. staging도 그 파일을 실행하므로
크롤러를 받아들이면서 production을 자기 canonical host로 지목했습니다. 실제로
통했습니다: 2026-08-23 Search Console export에 `https://staging.tomverse.app/safety`가
색인된 상태로 들어 있었습니다.

PR #961이 그 분기를 고쳤는데도 staging은 여전히 크롤 가능했습니다. Cloudflare의
managed `robots.txt` 설정이 zone `tomverse.app` 전체에 자기 블록을 **앞에** 붙이고
있었기 때문입니다:

```txt
User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /            ← Cloudflare
...
User-Agent: *
Disallow: /         ← 우리
```

RFC 9309 §2.2.1은 같은 product token 그룹을 **병합**하도록 규정하고, Google은
경로 길이가 같은 `Allow`/`Disallow` 충돌에서 **덜 제한적인 쪽**을 택합니다. 두
규칙 모두 `/` 이므로 Googlebot에게는 `Allow` 입니다. **파일 안에 `Disallow: /`
문자열은 분명히 있었고, 파일의 의미는 그 반대였습니다.** 이것이 검증을 문자열이
아니라 의미로 해야 하는 이유이고, `lib/robotsTxtCore.ts`가 존재하는 이유입니다.

## 3. 지금 각 층이 하는 일

| 층 | 하는 일 | 하지 않는 일 |
|---|---|---|
| `robots.txt` `Disallow: /` | 크롤 요청을 억제 | 색인을 막지 못함 |
| `X-Robots-Tag: noindex` | 이미 가져간 검색엔진의 색인을 방지 | 접근을 막지 못함 |
| 인증 / Cloudflare Access | 실제 접근 통제 | — |

Google은 robots.txt를 색인 방지 수단으로 보지 않습니다. 크롤이 차단된 URL도 외부
링크를 통해 URL 자체가 결과에 나타날 수 있습니다. 그래서 두 번째 층이 있습니다.

**staging에 민감 데이터가 들어가는 날, 최종 보안 경계는 위 두 층이 아니라
인증입니다.** 지금 staging 루트는 인증 없이 200을 반환합니다.

## 4. 저장소 밖에서 해야 하는 일 — 순서가 중요합니다

Cloudflare 관리 블록에는 우리가 잃으면 안 되는 절반(AI crawler `Disallow`,
`Content-Signal`)과 staging을 망가뜨리는 절반(`Allow: /`)이 같이 있습니다. 앞의
절반은 이제 `app/robots.ts`가 냅니다. 따라서:

1. **먼저 이 변경을 production까지 배포합니다.** 그래야 AI crawler 차단이
   비어 있는 순간이 생기지 않습니다.
2. `npm run check:edge-robots -- https://tomverse.app` 로 **우리 파일이** AI
   crawler를 거부하는지 확인합니다. 병합된 파일 전체가 아니라 우리 절반을 봐야
   합니다 — 2026-08-25에 이 구분 없이 돌렸더니, `app/robots.ts`에 AI crawler가
   한 줄도 없는 상태에서 통과했습니다. Cloudflare 절반이 그 일을 하고 있었고,
   병합된 파일은 정상으로 보였습니다. 그래서 스크립트는 `# END Cloudflare
   Managed Content` 뒤쪽만 떼어 우리 정책을 판정하고, 관리 블록이 아직 있으면
   그 사실을 출력합니다. **이 단계가 통과해야 3번이 안전합니다.**
3. **그 다음** Cloudflare 대시보드에서 관리 robots.txt를 끕니다 — **§4a 참조:
   이 단계는 2026-08-25 현재 플랜 제한으로 보류돼 있습니다.**
   Security Settings → **Bot traffic** → "Set your preference to block training in
   robots.txt" 를 off. zone 단위 설정이라 `staging.tomverse.app`도 같이 풀립니다.
4. `npm run check:edge-robots -- https://staging.tomverse.app` 와
   `npm run check:edge-robots -- https://tomverse.app` 를 둘 다 통과시킵니다.

`robots.txt`는 4시간 캐시(`max-age=14400`)로 나갑니다. 스크립트는 캐시 우회
쿼리를 붙이지만, 크롤러가 보는 것은 캐시된 사본이므로 급하면 Cloudflare에서
`/robots.txt` 를 purge 하십시오.

## 4a. 3번은 보류됐습니다 (2026-08-25)

**Cloudflare 플랜 제한으로 관리 robots.txt 설정을 끌 수 없습니다.** 1·2번은
끝났습니다 — `596cbf31`이 production에 배포됐고
`npm run check:edge-robots -- https://tomverse.app` 이 통과합니다. 우리 절반이
크롤러 9종과 `Content-Signal`·`Host`·`Sitemap`을 직접 냅니다. 3번만 남았고, 그건
계정 권한 문제라 코드로 풀 수 없습니다.

**그런데 중요한 결과는 이미 나와 있습니다.** 두 가지를 분리해야 합니다.

| | 상태 | 근거 |
|---|---|---|
| staging **색인** 방지 | **됨** | 모든 응답에 `X-Robots-Tag: noindex, nofollow, noarchive` (2026-08-25 확인: 루트, `/safety`) |
| staging **크롤** 억제 | 안 됨 | Cloudflare의 `Allow: /` 가 우리 `Disallow: /` 를 병합에서 이깁니다 |

그리고 이 조합은 **우연히 유리합니다.** Google은 `noindex`를 페이지를 가져와야
읽습니다. 크롤이 차단된 URL은 가져올 수 없으니 `noindex`도 못 보고, 이미 색인된
URL이 그대로 남습니다. 지금은 Googlebot이 staging을 가져가면서 `noindex`를 읽으므로
**이미 색인된 `staging.tomverse.app/safety`가 빠지는 경로가 열려 있습니다.** 3번이
성공했다면 그 URL은 더 오래 남았을 겁니다.

남는 위험은 하나입니다 — 미출시 표면이 크롤러에게 읽힙니다. **이건 robots가 고칠 수
있는 문제가 아니었습니다.** §3이 말한 그대로입니다: `robots.txt`도 `noindex`도
요청이지 통제가 아니고, 무시하는 크롤러에게는 둘 다 효력이 없으며, staging 루트는
지금도 인증 없이 200입니다. **플랜 제한이 막은 것은 방어의 두 번째 층이지 경계가
아닙니다.** 크롤을 실제로 멈추려면 인증(Cloudflare Access 또는 앱 레벨)이고, 그건
robots 우회보다 값이 확실합니다.

검토했다가 채택하지 않은 것: `staging.tomverse.app/robots.txt` 를 Worker로 가로채기.
Workers는 무료 플랜에 있지만 관리 블록 주입이 Worker 응답에도 적용되는지 확인되지
않았고, 성공해도 얻는 것은 이미 되고 있는 색인 방지가 아니라 크롤 억제뿐입니다.

### 검사는 어떻게 바뀌었나

`npm run check:edge-robots` 가 non-canonical origin에서 두 종류를 구분합니다.

- **우리가 소유한 것** — 우리 절반의 내용, `noindex` 헤더 — 은 그대로 실패시킵니다.
- **병합 결과** 는 관리 블록이 있는 동안만 **이름 붙은 편차**로 보고하고 종료 코드에
  넣지 않습니다.

아무도 고칠 수 없는 것 때문에 항상 빨간 검사는 곧 아무도 안 읽는 검사가 되고, 이
검사의 값어치는 빨간색이 의미를 갖는 데 있습니다. 편차는 매 실행마다 이름과 함께
출력되므로 사라지지 않습니다. **관리 블록이 없어지는 순간 `managed`가 false가 되어
같은 항목이 다시 보통의 실패로 돌아갑니다** — 나중에 꺼야 할 플래그가 없습니다.

2026-08-25 staging 실행 결과: Googlebot·Bingbot이 편차 2건, GPTBot은 편차가 아닙니다
— Cloudflare 블록이 GPTBot을 이름으로 거부하므로 병합 결과가 실제 거부입니다.

### 플랜이 바뀌면

3번을 그대로 실행하고 4번으로 검증하면 됩니다. 이 절은 그때 지우지 말고, 왜 한동안
보류였는지의 기록으로 남기십시오.

## 5. bot 목록의 정본과 갱신 책임

`lib/robotsPolicyCore.ts`의 `REFUSED_AI_CRAWLERS`가 정본입니다. **2026-08-25
Cloudflare 관리 블록의 스냅샷이며, 자동으로 갱신되지 않습니다.** Cloudflare가
관리해 주던 일을 이제 사람이 합니다. 새 크롤러가 문제가 되면 손으로 추가하고,
비교 대상은 Cloudflare의 공개 목록
(https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/)
입니다.

솔직히 말해 이것이 사는 것은 크지 않습니다. `robots.txt`는 요청이지 경계가
아니고, Cloudflare도 자기 기능에 대해 같은 말을 합니다. 무시하는 사업자에게는
이 모듈의 어떤 내용도 영향이 없습니다. **강제 차단이 필요해지면 그것은 별개
제품(Cloudflare AI Crawl Control)이고, 관리 robots.txt를 끄는 것이 AI Crawl
Control을 끄는 것은 아닙니다.**

## 6. 미결

**`Content-Signal`을 계속 쓸지는 별도 결정으로 남깁니다.** 지금은 Cloudflare가
내던 값(`search=yes, ai-train=no, use=reference`)을 그대로 승계했습니다 — 끄는
결정을 한 적이 없으므로 조용히 사라지게 두지 않는다는 뜻이지, 이 값이 옳다고
판단했다는 뜻은 아닙니다. Google Search Console이 `Content-Signal`에 대해
`Syntax not understood`를 보고할 수 있으나 크롤·SEO 영향은 관측되지 않았다고
Cloudflare가 안내합니다.

## 7. 검증

```bash
npm run check:edge-robots -- https://staging.tomverse.app
npm run check:edge-robots -- https://tomverse.app
```

문자열을 세지 않습니다. 서버가 실제로 낸 본문을 RFC 9309 병합 규칙과 Google
우선순위로 평가해서 `/`가 정말 거부되는지, non-canonical 배포가 sitemap·host를
광고하지 않는지, `X-Robots-Tag`가 붙는지를 봅니다. 대상은 **edge URL**입니다 —
origin만 보면 이번 문제를 다시 놓칩니다.

통과가 무엇을 뜻하는지는 §4a를 함께 읽어야 합니다. staging의 통과는 "크롤러가
못 들어온다"가 아니라 "우리가 소유한 부분이 전부 맞고, 남은 항목은 편차로 이름이
붙어 출력됐다"는 뜻입니다.

단위 테스트는 `tests/robotsTxtCore.test.mjs`(평가기)와
`tests/robotsRoute.test.mjs`(Next의 직렬화기로 실제 본문을 만들어 평가)에
있습니다. 앞의 파일에는 Cloudflare 블록이 우리 `Disallow`를 무력화하는 사례가
**통과하는 테스트로** 박혀 있습니다 — zone 설정이 다시 켜지면 안 되는 이유를
코드가 기억하도록.
