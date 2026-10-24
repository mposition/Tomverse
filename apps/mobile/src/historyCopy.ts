import type { MobileLanguage } from '../../../locales/mobile';
const en = {
  search: 'Search conversations', filter: 'Filter conversations', all: 'All conversations', locked: 'Locked', shared: 'Shared', comparison: 'Comparisons', models: 'Models', projects: 'Projects',
  more: 'More actions', rename: 'Rename', pin: 'Pin conversation', unpin: 'Unpin conversation', move: 'Move to project', noProject: 'No project', share: 'Share', refreshShare: 'Refresh share link', revoke: 'Revoke share link', download: 'Download TXT', sourceDownload: 'Download TXT with original',
  remove: 'Delete conversation', lock: 'Lock conversation', unlock: 'Remove conversation lock', open: 'Unlock and open', password: 'Password', currentPassword: 'Current password', title: 'Conversation title',
  save: 'Save', cancel: 'Cancel', confirm: 'Confirm', error: 'The action could not finish. Check the saved state before trying again.', check: 'Check saved state', unsupported: 'Some conversation controls are temporarily unavailable.',
  deleteNotice: 'Delete this conversation and its messages? This cannot be undone.', shareNotice: 'Create a public snapshot link? Anyone with the link can read the shared messages. Later messages are not added until you refresh the link.',
  sourceNotice: 'This download includes the imported original. Downloaded files cannot be recalled.', sourceShare: 'Conversations continued from an imported chat cannot be shared publicly yet.',
  link: 'Share link', copy: 'Copy link', copied: 'Copied', copyManually: 'Press and hold the link to copy it.', newProject: 'New project', renameProject: 'Rename project', deleteProject: 'Delete project', projectName: 'Project name', deleteProjectNotice: 'Remove this project? Its conversations remain in your account.',
  empty: 'No conversations found', searching: 'Searching messages…', searchFailed: 'Message search failed. Retry to search message contents.', searchLimited: 'Some message matches may be missing. Refine your search.', retry: 'Retry search',
  pinned: 'Pinned', today: 'Today', yesterday: 'Yesterday', lastSevenDays: 'Previous 7 days', older: 'Older', results: 'Search results', original: 'Original conversation', unavailable: 'Unavailable',
};
const ko: typeof en = {
  search: '대화 검색', filter: '대화 필터', all: '모든 대화', locked: '잠긴 대화', shared: '공유된 대화', comparison: '비교 대화', models: '모델', projects: '프로젝트',
  more: '추가 작업', rename: '이름 변경', pin: '대화 고정', unpin: '고정 해제', move: '프로젝트로 이동', noProject: '프로젝트 없음', share: '공유', refreshShare: '공유 링크 갱신', revoke: '공유 링크 해제', download: 'TXT 다운로드', sourceDownload: '원문 포함 TXT 다운로드',
  remove: '대화 삭제', lock: '대화 잠금', unlock: '대화 잠금 해제', open: '잠금 확인 후 열기', password: '비밀번호', currentPassword: '현재 비밀번호', title: '대화 이름',
  save: '저장', cancel: '취소', confirm: '확인', error: '작업을 완료하지 못했습니다. 저장 상태를 확인한 뒤 다시 시도해 주세요.', check: '저장 상태 확인', unsupported: '일부 대화 관리 기능을 일시적으로 사용할 수 없습니다.',
  deleteNotice: '이 대화와 메시지를 삭제할까요? 삭제 후에는 되돌릴 수 없습니다.', shareNotice: '공개된 대화 사본 링크를 만들까요? 링크를 가진 누구나 공유된 메시지를 읽을 수 있습니다. 이후 메시지는 링크를 갱신해야 포함됩니다.',
  sourceNotice: '가져온 원문이 함께 저장됩니다. 다운로드한 파일은 회수할 수 없습니다.', sourceShare: '가져온 대화에서 이어진 대화는 아직 공개 공유할 수 없습니다.',
  link: '공유 링크', copy: '링크 복사', copied: '복사됨', copyManually: '링크를 길게 눌러 복사해 주세요.', newProject: '새 프로젝트', renameProject: '프로젝트 이름 변경', deleteProject: '프로젝트 삭제', projectName: '프로젝트 이름', deleteProjectNotice: '프로젝트를 삭제할까요? 포함된 대화는 계정에 남습니다.',
  empty: '해당하는 대화가 없습니다', searching: '메시지 검색 중…', searchFailed: '메시지 검색에 실패했습니다. 본문을 검색하려면 다시 시도해 주세요.', searchLimited: '일부 검색 결과가 생략될 수 있습니다. 검색어를 구체적으로 입력해 주세요.', retry: '검색 다시 시도',
  pinned: '고정됨', today: '오늘', yesterday: '어제', lastSevenDays: '지난 7일', older: '이전 대화', results: '검색 결과', original: '가져온 원문', unavailable: '사용할 수 없음',
};
export function historyCopy(language: MobileLanguage) { return language === 'ko' ? ko : en; }
