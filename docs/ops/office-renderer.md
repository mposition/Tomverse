# Office 렌더러 서비스 (Gotenberg) 운영

정책: `docs/policy/generated-artifacts.md` §15. 이 서비스는 Word·PowerPoint·
Excel·한글(HWP·HWPX)·Pages·Numbers 파일을 레이아웃 그대로 PDF로 만든다.
**서비스를 만들고 스위치를 켜는 일은 상시 비용이 생기는 배포라 운영자 승인 뒤에 한다.**

## 1. 서비스 만들기 (Railway 웹 대시보드)

1. 앱과 같은 Railway project·environment에 **New → GitHub Repo**로 서비스를 만들고,
   Root Directory를 `apps/office-renderer`로 둔다. 그 폴더의 `Dockerfile`이
   Gotenberg에 두 가지를 더한다:
   - `libreoffice-h2orestart` — 기본 LibreOffice는 한글 97(HWP 3)만 읽는다. HWP 5.x·
     HWPX는 이 필터(GPL-3.0-or-later, Debian 패키지)가 있어야 열린다.
   - 한글 글꼴(`fonts-nanum`, `fonts-noto-cjk`) — 없으면 글꼴이 바뀌어 쪽이 밀린다.
   - 기반 이미지 버전은 build arg `GOTENBERG_TAG`로 **고정**한다(예: `8.x.y`). Docker
     Hub에서 2주 이상 된 버전을 고른다. 이 Dockerfile은 아직 실제로 빌드해 보지
     않았다 — 첫 배포의 빌드 로그에서 패키지 설치가 성공했는지 확인한다.
   - 서비스 이름: `office-renderer` (private 주소가 `office-renderer.railway.internal`이 된다).
2. **Public domain을 만들지 않는다.** Private networking만 쓴다.
3. 환경 변수:

   | 변수 | 값 | 이유 |
   |---|---|---|
   | `API_ENABLE_BASIC_AUTH` | `true` | 같은 망의 다른 서비스도 마음대로 부르지 못하게 |
   | `GOTENBERG_API_BASIC_AUTH_USERNAME` | 임의 | 앱의 `OFFICE_RENDERER_USERNAME`과 같게 |
   | `GOTENBERG_API_BASIC_AUTH_PASSWORD` | 긴 무작위 값 | 앱의 `OFFICE_RENDERER_PASSWORD`와 같게. 대화에 붙이지 않는다 |
   | `API_DISABLE_DOWNLOAD_FROM` | `true` | URL에서 파일을 가져오는 기능 끔 (SSRF 방지) |
   | `API_TIMEOUT` | `90s` | 앱의 시간 제한과 같게 |
   | `API_BODY_LIMIT` | `30MB` | 첨부 상한(25 MB) + 여유 |

4. 메모리는 1~2 GB로 시작한다(LibreOffice와 H2Orestart의 Java). 첫 확인 때
   한국어 docx와 hwp를 꼭 넣어 본다.

## 2. 앱 서비스에 연결

앱(웹) 서비스의 환경 변수:

| 변수 | 값 |
|---|---|
| `OFFICE_RENDERER_URL` | `http://office-renderer.railway.internal:3000` |
| `OFFICE_RENDERER_USERNAME` | 위와 같은 값 |
| `OFFICE_RENDERER_PASSWORD` | 위와 같은 값 |
| `CHAT_OFFICE_TO_PDF` | `on` (켜는 스위치. 끄려면 지우거나 `off`) |

Railway 변수는 **다음 배포부터** 적용된다. 변수를 바꾼 뒤 앱을 다시 배포한다.

## 3. 확인

1. Railway 렌더러 서비스 로그에 `/health` 200이 보이는지 확인한다.
2. 로그인한 계정으로 채팅에 한국어 `.docx` 하나와 `.pptx` 하나를 첨부하고
   "PDF로 만들어 줘"라고 보낸다. 다운로드 카드의 PDF를 열어 글꼴·표·그림을 본다.
3. `.pages` 하나를 첨부해 같은 요청을 보낸다.
4. 렌더러 서비스를 잠시 멈춘 상태에서 같은 요청을 보내면 "잠시 뒤 다시" 카드가
   나와야 한다(`generation_failed`).

## 4. 끄기

앱의 `CHAT_OFFICE_TO_PDF`를 지우고 재배포하면 Office→PDF 안내와 iWork 첨부 허용이
함께 꺼진다. 렌더러 서비스는 그 뒤에 내려도 된다.
