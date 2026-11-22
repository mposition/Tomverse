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
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const mark = document.createElementNS(icon.namespaceURI, "path");
    mark.setAttribute("d", "M3 4h18v4h-7v12h-4V8H3z");
    mark.setAttribute("fill", "currentColor");
    icon.append(mark);
    const connectionBadge = el("span", "", "connection-badge");
    const header = el("header", "", "sidebar-header");
    header.append(icon, heading, connectionBadge);
    const connectCard = el("section", "", "connection-card");
    const connectTitle = el("h2");
    const connectHint = el("p", "", "muted");
    connectCard.append(connectTitle, connectHint);
    connectCard.hidden = true;
    const onboarding = el("p", "", "muted");
    const toolbar = el("div", "", "toolbar");
    const contextToolbar = el("div", "", "toolbar context-toolbar");
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
    modelLabel.className = "visually-hidden";
    const mode = el("select");
    mode.id = "mode";
    mode.hidden = true;
    const modes = el("div", "", "modes");
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "Ask / Agent");
    const modeButtons = ["ask", "agent"].map((value) => ({
        value,
        node: button(value === "ask" ? "Ask" : "Agent", () => {
            mode.value = value;
            renderModes();
        }),
    }));
    const renderModes = () => {
        for (const { node, value } of modeButtons) {
            node.setAttribute("aria-pressed", String(mode.value === value));
            node.disabled = mode.disabled;
        }
    };
    modes.append(...modeButtons.map(({ node }) => node));
    const effort = button("", () => {
        if (!state) return;
        const picker = state.effortPicker;
        if (picker && !effortPanel.hidden) post({ type: "selectEffort", id: picker.id });
        else post({ type: "chooseEffort", model: models.value });
    });
    effort.id = "effort";
    effort.setAttribute("aria-controls", "effort-choices");
    const effortPanel = el("section", "", "effort-panel");
    effortPanel.id = "effort-choices";
    effortPanel.hidden = true;
    effortPanel.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !state?.effortPicker) return;
        event.preventDefault();
        post({ type: "selectEffort", id: state.effortPicker.id });
    });
    const renderEffort = () => {
        if (!state) return;
        const labels = state.labels;
        const level = state.effort?.model === models.value ? state.effort.level : "default";
        effort.textContent = `${labels.effort} · ${labels[`effort_${level}`]}`;
        effort.disabled = state.busy || !!state.problem || !state.connected || !models.value || state.effort?.locked;
        effort.title = state.effort?.locked ? labels.effortLocked : labels.effortDefault;
        const picker = !effort.disabled && state.effortPicker?.modelId === models.value ? state.effortPicker : undefined;
        const returnFocus = effortPanel.contains(document.activeElement);
        effort.setAttribute("aria-expanded", String(Boolean(picker)));
        effortPanel.hidden = !picker;
        if (!picker) {
            effortPanel.replaceChildren();
            delete effortPanel.dataset.picker;
            if (returnFocus && !effort.disabled) effort.focus();
            return;
        }
        if (effortPanel.dataset.picker === picker.id) return;
        effortPanel.dataset.picker = picker.id;
        const title = el("h2", labels.effort);
        title.id = "effort-title";
        effortPanel.setAttribute("aria-labelledby", title.id);
        const choices = picker.levels.map((choice) => {
            const option = button("", () => post({ type: "selectEffort", id: picker.id, level: choice }));
            option.setAttribute("aria-pressed", String(level === choice));
            const detail = choice === "default" ? labels.effortDefault : choice === "low" ? labels.effortLow : labels.effortHigh;
            option.append(el("strong", labels[`effort_${choice}`]), el("span", detail, "muted"));
            return option;
        });
        effortPanel.replaceChildren(title, ...choices, el("p", picker.levels.length === 1 ? labels.effortUnavailable : labels.effortLocked, "muted"));
        (choices.find((_, index) => picker.levels[index] === level) ?? choices[0])?.focus();
    };
    models.addEventListener("change", () => {
        if (state?.effortPicker) post({ type: "selectEffort", id: state.effortPicker.id });
        renderEffort();
    });
    const modelPanel = el("div", "", "model-panel");
    modelPanel.append(modelLabel, models, effort);
    const controls = el("section", "", "controls");
    controls.append(modes, mode, modelPanel);
    controls.hidden = true;
    const promptLabel = el("label");
    const prompt = el("textarea");
    prompt.id = "prompt";
    prompt.rows = 4;
    promptLabel.htmlFor = prompt.id;
    promptLabel.className = "visually-hidden";
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
    const attachments = el("section", "", "attachments");
    const approval = el("section");
    const changes = el("section");
    const permissions = el("p", "", "muted");
    const receipts = el("pre");
    receipts.id = "receipts";
    const receiptDetails = el("details", "", "receipt-details");
    const receiptTitle = el("summary");
    const receiptLog = el("pre");
    receiptDetails.append(receiptTitle, receiptLog);
    const toolResults = el("section");
    const limits = el("p", "", "muted");
    const composerActions = el("div", "", "composer-actions");
    composerActions.append(contextToolbar, stop, send);
    const composer = el("section", "", "composer");
    composer.append(attachments, promptLabel, prompt, composerActions);
    composer.hidden = true;
    const statusRow = el("div", "", "status-row");
    statusRow.append(status, root);
    app.append(
        header,
        toolbar,
        statusRow,
        connectCard,
        notice,
        controls,
        effortPanel,
        history,
        approval,
        permissions,
        changes,
        composer,
        receipts,
        receiptDetails,
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
        if (action === "connect") connectCard.append(node);
        else if (["file", "selection", "diagnostics"].includes(action)) contextToolbar.append(node);
        else if (["root", "new"].includes(action)) toolbar.append(node);
        else advancedToolbar.append(node);
        return { key, action, node };
    });
    advanced.append(onboarding);
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
        connectionBadge.textContent = l.connected;
        connectionBadge.hidden = !state.connected;
        connectCard.hidden = state.connected;
        connectTitle.textContent = l.connectTitle;
        connectHint.textContent = l.connectHint;
        controls.hidden = !state.connected;
        composer.hidden = !state.connected;
        onboarding.textContent = l.onboarding;
        advancedTitle.textContent = `${l.sessions} · ${l.keys}`;
        for (const item of buttons) {
            item.node.textContent = l[item.key];
            item.node.hidden = item.action === "connect" && state.connected;
            item.node.disabled = state.busy && !["logs", "keys", "clear"].includes(item.action);
        }
        attachments.replaceChildren();
        attachments.setAttribute("aria-label", l.context);
        for (const attachment of state.attachments || []) {
            const row = el("div", "", "attachment-tag");
            const name = attachment.path.split(/[\\/]/).at(-1) || attachment.path;
            const range = attachment.range ? ` · ${attachment.range[0]}–${attachment.range[2]}` : "";
            row.title = `${attachment.path} · ${attachment.kind} · v${attachment.version} · ${attachment.bytes} B${attachment.dirty ? ` · ${l.unsaved}` : ""}${attachment.truncated ? ` · ${l.truncated}` : ""}${attachment.range ? ` · ${attachment.range.join(":")}` : ""}`;
            row.append(
                el("span", `${name}${range}${attachment.dirty ? ` · ${l.unsaved}` : ""}`),
                button(l.remove, () => post({ type: "removeContext", id: attachment.id })),
            );
            attachments.append(row);
        }
        approval.replaceChildren();
        if (state.approval) {
            const p = state.approval;
            approval.className = "approval";
            approval.setAttribute("aria-label", l.awaiting);
            approval.append(el("h2", l.awaiting, "approval-status"), el("strong", p.tool), el("p", p.explanation));
            if (p.command) approval.append(el("pre", JSON.stringify(p.command, null, 2)), el("p", l.onboarding));
            p.files.forEach((file, index) => {
                const row = el("div", "", "approval-file");
                const reviewActions = el("div", "", "toolbar");
                reviewActions.append(
                    button(l.diff, () => post({ type: "diff", id: p.id, index, details: false })),
                    button(l.details, () => post({ type: "diff", id: p.id, index, details: true })),
                );
                row.append(
                    el("strong", file.path),
                    el("pre", `${file.action} · ${file.eol} · BOM:${file.bom} · ${file.beforeBytes} → ${file.afterBytes} B`),
                    reviewActions,
                );
                approval.append(row);
            });
            const allow = button(l.once, () => post({ type: "approve", id: p.id, decision: "once" }));
            allow.className = "primary";
            approval.append(allow);
            const otherDecisions = el("div", "", "other-decisions");
            if (p.canRemember) otherDecisions.append(button(l.run, () => post({ type: "approve", id: p.id, decision: "run" })));
            otherDecisions.append(button(l.deny, () => post({ type: "approve", id: p.id, decision: "deny" })));
            approval.append(otherDecisions);
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
                const node = el("article", "", entry.role === "user" ? "message user" : "message");
                const author = entry.role === "user" ? l.you : entry.role === "assistant" ? "Tomverse" : entry.role;
                node.append(el("strong", author + (entry.truncated ? ` · ${l.truncated}` : "")), el("pre", entry.text));
                return node;
            }),
        );
        if (nearBottom) history.scrollTop = history.scrollHeight;
        // The coding catalog advertises a ceiling for Smart Adaptive. Its actual
        // cost is settled for the model that answers the request.
        const adaptiveFloor = Math.min(...state.models
            .filter((model) => model.id !== "smart-adaptive" && model.creditsPerRequest > 0)
            .map((model) => model.creditsPerRequest));
        models.replaceChildren(
            ...state.models.map((model) => {
                const selectedEffort =
                    state.effort?.model === model.id && state.effort.level !== "default" ? ` · ${l.effort}: ${l[`effort_${state.effort.level}`]}` : "";
                const maximum = model.creditsPerRequest;
                let credits = String(maximum);
                if (model.id === "smart-adaptive") {
                    credits = adaptiveFloor < maximum ? `${adaptiveFloor}–${maximum}` : `≤${maximum}`;
                }
                const option = el("option", `${model.name}${selectedEffort} · ${credits} ${l.credits}`);
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
        prompt.placeholder = l.prompt;
        send.textContent = l.send;
        stop.textContent = l.stop;
        send.disabled = state.busy || !!state.problem || !state.connected || !state.models.length;
        stop.disabled = !state.busy;
        models.disabled = state.busy || !!state.session;
        mode.disabled = state.busy || !!state.session;
        renderModes();
        renderEffort();
        receipts.textContent = state.cost
            ? `${state.cost.charged} ${l.credits} ${l.charged} · ${state.cost.requests} ${l.requests} · ${state.cost.held} ${l.held} · ${state.cost.unknown.length} ${l.unknown}`
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
        receiptTitle.textContent = l.cost;
        receiptDetails.hidden = !state.receipts?.length;
        receiptLog.textContent = state.receipts?.length ? JSON.stringify(state.receipts, null, 2) : "";
        limits.textContent = l.limits + (state.persist ? `\n${state.storage}` : `\n${l.noPersist}`);
    });
    post({ type: "ready" });
})();
