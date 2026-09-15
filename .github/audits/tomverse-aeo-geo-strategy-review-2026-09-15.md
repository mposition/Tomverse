# Tomverse AEO/GEO 전략 검토 — 2026-09-15

## 결론과 범위

첨부 `Tomverse AEO/GEO 전략 Draft v0.1`은 **수정 후 채택**합니다. 검증 가능한
공개 정보, 학습과 검색의 구분, 사용자 대화 비공개 유지, 정직한 평가 자료라는 방향은
유효합니다. 그러나 최우선 과제의 근거·기존 구현 상태·계측 수단·공수 추정은 수정해야 합니다.

Chat → Code 내부 실사용·구독 대체 검증 → Native → Memory Release B → MCP의 주 투자
순서는 유지합니다. 삭제·권한 등 확인된 안전 과제를 먼저 다루고, AEO 기반 정비는 작은
병행 성장 트랙으로 관리합니다. Model Index 전체 구축 때문에 Chat 제품 완성을 미루지
않습니다. 등록은 구현·배포·크롤 정책 변경·유료 질의·외부 게시·자동화 예약 승인이 아닙니다.

- 코드: dirty·detached 작업을 보존하고 원격 fetch 후 별도 최신 worktree에서 검토.
  develop `edb846287e8a199be96d9b148f7660db73769d3e`,
  main `0a83fddb1e4d1e6c27599a5869e4a389c2b31336`.
- 핵심 `MarketingShell.tsx`, `robotsPolicyCore.ts`, `sitemap.ts`, `seo.ts`,
  `billingPriceCatalog.ts`, 모델·가격 페이지 구현은 두 ref에서 같았습니다.
  두 브랜치 전체나 모든 제품 상태가 같다는 뜻은 아닙니다.
- 공개 HTTP: 2026-09-15 약 16:36–16:39 Australia/Brisbane, 비인증 GET만 실행.
  production 배포 SHA·운영 DB 가격·GA4/Search Console 계정 보고서는 조회하지 않았습니다.
- `ai-seo`의 접근성·인용/추천 구분 틀을 사용하되, 스킬의 단정적 수치·봇 설명·옛 계측
  안내는 공식 최신 문서로 교정했습니다. `smart-explore`는 별도 worktree 접근이 거절돼
  필요한 코드·정책을 직접 대조했습니다. 외부 readiness 점수 도구나 유료 평가를 실행하지
  않았으며, 점수·통과 판정은 만들지 않았습니다.

## 1. 초안에서 수정할 판단

### 무료 표시: 확정 오류가 아니라 무료·유료 범위 설명의 부족

`components/marketing/MarketingShell.tsx:60`은 `isAccessibleForFree: true`와 단일
USD 0 Offer를 냅니다. 공개 `/pricing`·`/models` HTML에서도 같은 graph를 확인했습니다.
하지만 실제 Free 플랜이 있고 Google도 무결제 이용이 가능하면 `offers.price=0`을
허용하므로, 유료 플랜이 있다는 이유만으로 이 값을 오류라 단정할 수 없습니다.
[Google SoftwareApplication](https://developers.google.com/search/docs/appearance/structured-data/software-app).

작업은 “0을 유료 가격으로 교체”가 아니라 **무료로 가능한 범위와 유료 옵션·제약을
사람이 읽는 본문과 기계 판독 데이터에서 일치시키기**입니다. 모든 페이지에 개인화된
가격 Offer를 무조건 추가하지 않고, `/pricing`부터 통화·청구 주기·연간 총액/월 환산·세금
및 프로모션 조건을 구분합니다. 실제 제공하지 않는 플랜·후기·평점을 생성하지 않습니다.

`lib/billingPriceCatalog.ts` 하나가 가격 정본 전부라는 주장도 불완전합니다.
`getPlanPriceMinor()`는 Free=0, USD는 BillingPlan 설정, 비USD는 AppSetting 기반
catalog를 사용합니다. 상수는 fallback일 수 있습니다. 이미 있는 공개용 가격 해석
경로를 확인하고 쓰며, 읽기 과정에서 seed/upsert를 실행하거나 청구 설정을 바꾸지 않습니다.

### FAQPage와 llms.txt: Tier 1 고효과 작업에서 제외

Google은 FAQ 리치 결과를 2026-05-07부터 표시하지 않고 6월에 해당 문서를 제거했습니다.
FAQ 본문은 유용하지만 JSON-LD 추가의 Google 노출 효과를 약속할 근거는 아닙니다.
[Google 변경 기록](https://developers.google.com/search/updates#may-2026).

Google은 `llms.txt`가 자사 검색 가시성·순위에 영향을 주지 않는다고 명시합니다.
다른 소비자를 위한 선택적 파일은 가능하지만 실제 효과를 확인할 실험으로 둡니다.
현재 공개 `/llms.txt`는 404입니다. 이를 장애나 출시 차단으로 취급하지 않습니다.
[Google AI 최적화 안내](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide),
[llms.txt 제안](https://llmstxt.org/).

### 크롤러: 학습 거부는 유지하되 예외와 계층을 명시

- OpenAI는 GPTBot(학습)과 OAI-SearchBot(검색)을 독립 제어합니다. ChatGPT-User는
  사용자 요청용이며 검색 색인 허용을 결정하는 봇은 아닙니다.
  [OpenAI 봇 안내](https://developers.openai.com/api/docs/bots).
- Anthropic도 ClaudeBot(학습), Claude-SearchBot(검색), Claude-User(사용자 요청)를
  구분합니다. 따라서 Claude 검색을 위해 ClaudeBot 차단을 해제할 필요가 있다는
  전제는 채택하지 않습니다.
  [Anthropic 봇 안내](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler).
- Google-Extended는 Gemini 학습과 일부 grounding을 함께 통제하지만 Google Search
  포함 여부에는 영향을 주지 않습니다. 이를 단순한 “학습 전용 차단”으로 요약하지
  않습니다. 현 차단 정책 변경은 이 작업에 포함하지 않습니다.
  [Google 크롤러 안내](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers#google-extended).
- `ai-input`은 미지정입니다. `search=yes`·`use=reference`가 모든 AI 요약·RAG 사용을
  포괄 허용한다는 해석은 피합니다. 저장소 `search-indexing-boundary.md` §6도 이미
  이를 구분합니다. 앱 선언만 바꾸면 앞단의 기존 선언과 충돌할 수 있습니다.
  [Cloudflare Content Signals](https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/#content-use-signal).
- CCBot 차단을 “모든 모델의 학습 기반 인지 영구 포기”라고 부를 수 없습니다.
  다른 출처·이미 수집된 데이터까지 통제하지 못하며, 향후 정책은 변경 가능합니다.
  허용해도 학습·제품 반영을 보장하지 않고, 고정된 1~2년 일정도 근거가 없습니다.
  이미 학습된 결과를 robots 변경으로 회수할 수 있다는 뜻도 아닙니다.

### staging: 코드만으로 완료 판정하지 않기, 이미 있는 접근 통제 재개발 금지

공개 production·staging robots 응답 모두 Cloudflare 관리 블록을 포함했습니다.
staging의 일반 봇 규칙에는 관리 블록의 `Allow: /`와 앱의 `Disallow: /`가 함께 있습니다.
그러나 **staging `/`·`/safety`의 익명 요청은 Access 로그인 호스트로 302**였습니다.
production `/`는 200이며 `X-Robots-Tag: noindex`는 관측되지 않았습니다.

즉 초안의 “robots가 잘못된 호스트 인용을 막는 전제조건을 충족”은 부정확하지만,
staging 콘텐츠가 현재 공개됐다는 사고 근거도 아닙니다. 기존
`docs/ops/search-indexing-boundary.md` §4a·§7 및 `staging-access-boundary.md` §0에
설명된 상태와 맞습니다. 관리 설정 변경은 문서상 플랜 제약이 있고, Access는 이미
켜져 있습니다. 새 인증 구축·플랜 업그레이드·DNS 우회를 작업으로 추가하지 않습니다.
이번 관측은 두 화면 경로의 접근 확인이지 전체 bypass·원본 호스트 보안 감사가 아닙니다.

### sitemap: 매번 현재 시각을 쓰는 방식은 금지

코드와 공개 sitemap 모두 `2026-07-15T00:00:00.000Z` 하나를 사용합니다. 실제 응답은
55개 URL이며 4 intent × 7 언어 28개가 전부는 아닙니다. 고정 날짜가 있다는 사실만으로
모든 페이지가 낡았다고 판정하지는 않습니다. 의미 있는 내용 변경일과 연결하거나
신뢰할 날짜가 없으면 생략합니다. 요청 시각·빌드 시각으로 전체를 새 글처럼 만들지
않습니다. [Google sitemap 지침](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).

### Model Index: 내부 데이터 공개가 아니라 검증된 공개 계약

현재 `/models`는 모델·공급자·사용량 클래스·크레딧을 표시합니다. 초기 정적 카탈로그에서
시작해 `/api/models/catalog`로 갱신하는 경로가 있으므로 “JS 전에는 빈 페이지”라고
단정하지 않습니다. 공개 HTML에도 내용이 있었지만 전체 항목의 최신성은 별도 검증입니다.

기존 데이터 재사용은 유효하되 **새 조사가 필요 없고 비용 대비 효과가 최고라는 결론은
미검증**입니다. 공급자 최대 사양, Tomverse에 실제 적용된 한도, Tomverse 이용 크레딧,
공급자 공개 API 가격을 구별해야 합니다. 내부 USD 원가·관리자 override·예약량·미승인
가격·미출시 capability 레지스터를 그대로 공개하지 않습니다. 외부 공개가 허용된 필드,
공식 출처, 검증일, 대상 모델 버전, 활성화 범위를 정한 소규모 공개 view부터 검토합니다.

ItemList/Product를 추가한다고 업계 레퍼런스가 되지는 않습니다. 항목의 의미와 실제
판매 관계에 맞는 schema만 사용합니다. 기존 카탈로그 페이지를 먼저 확장하고 별도
모델 데이터베이스 제품·새 경로·모든 모델 상세 페이지를 한꺼번에 만들지 않습니다.

### 제3자 언급: 중요한 가설이지만 현재 0·최고 효과는 미측정

제3자 문서 인용은 Retrieval과 별개 엔진 경로가 아니라 같은 검색에서 얻는 출처 유형일
수 있습니다. “인용의 대부분이 Reddit”, “한계를 밝히면 더 많이 인용”, “현재 거의 0”은
플랫폼·언어·질문군별 근거가 없으므로 가설로 둡니다. 정직한 참여와 공개 사례는 후보로
채택하되, 자기 홍보만 하면 안 된다는 규범을 “타인이 자발적으로 써 주는 것만 가능”이라는
금지로 확대하지 않습니다. 매체 규칙과 관계 공개를 지키고, 대가성·가짜 후기·대량 댓글은
제외합니다. 외부 게시·사용자 사례 재사용은 이번에 승인하지 않았습니다.

## 2. 계측안을 다시 구성

1. **기존 GA4 확인이 먼저**: 2026-05-13부터 `AI Assistant` 기본 채널이 있습니다.
   Google AI Overviews·AI Mode는 그 채널이 아니라 Organic Search입니다. 현재 속성의
   보고서·동의에 따른 수집 범위·누락 호스트를 확인한 뒤 필요할 때만 custom group을
   보완합니다. 앱에 새 referrer 전송 코드를 먼저 넣지 않습니다.
   [GA4 변경 기록](https://support.google.com/analytics/answer/9164320),
   [기본 채널 정의](https://support.google.com/analytics/answer/9756891?hl=en).
2. **Google은 전용 보고서 확인**: 최신 안내에는 Search Console의 Generative AI
   performance report가 있습니다. 전용 노출수 보고서를 확인하되 미노출·데이터 부족은
   0으로 쓰지 않습니다. Tomverse 계정의 실제 보고서는 이번에 열지 않았습니다.
   [Search Console 보고서](https://support.google.com/webmasters/answer/16984139).
3. **인용·언급·추천·방문·전환을 분리**: referrer는 클릭 유입이고 클릭 없는 인용을
   보여 주지 않습니다. 인용은 자사 URL 출처 포함, 언급은 브랜드 텍스트 등장, 추천은
   실제 후보로 권하는 경우로 따로 기록합니다. 가입·첫 유효 사용·유료 전환은 기존
   동의/계측 계약 아래 연결하며 인과 효과가 증명됐다고 쓰지 않습니다.
4. **고정 질의 세트**: 20질문 × 4서비스를 택하면 80회 관측입니다. 브랜드/비브랜드,
   구매 의도/기능 질문, 언어·지역, 검색 사용 여부, 제품 UI/API, 모델·날짜, 출처 URL을
   기록합니다. 서비스별 결과를 따로 보며 API 결과를 소비자 UI 결과로 대체하지 않습니다.
   실패·차단·검색 비사용은 적절히 분리하고 성공한 일부만 분모로 바꾸지 않습니다.
5. **전부 수작업일 이유는 없음**: 질문·기록 틀·중복 제거·집계는 에이전트가 준비하고,
   허용된 수집은 재현 가능하게 보조할 수 있습니다. 추천 맥락·사실 정확성·최종 판정은
   사람이 확인합니다. 이번에는 80회 질의·유료 API 호출·자동 수집을 하지 않았습니다.
6. **90일 목표 재설정**: 월 100+, 8/80, /models 3배는 측정 전 희망치이지 승인된 KPI가
   아닙니다. 시작값도 0이 아니라 미측정입니다. 기준선을 확보한 뒤 노출·유효 방문·첫 사용·
   전환·유지비를 보고 확대 여부를 판단합니다. “가격 오류 0건”은 관측 표본 안의 결과이지
   모든 AI 답변의 정확성 보장이 아닙니다.

## 3. 등록한 작업과 순서

| 순서 | ID | 우선순위 | 다음 완료 단위 |
| --- | --- | --- | --- |
| 1 | AEO-01 | 성장 P1 | 기존 크롤·Access·정책 기록을 재사용해 검색봇 보호·공개/비공개 경계와 책임자/검토일 정리 |
| 2 | AEO-02 | 성장 P1 | /pricing의 Free·유료 범위, 통화·주기와 기계 판독 정보 정합성 |
| 3 | AEO-03 | 성장 P1·1/2와 병행 가능 | 기존 GA4 AI Assistant·GSC 보고서·질의 표본으로 기준선과 전환 연결 |
| 4 | AEO-04 | 성장 P1·작은 정비 묶음 | sitemap의 검증 가능한 실제 콘텐츠 변경일 |
| 5 | AEO-05 | 성장 P2·조건부 확대 | 기존 /models의 소수 검증 항목으로 Model Index 실험 |
| 6 | AEO-06 | 성장 P2 | 실제 구매 질문 중심 기존 intent/FAQ 본문 보완·정직한 제3자 채널 소규모 실험 |
| 7 | AEO-07 | 선택 P3 | 소비자·유지 책임을 정한 llms.txt, 의미상 적절한 FAQPage 등 보조 표현 |
| 8 | AEO-08 | 후속 P3·자료 승인 필요 | 재현 가능한 원본 리포트·권리 확인된 공개 showcase |

- 1~4는 전체 동시 착수가 아니라 작은 완료 단위를 선택할 수 있는 순서입니다.
  3의 기준선 확보는 콘텐츠 확장 전에 필요하지만 확인된 사실 오류 수정을 막지 않습니다.
- AEO-01은 기존 robots 테스트·edge 검사 확장입니다. 새로운 검색봇 allow 그룹 때문에
  `*`의 `/share`·`/api` 제외가 사라지지 않게 공개/비공개 경로를 같이 검증합니다.
  단순히 거부 목록에 이름이 없는지 확인하는 테스트만으로 끝내지 않습니다.
- 한국어·독일어를 먼저 늘린다는 결론은 수요 근거 확인 전 보류합니다. 기존 7언어를
  유지하고 실제 고객 질문·유입·제품 지원 범위로 첫 언어/주제를 고릅니다.
- CSP는 `StructuredData`의 선택적 nonce만 보면 안 됩니다. 실제 `MarketingShell`은
  nonce를 넘기지 않으며 `staticMarketingCsp.ts`는 빌드 HTML의 hash를 계산합니다.
  새 데이터가 정적/동적 렌더·CSP·캐시에 주는 영향을 확인하되 AEO 때문에 CSP를 풀거나
  모든 공개 페이지를 무조건 동적으로 바꾸지 않습니다.
- /share·/chat·/api·staging을 SEO 목적으로 개방하지 않습니다. 원본 리포트와 showcase는
  공개용 시료를 우선하고, 사용자 원문·Memory·업로드·계정 정보는 자동 재사용하지 않습니다.
  동의·권리·제3자 개인정보·비밀을 검토해도 이미 내려받힌 공개본은 회수할 수 없습니다.
  공개 사례를 초안처럼 단순히 “되돌릴 수 있음”으로 분류하지 않습니다.
- 벤치마크는 승인된 방법론·모델 버전·조건·평가 시료·한계가 선행합니다. 내부 Router/Review
  개발 평가의 수치를 그대로 마케팅 성능으로 전환하거나 표본 부족을 감추지 않습니다.
- 분기 크롤러 검토·월별 관측은 후보 운영 주기입니다. 이번에 자동화를 만들거나 기존
  보안 자동화를 재개하지 않았습니다. 담당자는 실제 수락 전까지 미지정입니다.

### 초안 12개 제안의 대응

| 초안 항목 | 반영 |
| --- | --- |
| 1 무료 Offer 수정, 4 Offer schema, 10 가격 사실 정리 | AEO-02로 병합, 무료 오류 단정 제거 |
| 2 LLM referrer | AEO-03, 신규 구현 전 기존 기본 보고서 활용 |
| 3 lastModified | AEO-04, 무조건 현재 시각 금지 |
| 4 FAQPage, 5 llms.txt | AEO-07로 후순위; FAQ 본문 개선은 AEO-06 |
| 6 크롤러 테스트, 8 ClaudeBot/CCBot 결정 | AEO-01, 기존 정책·검사를 확장 |
| 7 Model Index | AEO-05, 검증된 공개 필드·소규모 실험 |
| 9 한국어·독일어 intent 심화 | AEO-06, 언어 우선순위는 수요 확인 후 |
| 11 원본 리포트, 12 showcase | AEO-08, 공개 승인·방법론·회수 불가 조건 명시 |

초안의 30분·1시간·3~4일·1~2주 추정은 견적으로 채택하지 않습니다. 가격의 실시간
정합성, 정적 렌더/CSP, 번역 검증, 데이터 공개 경계에 따라 규모가 달라집니다.
이번 변경은 이 검토 문서와 통합 자문 목록뿐이며 제품 테스트·운영 설정 변경은 없습니다.
