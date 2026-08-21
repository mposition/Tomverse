// C2 (seal / resume / expiry) probe -- paste into the DevTools console while
// logged in on https://staging.tomverse.app. Uses the page's own session, so
// no cookie has to be copied anywhere.
//
// Covers the four checklist items that are pure state transitions, plus the
// subset finalize. It creates its own throwaway import so nothing depends on
// what the wizard happens to have left behind, and deletes it at the end
// unless the subset finalize ran.
(async () => {
    const stamp = Date.now();
    const log = [];

    const call = async (method, path, body) => {
        const res = await fetch(path, {
            method,
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        let payload = null;
        try {
            payload = await res.json();
        } catch {}
        return { status: res.status, code: payload?.code ?? null, payload };
    };

    const check = (name, expected, got, extra) => {
        const ok =
            got.status === expected.status &&
            (expected.code === undefined || got.code === expected.code) &&
            (!extra || extra(got.payload));
        log.push({
            item: name,
            expected: `${expected.status}${expected.code ? " " + expected.code : ""}`,
            got: `${got.status}${got.code ? " " + got.code : ""}`,
            result: ok ? "PASS" : "FAIL",
        });
        if (!ok) console.warn(name, got.payload);
        return ok;
    };

    const conversation = (suffix, title) => ({
        rawExternalConversationId: `c2-probe-${stamp}-${suffix}`,
        title,
        messages: [
            {
                rawExternalMessageId: `c2-probe-${stamp}-${suffix}-m0`,
                role: "user",
                ordinal: 0,
                content: `C2 seal probe ${suffix} (${stamp})`,
            },
        ],
    });

    // --- setup ------------------------------------------------------------
    const created = await call("POST", "/api/imports/external", {
        provider: "claude",
        parserVersion: "c2-probe",
    });
    if (created.status !== 201) {
        console.error("could not create an import; nothing else will mean anything", created);
        return;
    }
    const id = created.payload.importId;
    const base = `/api/imports/external/${id}`;
    console.log("import", id, "status", created.payload.status);

    // --- "seal 없이 staging에서 바로 finalize" -------------------------------
    check(
        "finalize before seal -> SELECTION_CHANGED",
        { status: 409, code: "EXTERNAL_IMPORT_SELECTION_CHANGED" },
        await call("POST", `${base}/finalize`, {
            idempotencyKey: `c2-probe-${stamp}-early`,
            selectedConversationIds: ["not-a-real-id"],
        })
    );

    // --- upload one batch ---------------------------------------------------
    const batch = await call("POST", `${base}/batches`, {
        sequence: 0,
        conversations: [conversation("a", "C2 probe A"), conversation("b", "C2 probe B")],
    });
    if (batch.status !== 200) {
        console.error("batch upload failed; stopping", batch);
        return;
    }
    const staged = batch.payload.results
        .filter((row) => row.outcome === "staged")
        .map((row) => row.stagedConversationId);
    console.log("staged", staged);
    if (staged.length !== 2) {
        console.error("expected two staged rows; the probe ids may already exist", batch.payload);
        return;
    }

    const declaration = {
        finalSequence: 0,
        expectedStagedConversationIds: staged,
        expectedDuplicateCount: 0,
    };

    // --- first seal ---------------------------------------------------------
    check(
        "first seal -> preview_ready, not a replay",
        { status: 200 },
        await call("POST", `${base}/seal`, declaration),
        (p) => p.status === "preview_ready" && p.idempotentReplay === false
    );

    // --- "같은 선언으로 seal을 다시 호출하면 200 idempotent replay" ------------
    check(
        "identical seal -> 200 idempotent replay",
        { status: 200 },
        await call("POST", `${base}/seal`, declaration),
        (p) => p.idempotentReplay === true
    );

    // --- "선언을 바꿔 seal을 호출하면 409" -------------------------------------
    check(
        "seal with a different duplicate count -> SELECTION_CHANGED",
        { status: 409, code: "EXTERNAL_IMPORT_SELECTION_CHANGED" },
        await call("POST", `${base}/seal`, {
            ...declaration,
            expectedDuplicateCount: 1,
        })
    );

    // --- "preview_ready import에 batch를 더 보내면 409" -----------------------
    check(
        "batch after seal -> SELECTION_CHANGED",
        { status: 409, code: "EXTERNAL_IMPORT_SELECTION_CHANGED" },
        await call("POST", `${base}/batches`, {
            sequence: 1,
            conversations: [conversation("c", "C2 probe C")],
        })
    );

    // --- the two rejections must not have moved the state -------------------
    check(
        "state after the rejections -> still preview_ready",
        { status: 200 },
        await call("GET", base),
        (p) => p.status === "preview_ready"
    );

    console.table(log);
    console.log(
        `Subset finalize is not run automatically -- it writes a real conversation.\n` +
            `To run it, finalize only the first staged row:\n\n` +
            `await fetch("${base}/finalize", {method:"POST",headers:{"Content-Type":"application/json"},` +
            `body:JSON.stringify({idempotencyKey:"c2-probe-${stamp}-subset",selectedConversationIds:["${staged[0]}"]})}).then(r=>r.json())\n\n` +
            `Expect 200 with finalizedConversations: 1. "C2 probe A" should then appear in the\n` +
            `conversation list and "C2 probe B" should not -- its staged row is deleted.\n\n` +
            `If you skip it, remove the throwaway import with:\n\n` +
            `await fetch("${base}", {method:"DELETE"}).then(r=>r.status)`
    );
})();
