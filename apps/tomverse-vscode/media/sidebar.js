(() => {
    const api = acquireVsCodeApi();
    const channel = document.body.dataset.channel;
    let state;
    let composing = false;
    const app = document.getElementById("app");
    const el = (tag, text, className) => {
        const node = document.createElement(tag);
        if (text) node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    const post = (message) => api.postMessage({ channel, run: state?.run ?? "", ...message });
    const button = (label, action) => {
        const node = el("button", label);
        node.type = "button";
        node.addEventListener("click", action);
        return node;
    };
    const heading = el("h1", "Tomverse");
    const onboarding = el("p", "", "muted");
    const toolbar = el("div", "", "toolbar");
    const advanced = el("details");
    const advancedTitle = el("summary");
    const advancedToolbar = el("div", "", "toolbar");
    advanced.append(advancedTitle, advancedToolbar);
    const status = el("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const root = el("p", "", "muted");
    const notice = el("pre", "", "notice");
    const history = el("section", "", "history");
    history.setAttribute("role", "log");
    history.setAttribute("aria-live", "off");
    const modelLabel = el("label");
    const models = el("select");
    models.id = "model";
    modelLabel.htmlFor = models.id;
    const mode = el("select");
    mode.id = "mode";
    mode.setAttribute("aria-label", "Ask / Agent");
    const effort = button("", () => post({ type: "chooseEffort", model: models.value }));
    effort.id = "effort";
    const renderEffort = () => {
        if (!state) return;
        const level = state.effort?.model === models.value ? state.effort.level : "default";
        effort.textContent = `${state.labels.effort}: ${state.labels[`effort_${level}`]}`;
        effort.disabled = state.busy || !!state.problem || !state.connected || !models.value || state.effort?.locked;
        effort.title = state.effort?.locked ? state.labels.effortLocked : state.labels.effortDefault;
    };
    models.addEventListener("change", renderEffort);
    const promptLabel = el("label");
    const prompt = el("textarea");
    prompt.id = "prompt";
    prompt.rows = 4;
    promptLabel.htmlFor = prompt.id;
    prompt.value = api.getState()?.draft ?? "";
    prompt.addEventListener("input", () => api.setState({ draft: prompt.value }));
    prompt.addEventListener("compositionstart", () => (composing = true));
    prompt.addEventListener("compositionend", () => (composing = false));
    const submit = () => {
        if (!state || state.busy || composing || !prompt.value.trim()) return;
        post({ type: "send", epoch: state.epoch, prompt: prompt.value, mode: mode.value, model: models.value });
        prompt.value = "";
        api.setState({ draft: "" });
        send.disabled = true;
    };
    prompt.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing && !composing) {
            event.preventDefault();
            submit();
        }
    });
    const send = button("", submit);
    send.id = "send";
    const stop = button("", () => post({ type: "action", action: "stop" }));
    const attachments = el("section");
    const approval = el("section");
    const changes = el("section");
    const permissions = el("p", "", "muted");
    const receipts = el("pre");
    receipts.id = "receipts";
    const toolResults = el("section");
    const limits = el("p", "", "muted");
    app.append(
        heading,
        onboarding,
        toolbar,
        status,
        root,
        notice,
        history,
        attachments,
        approval,
        permissions,
        changes,
        modelLabel,
        models,
        effort,
        mode,
        promptLabel,
        prompt,
        send,
        stop,
        receipts,
        toolResults,
        advanced,
        limits,
    );
    const actions = [
        ["connect", "connect"],
        ["disconnect", "disconnect"],
        ["refresh", "refresh"],
        ["selectRoot", "root"],
        ["newSession", "new"],
        ["sessions", "sessions"],
        ["attachFile", "file"],
        ["attachSelection", "selection"],
        ["attachDiagnostics", "diagnostics"],
        ["keys", "keys"],
        ["logs", "logs"],
        ["clearApprovals", "clear"],
        ["exportDiagnostics", "export"],
        ["delete", "delete"],
        ["recover", "recover"],
    ];
    const buttons = actions.map(([key, action]) => {
        const node = button("", () => post({ type: "action", action }));
        (["connect", "root", "new", "file", "selection", "diagnostics"].includes(action) ? toolbar : advancedToolbar).append(node);
        return { key, action, node };
    });
    window.addEventListener("message", (event) => {
        const next = event.data;
        if (
            !next ||
            next.type !== "state" ||
            next.channel !== channel ||
            typeof next.busy !== "boolean" ||
            typeof next.run !== "string" ||
            !Array.isArray(next.transcript) ||
            !next.labels ||
            !Number.isSafeInteger(next.revision) ||
            (state && next.revision < state.revision) ||
            !Array.isArray(next.models) ||
            next.models.length > 500 ||
            next.models.some((m) => !m || typeof m.id !== "string" || typeof m.name !== "string") ||
            next.transcript.length > 100 ||
            next.transcript.some((m) => !m || typeof m.role !== "string" || typeof m.text !== "string" || m.text.length > 250000) ||
            typeof next.epoch !== "string" ||
            typeof next.state !== "string"
        )
            return;
        const previousModel = models.value;
        state = next;
        const l = state.labels;
        onboarding.textContent = l.onboarding;
        advancedTitle.textContent = `${l.sessions} · ${l.keys}`;
        for (const item of buttons) {
            item.node.textContent = l[item.key];
            item.node.hidden = item.action === "connect" && state.connected;
            item.node.disabled = state.busy && !["logs", "keys", "clear"].includes(item.action);
        }
        attachments.replaceChildren();
        if (state.attachments?.length) attachments.append(el("h2", l.context));
        for (const attachment of state.attachments || []) {
            const row = el("div");
            row.append(
                el(
                    "pre",
                    `${attachment.path} · ${attachment.kind} · v${attachment.version} · ${attachment.bytes} B${attachment.dirty ? ` · ${l.unsaved}` : ""}${attachment.truncated ? ` · ${l.truncated}` : ""}${attachment.range ? ` · ${attachment.range.join(":")}` : ""}`,
                ),
                button(l.remove, () => post({ type: "removeContext", id: attachment.id })),
            );
            attachments.append(row);
        }
        approval.replaceChildren();
        if (state.approval) {
            const p = state.approval;
            approval.className = "approval";
            approval.setAttribute("aria-label", l.awaiting);
            approval.append(el("h2", l.awaiting), el("strong", p.tool), el("p", p.explanation));
            if (p.command) approval.append(el("pre", JSON.stringify(p.command, null, 2)), el("p", l.onboarding));
            p.files.forEach((file, index) => {
                const row = el("div");
                row.append(
                    el("pre", `${file.action} ${file.path} · ${file.eol} · BOM:${file.bom} · ${file.beforeBytes} → ${file.afterBytes} B`),
                    button(l.diff, () => post({ type: "diff", id: p.id, index, details: false })),
                    button(l.details, () => post({ type: "diff", id: p.id, index, details: true })),
                );
                approval.append(row);
            });
            approval.append(button(l.once, () => post({ type: "approve", id: p.id, decision: "once" })));
            if (p.canRemember) approval.append(button(l.run, () => post({ type: "approve", id: p.id, decision: "run" })));
            approval.append(button(l.deny, () => post({ type: "approve", id: p.id, decision: "deny" })));
        } else approval.className = "";
        permissions.textContent = (state.permissions || []).join("\n");
        changes.replaceChildren();
        if (state.changes?.length) changes.append(el("h2", l.changes));
        for (const change of state.changes || []) {
            const row = el("div");
            const undo = button(l.undo, () => post({ type: "undo", id: change.changeId }));
            undo.disabled = state.busy || change.current !== "as_written";
            row.append(el("pre", `${change.kind} ${change.path} · ${change.current}`), undo);
            changes.append(row);
        }
        status.textContent = l[state.problem || state.state] || state.state;
        root.textContent = [state.root, state.session, state.model?.pinned ? `${l.pinned}: ${state.model.pinned}` : ""].filter(Boolean).join("\n");
        notice.textContent = state.notice;
        const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 50;
        history.replaceChildren(
            ...state.transcript.map((entry) => {
                const node = el("article");
                node.append(el("strong", entry.role + (entry.truncated ? ` · ${l.truncated}` : "")), el("pre", entry.text));
                return node;
            }),
        );
        if (nearBottom) history.scrollTop = history.scrollHeight;
        models.replaceChildren(
            ...state.models.map((model) => {
                const selectedEffort =
                    state.effort?.model === model.id && state.effort.level !== "default" ? ` · ${l.effort}: ${l[`effort_${state.effort.level}`]}` : "";
                const option = el("option", `${model.name}${selectedEffort} · ${model.creditsPerRequest} ${l.credits}`);
                option.value = model.id;
                return option;
            }),
        );
        if (state.model) models.value = state.model.requested;
        else if (state.models.some((m) => m.id === previousModel)) models.value = previousModel;
        const oldMode = mode.value;
        mode.replaceChildren(
            ...[
                ["ask", l.ask],
                ["agent", l.agent],
            ].map(([value, label]) => {
                const option = el("option", label);
                option.value = value;
                return option;
            }),
        );
        mode.value = state.readOnly === undefined ? oldMode || "ask" : state.readOnly ? "ask" : "agent";
        modelLabel.textContent = l.model;
        promptLabel.textContent = l.prompt;
        send.textContent = l.send;
        stop.textContent = l.stop;
        send.disabled = state.busy || !!state.problem || !state.connected || !state.models.length;
        stop.disabled = !state.busy;
        models.disabled = state.busy || !!state.session;
        mode.disabled = state.busy || !!state.session;
        renderEffort();
        receipts.textContent = state.cost
            ? `${l.cost}: ${state.cost.requests} ${l.requests}\n${state.cost.charged} ${l.credits} ${l.charged} · ${state.cost.held} ${l.held} · ${state.cost.unknown.length} ${l.unknown}`
            : "";
        toolResults.replaceChildren(
            ...(state.toolResults || []).map((result) => {
                const box = el("details");
                const code = result.output?.exitCode;
                const outcome = typeof code === "number" && code !== 0 ? l.error : result.state;
                box.append(
                    el("summary", `${result.tool} · ${outcome}${code !== undefined ? ` · exit ${code}` : ""}`),
                    el("pre", JSON.stringify(result.output, null, 2)),
                );
                return box;
            }),
        );
        if (state.receipts?.length) receipts.textContent += "\n" + JSON.stringify(state.receipts, null, 2);
        limits.textContent = l.limits + (state.persist ? `\n${state.storage}` : `\n${l.noPersist}`);
    });
    post({ type: "ready" });
})();
