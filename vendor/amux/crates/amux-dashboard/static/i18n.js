// Dashboard language: English (source) and Korean.
//
// English stays the source text. index.html and app.js are written in English,
// and anything without a Korean entry below renders exactly as it did before, so
// a missing key is an English word on a Korean screen, never a blank or a key
// name. Korean is added one screen at a time; AMUX_KO lists what is covered.
//
// Static markup opts in with data-i18n="key" (replaces textContent, so only on
// a leaf element) and data-i18n-attr="title:key;placeholder:key;aria-label:key".
// The English original is kept on the element the first time it is replaced,
// so the English screen never needs a second copy of its own text.
//
// Load order matters: this file runs after the markup above it is parsed and
// BEFORE app.js, because app.js reads some labels once at load (ALL_TABS takes
// each .tab-lbl for the tab customizer) and would otherwise keep the English.

const AMUX_LANGS = ['en', 'ko'];
const AMUX_LANG_KEY = 'amux_lang';

function amuxLangStored() {
  try {
    const v = localStorage.getItem(AMUX_LANG_KEY);
    return AMUX_LANGS.includes(v) ? v : '';
  } catch (e) { return ''; }
}

// The FIRST browser preference decides, not any entry in the list: a browser
// set to English that also lists Korean further down asked for English.
function amuxLangResolve() {
  const stored = amuxLangStored();
  if (stored) return stored;
  const first = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  return /^ko(-|$)/i.test(first) ? 'ko' : 'en';
}

const AMUX_LANG = amuxLangResolve();

const AMUX_KO = {
  // Header and connection status
  'conn.title': '연결 상태 — 눌러서 끊김 기록 보기',
  'conn.access_required': '접근 권한 필요',
  'conn.sync_error': '동기화 오류',
  'conn.offline': '오프라인',
  'conn.pending': '대기 {n}건',
  'conn.live': '실시간',
  'conn.polling': '주기 조회',
  'conn.details': '{state} — 연결 세부 정보',
  'header.notifications': '알림',
  'header.create': '만들기 또는 연결',
  'header.new_worker': '새 워커',
  'header.connect_tmux': 'tmux 연결',
  'header.connect_iterm2': 'iTerm2 창 연결',
  'header.orchestrate_voice': '오케스트레이션 (음성)',
  'header.bulk_actions': '일괄 작업',
  'header.settings': '설정',

  // Settings: tab names and the Device > Appearance section
  'settings.tab.account': '계정',
  'settings.tab.workers': '워커',
  'settings.tab.notifications': '알림',
  'settings.tab.integrations': '연결',
  'settings.tab.device': '기기',
  'settings.appearance': '화면',
  'settings.theme.dark': '다크 모드',
  'settings.theme.light': '라이트 모드',
  'settings.tabs': '탭',
  'settings.tabs.both': '아이콘과 텍스트',
  'settings.tabs.icons': '아이콘만',
  'settings.tabs.text': '텍스트만',
  'settings.tabs.counts_hint': '모든 모드에서 개수는 계속 보입니다',
  'settings.zoom': '배율',
  'settings.zoom.reset': '초기화',
  'settings.language': '언어',
  'settings.language.auto': '브라우저 설정',

  // Navigation tabs. MDAI is a product name and stays as it is.
  'tab.sessions': '워커',
  'tab.board': '보드',
  'tab.groups': '그룹',
  'tab.calendar': '캘린더',
  'tab.scheduler': '스케줄러',
  'tab.files': '파일',
  'tab.record': '녹음',
  'tab.proxies': '프록시',
  'tab.email': '이메일',
  'tab.connectors': '커넥터',
  'tab.logs': '로그',
  'tab.grid': '워크스페이스',
  'tab.messages': '메시지',
  'tab.skills': '스킬',
  'tab.sql': '데이터베이스',
  'tab.map': '맵',
  'tab.metrics': '지표',
  'tab.disk': '디스크',
  'tab.cost': '비용',
  'tab.torrents': '토렌트',
  'tab.terminal': '터미널',
  'tab.browser': '브라우저',
  'tab.orchestrations': '오케스트레이션',
  'tab.customize': '탭 표시/숨기기',

  // Board: heading, filters, toolbar, saved views, columns
  'board.title': '보드',
  'board.subtitle': '작업을 결과로',
  'board.create_task': '보드 작업 만들기',
  'board.quick.label': '빠른 보드 필터',
  'board.quick.all': '전체',
  'board.quick.mine': '내 작업',
  'board.quick.doing': '진행 중',
  'board.quick.needsyou': '확인 필요',
  'board.quick.review': '검토',
  'board.launch.title': '우선순위 실행',
  'board.filter.add': '+ 필터',
  'board.filter.add_title': '필터 추가',
  'board.search.placeholder': '검색 또는 필터: is:rotting, status:doing, -worker:none',
  'board.new_issue': '+ 새 이슈',
  'board.owner.all': '전체',
  'board.owner.all_title': '모든 이슈',
  'board.owner.human': '사람',
  'board.owner.human_title': '사람 이슈',
  'board.owner.agent': '워커',
  'board.owner.agent_title': '워커 이슈',
  'board.view.list_title': '상태별 촘촘한 목록',
  'board.view.worker_title': '워커별 그룹',
  'board.view.status_title': '상태별 그룹',
  'board.view.smart_title': '스마트 보드: 기록된 사실로 계산한 상태',
  'board.export.md_title': '지금 보이는 이슈(필터 적용)를 Markdown으로 내보내기',
  'board.export.json_title': '지금 보이는 이슈(필터 적용)를 JSON으로 내보내기',
  'board.saved._working': '지금 실행 중',
  'board.saved._needsyou': '확인 필요',
  'board.saved._armed': '감시 대기',
  'board.saved._rotting': '방치됨',
  'board.saved._orphan': '담당 없음',
  'board.saved._mine': '내 것',
  'board.saved._archived': '보관됨',
  'board.col.collapse': '접기',
  'board.col.expand': '펼치기',
  'board.col.terminal': '종료',
  'status.backlog': '백로그',
  'status.todo': '할 일',
  'status.doing': '진행 중',
  'status.review': '검토 중',
  'status.done': '완료',
  'status.verified': '검증됨',
  'status.discarded': '폐기됨',
  'status.needsyou': '확인 필요',
  'status.blocked': '차단됨',
  'status.armed': '감시 대기',
  'status.quarantined': '격리됨',
};

// `en` is the text the caller would have shown without this file, so English
// output is byte-identical to the pre-i18n dashboard. {name} placeholders are
// filled from `vars` in either language.
function amuxT(key, en, vars) {
  let s = (AMUX_LANG === 'ko' && Object.prototype.hasOwnProperty.call(AMUX_KO, key)) ? AMUX_KO[key] : en;
  if (vars) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

function amuxI18nApply(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach(el => {
    if (el.dataset.i18nEn === undefined) el.dataset.i18nEn = el.textContent;
    el.textContent = amuxT(el.dataset.i18n, el.dataset.i18nEn);
  });
  scope.querySelectorAll('[data-i18n-attr]').forEach(el => {
    el.dataset.i18nAttr.split(';').forEach(pair => {
      const [attr, key] = pair.split(':').map(s => s.trim());
      if (!attr || !key) return;
      const store = 'i18nEn' + attr.replace(/(^|-)([a-z])/g, (m, dash, c) => c.toUpperCase());
      if (el.dataset[store] === undefined) el.dataset[store] = el.getAttribute(attr) || '';
      el.setAttribute(attr, amuxT(key, el.dataset[store]));
    });
  });
}

// Builtin board columns are translated only while they still carry their
// default English label. A column someone renamed shows the name they chose,
// in either language. Display only: the stored label is never rewritten, so a
// status edit can never save the Korean text back to the server.
// The last four are statuses cards can carry without a configured column; the
// board then draws a stray column labelled with the bare id.
const AMUX_STATUS_DEFAULT_EN = {
  backlog: 'Backlog', todo: 'To Do', doing: 'In Progress', review: 'In Review',
  done: 'Done', verified: 'Verified', discarded: 'Discarded',
  needsyou: 'needsyou', blocked: 'blocked', armed: 'armed', quarantined: 'quarantined',
};
function amuxStatusLabel(st) {
  if (!st) return '';
  const label = st.label || st.id || '';
  return AMUX_STATUS_DEFAULT_EN[st.id] === label ? amuxT('status.' + st.id, label) : label;
}

// 'auto' clears the choice so the browser language decides again. Reload
// rather than re-render: app.js builds many strings once (the tab customizer,
// open menus, rendered cards), and only a fresh start rebuilds all of them.
function amuxSetLang(value) {
  try {
    if (AMUX_LANGS.includes(value)) localStorage.setItem(AMUX_LANG_KEY, value);
    else localStorage.removeItem(AMUX_LANG_KEY);
  } catch (e) {}
  location.reload();
}

document.documentElement.lang = AMUX_LANG;
amuxI18nApply(document);
(function _amuxLangSelectSync() {
  const sel = document.getElementById('lang-select');
  if (sel) sel.value = amuxLangStored() || 'auto';
})();
