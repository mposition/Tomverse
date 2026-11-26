import type { Language } from "../../../../lib/language";
import { desktopParallelCopy } from "../../../../locales/desktopParallel";
import type { Task } from "../contract";
import type { LaneRow } from "../parallel-contract";
import { fill, kindLabel, rowStatus } from "./parallel-labels";
import "./parallel.css";

/**
 * A read-only view of one task: what it was asked, what it said and did, and which files it changed. It is what the side-by-side view and a
 * task's own window show. The open task has its full conversation in the main screen; this is the same task seen from the side.
 */
export function LaneTaskView({ task, row, language, onStop }: { task: Task | null; row: LaneRow | null; language: Language; onStop?: () => void }) {
  const copy = desktopParallelCopy[language];
  const lines = (task?.entries ?? []).flatMap((entry, index) => entry.role === "plan" || !entry.text.trim() ? [] : [{ index, entry }]);
  return <article className="lane-view" data-testid="lane-task-view" data-state={row?.state} aria-label={task?.title ?? row?.title}>
    <header>
      <div>
        <strong>{task?.title ?? row?.title}</strong>
        {row && <small>{kindLabel(copy, row.kind)} · <span data-testid="lane-view-status">{rowStatus(copy, row)}</span></small>}
        <small><code>{task?.root ?? row?.folder}</code></small>
      </div>
      {row?.canStop && onStop && <button type="button" className="soft" onClick={onStop}>{copy.stop}</button>}
    </header>
    {!task && <p role="status">{copy.paneWaiting}</p>}
    <ol className="lane-entries">
      {lines.map(({ index, entry }) => <li key={index} data-role={entry.role}>
        <small>{entry.role === "user" ? copy.entryUser : entry.role === "assistant" ? copy.entryAssistant : copy.entryEvent}</small>
        <p>{entry.text}</p>
      </li>)}
    </ol>
    {task?.streamingAnswer && <p className="lane-streaming">{task.streamingAnswer}</p>}
    {!!task?.changes.length && <section aria-label={copy.changesHeading}>
      <h3>{copy.changesHeading} · {fill(copy.changedFiles, { count: task.changes.length })}</h3>
      <ul>{task.changes.map((change) => <li key={change.id}><code>{change.kind}</code> {change.path}</li>)}</ul>
    </section>}
  </article>;
}
