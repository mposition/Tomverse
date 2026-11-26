# Tomverse Desktop remote control

A person watches the Code tasks their PC runs in Tomverse Desktop from a phone or another computer, answers the approval request on the PC's screen (allow once or deny), stops a task, or sends a running task a follow-up. The web screen is `/remote`, signed in to the same account.

## Switches

Both default off, and both must be on.

| Where | Switch | Off |
| --- | --- | --- |
| Server | `TOMVERSE_DESKTOP_REMOTE_CONTROL_ENABLED` (also needs `TOMVERSE_DESKTOP_AUTH_ENABLED`) | `/remote` is not found. The PC route answers 503 `NOT_AVAILABLE`, and the web routes answer 503 `NOT_AVAILABLE`. Nothing is read or written. |
| Desktop | Settings > Execution and limits > Allow control of this PC from other devices | The PC sends nothing. The switch belongs to the account that turned it on, so another account starts with it off. Turning it on asks in a native dialog. |

The PC sends nothing while nothing runs. While tasks run, it reports every 8 seconds. While a request that may be answered from elsewhere is open, it reports every 2 seconds. After a failure it backs off from 5 seconds up to 5 minutes. After a `NOT_AVAILABLE` it waits 10 minutes. The PC always opens the connection. The server never connects to it.

## What reaches the server

The report is built in the Desktop main process (`apps/desktop/src/host/remote-control.ts`). Every line goes through `cleanText` and a credential mask and is cut to length. The shapes are in `lib/desktopRemoteControlContract.ts`.

- For each running task (at most 8): its title, state, kind, the number of changed files, and the first prose line of its latest four messages (code blocks are skipped).
- For the approval request on the PC's screen: its id, the PC's digest of the whole request, its kind, the command line or up to 10 file paths with their actions, and whether it may be answered from another device.

File contents, diffs, command output, environment values, the browser text an agent would type, MCP arguments and credentials are never sent.

`DesktopRemoteDevice` keeps the latest report for 3 minutes after the last sync. `DesktopRemoteCommand` keeps each answer for 15 minutes, and an answer can be picked up only within its first 2 minutes. The PC counts the time since it asked on top of the age the server reports, so an answer that was young at the server and old on arrival is refused as expired. An answer to an approval request is kept past the 15 minutes for as long as the PC's report still shows that request, because the row is what refuses a second answer for it; it goes once the PC reports the request closed. For the same reason the report that shows an answered request is kept, hidden from the screen and unable to receive anything, after the PC stops reporting: a PC that was away and comes back with the request still open finds its answer there, and a second answer is refused. That hidden report goes when the PC reports again without the request, when the PC turns the switch off, or when the device's sign-in ends. Both are deleted by `lib/maintenance.ts` (step `desktop_remote_control`), and the screen deletes what it finds expired. When the PC turns the switch off (`DELETE /api/desktop/remote/sync`) its report and the answers waiting for it are removed at once. The PC numbers every request to the server, each higher than the last, and the server takes a report only when its number is higher than the last one it took from that PC and than the PC's withdrawal. What stays after a withdrawal is an empty, hidden marker with the number of that request, kept for 2 minutes: a sync the PC had sent before, which reaches the server after it, is refused (409 `STALE_SYNC`) and puts nothing back. A withdrawal obeys the same order: one that arrives after a later sync of the same PC (off and on again) was sent before it and changes nothing. The withdrawal writes its marker before it removes the waiting answers; writing it takes the row's lock, so an answer recorded at that moment is either removed with the rest or finds no report to answer. The PC also waits for a sync it has already sent before it sends the delete (about 11 seconds at most when the switch is turned off, 2 at sign-out, then it cancels that sync; the delete itself may take 3 more). Rows are hidden and deleted once the device's token family is revoked at sign-out. They cascade from `MobileDevice`, so deleting the device or the account deletes them.

## Who decides

The PC decides every approval. A remote answer names one request by id and digest. The Desktop applies it only when all of these hold:

- that request is the card on its screen now
- the digest of the whole request is unchanged
- the request is one that may be answered from elsewhere
- the answer is not a repeat
- it is younger than 2 minutes: the age the server reports plus the time since this PC asked
- it names this device

It goes through the same `answer()` as the approval window and is applied once. A follow-up goes through the window's own follow-up handler and its checks.

Only these may be answered from another device. The PC enforces this deterministically:

- File changes whose paths are all shown.
- Commands whose whole line is shown and needed no redaction, and that the CLI's permission boundary (`checkBoundaries`) does not leave to a person. A command that sends anything off this computer, names a credential file or names the app's data folder is never answered remotely. The task's own process, which holds the permission gate, reads that boundary from the request as the gate read it and marks the request (`atPcOnly`); remote control refuses a marked request, and reads the boundary once more from what the card holds, an argument list with its program path, with the same protected folders: the permission home, the app's data folder and the workspace lock folder.

Everything else is answered at the PC: every request of a project on another machine (SSH), because the action runs there and only the card at the PC names the machine; Git commit, push and pull request cards, MCP tools, web pages, the browser panel and "Allow for this run". Permission mode, project rule trust, plugin, MCP and hook approvals and schedules are Settings actions and have no remote path. Widening this list is an operator decision.

The server checks the same things before it stores an answer:

- the PC is the session's own and reports now
- the request is the one it reported, with the same digest, as answerable from elsewhere
- the request has not been answered yet

The server is still trusted to say who answered. It can only answer a request the PC already has open. A stronger proof, such as a key held on the phone, is not part of this version.

## Authentication

- PC: `POST` and `DELETE /api/desktop/remote/sync` take the device's own Desktop bearer, with `Origin: tomverse://desktop` and no cookie. The path is enrolled in `desktopWriteApiRoute` while Desktop authentication is on.
- Web: `GET /api/desktop/remote/devices` and `POST /api/desktop/remote/commands` take the signed-in browser session only. A bearer or a Desktop origin is refused.
- Acting (answering, stopping, sending a follow-up) needs a web sign-in within the account step-up window (`hasRecentAccountAuthentication`, 30 minutes by default). A Desktop device's own sign-in time does not count. An older session can only look and is offered "Sign in again".
- Each action is written to the admin audit chain in the same transaction: `desktop_remote.approval_answered`, `desktop_remote.task_stop_requested` or `desktop_remote.follow_up_sent`, with target `DesktopRemoteCommand`. The entry carries ids, the decision and the digest. It never carries follow-up text, a command line or a path.

## Rollout

1. Deploy with the server switch off. Migration `20261126120000_desktop_remote_control` adds the two tables and nothing else.
2. Turn on `TOMVERSE_DESKTOP_REMOTE_CONTROL_ENABLED` in Test, with `TOMVERSE_DESKTOP_AUTH_ENABLED` already on.
3. Install a Desktop build that has the setting.

To stop the feature, turn the server switch off. The rows left expire within 15 minutes and maintenance deletes them, except the hidden report of an answered request and its answer, which go when that device's sign-in ends.
