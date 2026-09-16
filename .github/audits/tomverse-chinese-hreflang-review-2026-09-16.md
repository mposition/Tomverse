# SEO-I18N-01 — 간체 중국어 hreflang의 지역 중립화

## 결론·우선순위

**채택, 작은 병행 P1 / 성장·SEO 정합성. 구현 미착수.** `hreflang`의 중국어 매핑을
`zh-CN`에서 `zh-Hans`로 바꾸는 것을 권합니다. 중국 본토 접속 차단은 사용자가
2026-09-16부터 적용했다고 보고한 운영 사실이며, 이 검토가 차단 규칙을 직접 확인한 것은 아닙니다.

`zh-CN`은 중국 지역의 중국어, `zh-Hans`는 지역을 특정하지 않은 간체 중국어입니다.
간체 서비스를 계속 제공하면서 본토를 대상으로 하는 지역 지정을 없애려는 목적에 맞습니다.
기존 `zh-CN`이 문법 오류였다는 뜻은 아닙니다. `zh-Hans`는 본토를 제외하는 표기도,
접근 제어도, 기존 검색 결과를 삭제하는 지시도 아닙니다. 검색 순위 상승을 보장하지 않습니다.

현재 보안·권한 대응과 Chat 주 개발 투자 순위를 유지합니다. AEO-01의 공개 접근 점검과
함께 진행할 수 있는 작은 정비이며, AEO-05~08의 신규 콘텐츠/실험보다 먼저 권합니다.
원문 검색·TXT 개발 전체나 Memory 출시를 기다릴 기술적 의존성은 없습니다.

## 1. 요청 원문

> 현재 중국 본토 접속을 오늘부터 막았습니다. 그것에 맞추어 hreflang `zh-CN` → `zh-Hans` 을 변경하는 작업이 필요할듯 합니다. 분석후 작업목록에 추가해주세요.

이번 요청은 분석·작업 목록 등록입니다. 제품 코드 변경, 배포, 국가 차단 정책 변경의
승인으로 확대하지 않습니다.

## 2. 코드와 공개 응답 근거

- 원격 fetch 후 dirty·detached인 기존 작업 폴더는 보존하고, 최신 develop의 별도
  worktree에서 분석했습니다.
  - develop: `8c7cb5ceb877b7721325c9e83bb18d53c5e9293e`.
  - main: `e55812b67c32827e32bdb765f23ffaed582170b0`.
  - `lib/seo.ts`, `app/sitemap.ts`, `lib/marketingLocale.ts`,
    `components/DocumentShell.tsx`는 두 ref 사이에 차이가 없습니다.
- `lib/seo.ts:25`의 `hreflangByLocale`에서 `zh: "zh-CN"`입니다.
  `localizedLanguageAlternates()`를 페이지 metadata와 `app/sitemap.ts`가 공유합니다.
- 대상은 `LOCALIZED_SEO_PATHS`의 홈과 네 intent 경로입니다. 7개 언어 URL과 기본 URL을
  포함하는 5개 그룹이며, 각 그룹에서 동일한 alternate 집합을 생성합니다.
- 언어 키와 URL은 `zh`, `/zh`입니다. `lib/marketingLocale.ts`의 과거 `/cn` 별칭은
  `/zh`를 향하도록 유지됩니다. URL 자체를 `/zh-Hans`로 바꿀 이유는 없습니다.
- `<html lang>`은 `DocumentShell`과 `LanguageProvider`에서 현재 `zh`로 설정합니다.
  이는 지역 코드 CN을 쓰는 곳이 아니므로 이번 변경의 필수 대상이 아닙니다.

2026-09-16 현재 조회 환경에서 인증 없는 일반 GET으로 확인했습니다. HTML 속성 이름은
대소문자를 구분하지 않고 읽었습니다(`hrefLang` 출력도 포함).

| 공개 URL | HTTP | 관측 |
| --- | --- | --- |
| `https://tomverse.app/zh` | 200 | alternate `zh-CN` → `/zh`, canonical `/zh`, html lang `zh`, og:locale `zh_CN` |
| `https://tomverse.app/en` | 200 | 동일 집합의 alternate `zh-CN` → `/zh`, canonical `/en` |
| `https://tomverse.app/sitemap.xml` | 200 | `hreflang="zh-CN"` 40회, `zh-Hans` 0회 |
| `https://tomverse.app/robots.txt` | 200 | 현재 조회 환경에서 공개 응답 수신 |

이는 단일 조회 환경의 원시 HTTP 응답 관측입니다. 본토 IP에서의 차단 재현, 모든 허용
국가에서의 정상 접속, Googlebot 실제 수집, 전체 페이지 검사, production 배포 SHA 확인은 아닙니다.
검색 순위·노출량·크롤 오류율도 조회하지 않았습니다.

## 3. 첫 완료 범위

1. `hreflangByLocale.zh`만 `zh-Hans`로 바꿔 공통 생성 경로의 HTML alternate와 sitemap을
   함께 맞춥니다. 새 중복 매핑을 만들지 않습니다. 다른 언어 페이지가 중국어 페이지를
   가리키는 항목도 바뀌어야 하므로 `/zh` 페이지 한 곳의 태그만 수정하지 않습니다.
2. `/zh`와 네 `/zh/<intent>` URL, 각각의 canonical, 언어 전환, `/cn` legacy 별칭,
   `x-default`, 다른 6개 언어의 값과 URL은 유지합니다. 모든 그룹의 자기 참조·상호 참조를
   검사합니다. locale/DB 키 변경이나 URL migration·redirect 신설은 필요하지 않습니다.
3. 생성 함수 회귀 테스트와 실제 빌드 HTML·sitemap 검사에서 `zh-Hans`가 동일한 `/zh` 계열을
   가리키고, hreflang 문맥의 `zh-CN`만 사라졌는지 확인합니다. 코드 전체에서 `zh-CN`이 0건인
   것을 완료 기준으로 삼지 않습니다. 기존 browser-language 입력도 계속 받을 수 있어야 합니다.
4. 배포 후 공개 응답에서 반영 여부를 확인합니다. 정적 HTML·sitemap·캐시의 갱신 여부까지
   확인해야 하며, 캐시 삭제나 Search Console 제출은 이번 검토에서 수행하지 않았습니다.
   검색엔진 재수집과 검색 결과 반영은 별개이므로 배포 직후 모두 바뀌었다고 보고하지 않습니다.
5. AEO-01에 연결해 국가 차단이 의도하지 않은 공개 페이지/검색 수집 경로를 막지 않는지
   읽기 전용으로 확인합니다. 이 확인을 명분으로 본토 차단을 풀거나 User-Agent만 보고
   예외를 추가하지 않습니다. geo 접근 제어와 언어 선택은 독립적으로 유지합니다.

## 4. 일괄 치환에서 제외할 것

| 영역 | 현재 값·역할 | 이번 범위 |
| --- | --- | --- |
| hreflang | `lib/seo.ts`의 `zh-CN` | `zh-Hans`로 변경 권고 |
| URL·내부 언어 키 | `/zh`, `Language = "zh"`, 저장된 언어 설정 | 유지 |
| HTML lang | 현재 `zh` | 유지 가능. `zh-Hans`로 더 구체화한다면 SSR와 client 갱신을 함께 검토하는 별도 범위 |
| Open Graph | `openGraphLocaleByLanguage.zh = "zh_CN"` | 별도 규격·사회 공유 대상 결정. `zh_Hans`로 자동 치환 금지 |
| 날짜·금액·메일 표시 | pricing·billing 코드의 `zh-CN` | 표시 규칙이며 접근 가능 국가가 아님. 이번 변경에서 제외 |
| 입력·회귀 시료 | `Accept-Language: zh-CN` 및 `zh-Hans-CN` | 해외 사용자의 브라우저도 보낼 수 있음. 입력 지원·시료 유지 |
| CN 차단·결제 시장 | 지역 접근 정책, CNY/국가 매핑 | 변경하지 않음 |

특히 Open Graph는 `language_TERRITORY` 형식이며 hreflang과 동일한 문자열 계약이 아닙니다.
`zh_CN`의 지역 중립화까지 원하면 지원 규격·소비자 호환성을 별도로 검토합니다.
근거 없이 `zh_SG`로 바꾸어 싱가포르를 대상 시장으로 새로 지정하지 않습니다.

## 5. 검증 범위와 미확인 사항

- 이번에 수행: 원격 동기화, 관련 코드 대조, 공식 문서 확인, 공개 URL 4개의 읽기 전용 조회.
- 이번에 미수행: 제품 코드 수정, 빌드/회귀 테스트, geo 정책/계정 설정 변경, 중국 본토 실접속,
  GSC 조회/제출, 배포, 캐시 purge, 유료 모델 호출.
- 착수 시 합성·빌드 검사는 에이전트가 준비·실행하고, 운영 접근권한이나 실제 지역 접속이
  필요할 때만 그 확인을 별도 항목으로 남깁니다. 단순 metadata 정비를 새 전사 릴리스 차단으로
  만들지 않습니다.
- `seo-audit`의 국제화 참조 기준으로 hreflang·URL·canonical·sitemap을 함께 확인했습니다.
  `smart-explore`는 새 worktree 접근 제한으로 사용할 수 없어 관련 코드 검색·직접 대조로 보완했습니다.

## 근거

- [Google: 언어·지역·문자체별 hreflang 및 상호 참조](https://developers.google.com/search/docs/specialty/international/localized-versions)
- [W3C: 언어 태그의 script와 region](https://www.w3.org/International/articles/language-tags/index.en.html)
- [Open Graph: locale의 별도 형식](https://ogp.me/#optional)
- [검토 기준 SEO 매핑](https://github.com/mposition/Tomverse/blob/8c7cb5ceb877b7721325c9e83bb18d53c5e9293e/lib/seo.ts)
- [검토 기준 sitemap](https://github.com/mposition/Tomverse/blob/8c7cb5ceb877b7721325c9e83bb18d53c5e9293e/app/sitemap.ts)

