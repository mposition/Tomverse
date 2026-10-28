import { useEffect, useState, type ReactNode } from 'react';
import type { MobileLanguage } from '../../../locales/mobile';
import { partitionConversationRows } from '../../../lib/conversationListGrouping';
import type { ChatSummary, ChatTransport, HistoryProject, HistorySearch } from './chatTransport';
import { historyCopy } from './historyCopy';
import { Sheet } from './Sheet';
import { nativeConversationTitle } from './conversationTitle';

type Action = 'menu' | 'rename' | 'move' | 'share' | 'remove' | 'lock' | 'unlock' | 'open' | 'sourceDownload';
export function ConversationHistory({ transport, language, owner, chats, currentId, disabled, onOpen, onRefresh, onChanged }: {
  transport: ChatTransport; language: MobileLanguage; owner: string | null; chats: ChatSummary[]; currentId?: string;
  disabled: boolean; onOpen: (id: string) => void; onRefresh: () => Promise<ChatSummary[]>; onChanged: (id: string, deleted?: boolean, locked?: boolean) => void;
}) {
  const c = historyCopy(language), history = transport.history;
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [filterOpen, setFilterOpen] = useState(false);
  const [projects, setProjects] = useState<HistoryProject[]>([]), [search, setSearch] = useState<HistorySearch | null>(null);
  const [searchFailed, setSearchFailed] = useState(false), [searching, setSearching] = useState(false), [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<ChatSummary | null>(null), [action, setAction] = useState<Action>('menu');
  const [value, setValue] = useState(''), [projectId, setProjectId] = useState(''), [link, setLink] = useState(''), [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [unknown, setUnknown] = useState(false);
  const [openAfterUnlock, setOpenAfterUnlock] = useState(true);
  const [features, setFeatures] = useState({ sharing: false, downloads: false });
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [projectEditor, setProjectEditor] = useState<HistoryProject | 'new' | null>(null), [projectDelete, setProjectDelete] = useState(false);
  const marker = `tomverse-native-history-pending:${owner ?? 'signed-out'}`;
  useEffect(() => { setUnknown(Boolean(localStorage.getItem(marker))); }, [marker]);
  useEffect(() => { let active = true; void transport.models().then(models => { if (active) setModelNames(Object.fromEntries(models.map(model => [model.id, model.name]))); }).catch(() => {}); return () => { active = false; }; }, [transport]);
  useEffect(() => { let active = true; void transport.mobileCapabilities?.().then(capability => { if (active) setFeatures(capability.historyFeatures ?? { sharing: false, downloads: false }); }).catch(() => {}); return () => { active = false; }; }, [transport, revision]);
  useEffect(() => { let active = true; void history?.projects().then(items => { if (active) setProjects(items); }).catch(() => {}); return () => { active = false; }; }, [history, revision]);
  useEffect(() => {
    const controller = new AbortController(); let live = true; let expiry: ReturnType<typeof setTimeout> | undefined;
    setSearch(null); setSearchFailed(false); setSearching(false);
    if (!history || query.trim().length < 2) return () => controller.abort();
    const timer = setTimeout(() => {
      setSearching(true);
      void history.search(query.trim(), controller.signal).then(result => {
        if (!live) return; setSearch(result);
        if (result.validUntil) expiry = setTimeout(() => { setSearch(null); setSearchFailed(true); }, Math.max(0, Date.parse(result.validUntil) - Date.now()));
      }).catch(() => { if (live) { setSearch(null); setSearchFailed(true); } }).finally(() => { if (live) setSearching(false); });
    }, 300);
    return () => { live = false; controller.abort(); clearTimeout(timer); clearTimeout(expiry); };
  }, [history, query, revision]);
  async function refresh() {
    const rows = await onRefresh();
    if (selected) setSelected(rows.find(row => row.id === selected.id) ?? null);
    setSearch(null); setRevision(n => n + 1); return rows;
  }
  function choose(chat: ChatSummary, next: Action) {
    setSelected(chat); setAction(next === 'menu' && chat.isLocked && !history?.unlocked(chat.id) ? 'open' : next); setOpenAfterUnlock(next !== 'menu'); setValue(next === 'rename' ? chat.title : ''); setProjectId(chat.projectId ?? ''); setLink(''); setCopied(false); setError('');
    setUnknown(Boolean(localStorage.getItem(marker)));
  }
  async function run(work: () => Promise<unknown>, mutation = true, after?: () => void) {
    if (busy || disabled || (mutation && unknown)) return;
    setBusy(true); setError('');
    if (mutation) localStorage.setItem(marker, selected?.id ?? 'project');
    try {
      await work();
      if (mutation) { localStorage.removeItem(marker); await refresh().catch(() => setError(c.error)); }
      after?.();
    } catch (failure) {
      const problem = failure as { code?: string; status?: number };
      const uncertain = mutation && (!problem.status || problem.status >= 500 || problem.status === 408) && problem.code !== 'NATIVE_HISTORY_UNAVAILABLE';
      setUnknown(uncertain);
      if (!uncertain) localStorage.removeItem(marker);
      setError(problem.code === 'NATIVE_HISTORY_UNAVAILABLE' ? c.unsupported : c.error);
    } finally { setBusy(false); }
  }
  const normalized = query.trim().toLocaleLowerCase();
  const matching = new Map(search?.results.map(hit => [hit.conversationId, hit]));
  const filtered = chats.filter(chat => (!normalized || nativeConversationTitle(chat, language).toLocaleLowerCase().includes(normalized) || matching.has(chat.id)) && (
    filter === 'all' || (filter === 'locked' && chat.isLocked) || (filter === 'shared' && chat.shareEnabled) || (filter === 'comparison' && chat.kind !== 'image' && (chat.selectedModels?.length ?? 0) > 1) ||
    (filter.startsWith('project:') && chat.projectId === filter.slice(8)) || (filter.startsWith('model:') && chat.kind !== 'image' && chat.selectedModels?.includes(filter.slice(6)))
  ));
  const partition = partitionConversationRows(filtered);
  const groups = [{ name: c.pinned, rows: partition.pinned }, ...(filter === 'all' && !normalized ? partition.groups.map(group => ({ name: c[group.bucket], rows: group.conversations })) : [{ name: c.results, rows: partition.groups.flatMap(group => group.conversations) }])];
  const models = [...new Set(chats.filter(chat => chat.kind !== 'image').flatMap(chat => chat.selectedModels ?? []))];
  function item(label: string, work: () => void, blocked = false) { return <button disabled={busy || disabled || unknown || blocked || !history} onClick={work}>{label}</button>; }
  const close = () => { if (!busy) { setSelected(null); setValue(''); setLink(''); } };
  async function copyLink() {
    try { await navigator.clipboard.writeText(link); setCopied(true); }
    catch { document.querySelector<HTMLInputElement>('.history-share-link')?.select(); setError(c.copyManually); }
  }
  const report = <>{error && <p role="alert">{error}</p>}{unknown && <button disabled={busy} onClick={() => void run(async () => { await Promise.all([transport.list(), transport.listReview?.(), history?.projects()]); await refresh(); localStorage.removeItem(marker); setUnknown(false); setError(''); }, false)}>{c.check}</button>}</>;
  const form = (fields: ReactNode, work: () => Promise<unknown>, allowed = true, mutation = true, after?: () => void) => <form onSubmit={event => { event.preventDefault(); void run(work, mutation, after); }}>{fields}<button className="primary" disabled={busy || disabled || unknown || !allowed || !history}>{c.confirm}</button></form>;
  return <>
    <div className="history-controls"><input type="search" aria-label={c.search} placeholder={c.search} maxLength={80} value={query} onChange={event => setQuery(event.target.value)} /><button aria-label={c.filter} aria-pressed={filter !== 'all'} onClick={() => setFilterOpen(true)}>☷</button></div>
    {searching && <p role="status" className="history-notice">{c.searching}</p>}
    {searchFailed && <p role="alert" className="history-notice">{c.searchFailed}<button onClick={() => setRevision(n => n + 1)}>{c.retry}</button></p>}
    {(search?.truncated || (search?.sourceSearch && search.sourceSearch !== 'ok')) && <p role="status" className="history-notice">{c.searchLimited}</p>}
    {!filtered.length && <p className="history-notice">{c.empty}</p>}
    {groups.filter(group => group.rows.length).map(group => <section key={group.name} className="history-group"><h2>{group.name}</h2>{group.rows.map(chat => <div className="history-row" key={chat.id}>
      <button className="conversation-row" aria-current={currentId === chat.id ? 'page' : undefined} disabled={disabled || busy} onClick={() => chat.isLocked && !history?.unlocked(chat.id) ? choose(chat, 'open') : onOpen(chat.id)}><span className="conversation-title">{chat.isLocked && <svg className="history-lock" aria-label={c.locked} width="12" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="10" width="16" height="12" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4" /></svg>}{nativeConversationTitle(chat, language)}{matching.has(chat.id) && <span className="history-snippet">{matching.get(chat.id)?.kind === 'imported' && `${c.original} · `}{matching.get(chat.id)?.snippet}</span>}</span></button>
      <button className="history-more" aria-label={`${c.more}: ${nativeConversationTitle(chat, language)}`} disabled={disabled || busy} onClick={() => choose(chat, 'menu')}>⋯</button>
    </div>)}</section>)}
    {filterOpen && <Sheet title={c.filter} closeLabel={c.cancel} onClose={() => { if (!busy) setFilterOpen(false); }}><div className="history-menu">
      {(['all', 'locked', 'shared', 'comparison'] as const).map(key => <button key={key} aria-pressed={filter === key} onClick={() => { setFilter(key); setFilterOpen(false); }}>{c[key]}</button>)}
      <h3>{c.models}</h3>{models.map(model => <button key={model} aria-pressed={filter === `model:${model}`} onClick={() => { setFilter(`model:${model}`); setFilterOpen(false); }}>{modelNames[model] ?? model}</button>)}
      <h3>{c.projects}</h3>{projects.map(project => <div className="history-project" key={project.id}><button aria-pressed={filter === `project:${project.id}`} onClick={() => { setFilter(`project:${project.id}`); setFilterOpen(false); }}>{project.name}</button><button aria-label={`${c.renameProject}: ${project.name}`} onClick={() => { setProjectEditor(project); setValue(project.name); setProjectDelete(false); }}>✎</button><button aria-label={`${c.deleteProject}: ${project.name}`} onClick={() => { setProjectEditor(project); setProjectDelete(true); setValue(''); }}>×</button></div>)}
      <button disabled={!history || busy} onClick={() => { setProjectEditor('new'); setProjectDelete(false); setValue(''); }}>{c.newProject}</button>
    </div></Sheet>}
    {projectEditor && <Sheet title={projectDelete ? c.deleteProject : projectEditor === 'new' ? c.newProject : c.renameProject} closeLabel={c.cancel} onClose={() => { if (!busy) setProjectEditor(null); }}>{report}{form(projectDelete ? <p>{c.deleteProjectNotice}</p> : <label>{c.projectName}<input value={value} maxLength={32} onChange={event => setValue(event.target.value)} /></label>, () => projectDelete && projectEditor !== 'new' ? history!.deleteProject(projectEditor.id) : history!.saveProject(projectEditor === 'new' ? null : projectEditor.id, value.trim()), projectDelete || Boolean(value.trim()), true, () => { if (projectDelete && projectEditor !== 'new' && filter === `project:${projectEditor.id}`) setFilter('all'); setProjectEditor(null); setValue(''); })}</Sheet>}
    {selected && <Sheet title={action === 'menu' ? selected.title : c[action === 'sourceDownload' ? 'sourceDownload' : action]} closeLabel={c.cancel} onClose={close}><div className="history-menu">{report}
      {action === 'menu' ? <>
        {item(c.rename, () => { setAction('rename'); setValue(selected.title); })}
        {item(selected.pinned ? c.unpin : c.pin, () => void run(() => history!.pin(selected, !selected.pinned)))}
        {item(c.move, () => setAction('move'))}
        {selected.kind !== 'image' && <>
          {selected.sourceState ? <p>{c.sourceShare}</p> : item(selected.shareEnabled ? c.refreshShare : c.share, () => setAction('share'), !features.sharing)}
          {selected.shareEnabled && item(c.revoke, () => void run(() => history!.revokeShare(selected.id)))}
          {item(c.download, () => void run(() => history!.export(selected.id, selected.title, false), false), !features.downloads)}
          {selected.sourceState && item(c.sourceDownload, () => setAction('sourceDownload'), selected.sourceState === 'deleted' || !features.downloads)}
        </>}
        {item(c.remove, () => setAction('remove'))}
        {item(selected.isLocked ? c.unlock : c.lock, () => { setAction(selected.isLocked ? 'unlock' : 'lock'); setValue(''); })}
      </> : action === 'rename' ? form(<label>{c.title}<input value={value} maxLength={100} onChange={event => setValue(event.target.value)} /></label>, () => history!.rename(selected.id, value.trim()), Boolean(value.trim()), true, () => { onChanged(selected.id); close(); })
        : action === 'move' ? form(<label>{c.projects}<select aria-label={c.projects} value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">{c.noProject}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>, () => history!.move(selected.id, projectId || null), true, true, close)
        : action === 'share' ? link ? <><label>{c.link}<input className="history-share-link" value={link} readOnly /></label><button onClick={() => void copyLink()}>{copied ? c.copied : c.copy}</button></> : form(<p>{c.shareNotice}</p>, async () => { const result = await history!.share(selected.id); setLink(result.url); })
        : action === 'remove' ? form(<p>{c.deleteNotice}</p>, () => history!.remove(selected.id), true, true, () => { onChanged(selected.id, true); close(); })
        : action === 'sourceDownload' ? form(<p>{c.sourceNotice}</p>, () => history!.export(selected.id, selected.title, true), true, false)
        : form(<label>{action === 'unlock' ? c.currentPassword : c.password}<input type="password" autoComplete="off" value={value} maxLength={128} onChange={event => setValue(event.target.value)} /></label>, () => action === 'open' ? history!.unlock(selected.id, value) : history!.password(selected.id, action === 'unlock' ? null : value, action === 'unlock' ? value : undefined), value.length >= (action === 'lock' ? 8 : 1), action !== 'open', () => { const id = selected.id; setValue(''); setSearch(null); onChanged(id, false, action === 'lock'); if (action === 'open' && !openAfterUnlock) { setAction('menu'); setRevision(n => n + 1); } else { close(); if (action === 'open') onOpen(id); } })}
    </div></Sheet>}
  </>;
}
