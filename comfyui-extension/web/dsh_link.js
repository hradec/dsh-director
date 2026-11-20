// dsh-studio-link bridge: Director Studio (DSH) <-> this ComfyUI tab.
// Two modes: iframe inside the DSH sidebar (postMessage with the parent page)
// and standalone (this tab talks to the DSH HTTP API directly; needs the CORS
// change listed in BRIDGE_CONTRACT.md). Contract ns "dsh-studio", v 1.

const { app } = window.comfyAPI.app;

const NS = "dsh-studio";
const V = 1;
const INIF = "dsh"; // input subfolder everything is staged into

const isInIframe = window.parent !== window;
const pendingPicks = new Map(); // reqId -> node
let reqSeq = 0;

function setting(id, fallback) {
    return app.ui.settings.getSettingValue(id, fallback);
}
function dshOrigin() { return setting("DSHStudio.dshOrigin", "http://127.0.0.1:3081").replace(/\/+$/, ""); }
function dshSession() { return setting("DSHStudio.session", ""); }

// ---- parent messaging (iframe mode) -------------------------------------
function toParent(msg) {
    if (!isInIframe) return;
    // The setting names the DIRECTOR STUDIO (parent page) origin, not ComfyUI's own; registered
    // default was "" which made postMessage throw and killed the handshake (BRIDGE_CONTRACT v1.3).
    // Empty/"*" = post anywhere: the DSH parent authenticates sender origins against its endpoint list.
    const origin = setting("DSHStudio.parentOrigin", "") || "*";
    window.parent.postMessage({ ...msg, ns: NS, v: V }, origin);
}

window.addEventListener("message", async (ev) => {
    const m = ev.data;
    if (!m || m.ns !== NS || m.v !== V) return;
    switch (m.type) {
        case "bridge-ready":
            await refreshNodeOptions();
            break;
        case "pick-result": {
            const node = pendingPicks.get(m.reqId);
            pendingPicks.delete(m.reqId);
            if (!node || !m.file) break;
            const w = node.widgets.find((x) => x.type === "combo");
            if (w) { w.value = INIF + "/" + m.file; node.setDirtyCanvas(true, true); }
            break;
        }
        case "upload-pick": { // v1.11: parent ships the library bytes; we upload them to OUR origin's input root
            // (same machine as the node — no dsh/ subfolder oddities, no cross-origin CORS wall from the parent page)
            try {
                const fd = new FormData();
                fd.append("image", new Blob([m.data]), m.name);
                fd.append("overwrite", "true");
                const r = await fetch("/upload/image", { method: "POST", body: fd });
                if (!r.ok) { toParent({ type: "pick-error", reqId: m.reqId, why: "upload/image " + r.status }); break; }
                const j = await r.json();
                const node = pendingPicks.get(m.reqId);
                pendingPicks.delete(m.reqId);
                if (node) {
                    const w = (node.widgets || []).find((x) => x.type === "combo" && (x.name === "image" || x.name === "file"));
                    if (w) { w.value = j.name; node.setDirtyCanvas(true, true); }
                }
                toParent({ type: "pick-done", reqId: m.reqId, name: j.name, subfolder: j.subfolder || "" });
            } catch (e) { toParent({ type: "pick-error", reqId: m.reqId, why: String(e.message || e) }); }
            break;
        }
        case "diag-perf": { // v1.17: the browser's own ledger — every /view URL this frame FETCHED, with transfer size + duration
            const L = performance.getEntriesByType("resource").filter((e) => e.name.includes("/view")).slice(-14)
                .map((e) => decodeURIComponent(e.name.replace(location.origin, "")) + " [" + e.transferSize + "B/" + Math.round(e.duration) + "ms" + (e.responseHeaders ? "" : " norec") + "]");
            toParent({ type: "diag-result", lines: L.length ? L : ["perf: zero /view fetches recorded"] });
            auditDump("perf", L);
            break;
        }
        case "diag-dom": { // v1.13: inspect the ACTUAL preview elements the frontend rendered inside this document
            const lines = [];
            for (const el of document.querySelectorAll("img, video")) {
                const src = el.currentSrc || el.src || "";
                if (!src.includes("/view")) continue;
                const name = decodeURIComponent((src.match(/[?&]filename=([^&]*)/) || [])[1] || "?");
                const state = el.tagName === "VIDEO"
                    ? (el.readyState ? "ready" + el.readyState : "NOT-LOADED " + (el.error ? "err" + el.error.code : "loading=" + el.getAttribute("loading")))
                    : (el.complete && el.naturalWidth ? "ok " + el.naturalWidth + "x" + el.naturalHeight : "INCOMPLETE " + (el.currentSrc ? "started" : "no-src") + " loading=" + el.getAttribute("loading"));
                const r = el.getBoundingClientRect();
                lines.push(name + " [" + state + " rect " + Math.round(r.width) + "x" + Math.round(r.height) + " inVP " + (r.top >= 0 && r.top < innerHeight) + "]");
                if (lines.length >= 10) break;
            }
            const L = lines.length ? lines : ["dom: no /view media elements"];
            toParent({ type: "diag-result", lines: L });
            auditDump("dom", L);   // v1.16: land the audit on server disk for the agent
            break;
        }
        case "request-reload": // v1.29: parent asks; WE reload in-document so beforeunload/ComfyUI's unsaved-workflow confirmation is honored (a parent src-swap bypasses it)
            window.location.reload();
            return;
        case "request-reload": // v1.29: parent asks; WE reload in-document so beforeunload/ComfyUI's unsaved-workflow confirmation is honored (a parent src-swap bypasses it)
            window.location.reload();
            return;
        case "log-event": // v1.29: parent relays frame-box incidents (removals, mystery reloads) → readable on disk at user/<uid>/dsh-audit-framelog.txt
            auditDump("framelog", [String((m && m.detail) || "")]);
            return;
        case "request-reload": // v1.30: parent asks; WE reload in-document so ComfyUI's unsaved-workflow confirmation gets its veto (parent src-swap bypassed it)
            window.location.reload();
            return;
        case "log-event": // v1.30: parent relays frame-box incidents to disk: user/<uid>/dsh-audit-framelog.txt
            auditDump("framelog", [String((m && m.detail) || "")]);
            return;
        case "ping": // v1.28: parent remounted (DSH tab switched) — re-hello so linked/version badges heal without a page reload
            toParent({ type: "bridge-hello", ver: VER });   // v1.30: version travels IN the hello — badge can never show green without a version
            return;
        case "ver": // v1.25: parent version handshake
            toParent({ type: "ver-result", ver: VER });
            return;
        case "diag": { // v1.10: self-audit every LoadImage/LoadVideo — value + what /view ACTUALLY answers inside this frame
            // v1.18: IDENTITY — this server runs --multi-user: /view and dropdowns resolve against the
            // LOGGED-IN user's input folder; anonymous sees the (mostly empty) default. 403 = anonymous embed.
            let idn = "unknown";
            const who = await resolveUser();
            try { const r = await fetch("/userdata/list"); idn = r.status === 403 ? "ANONYMOUS (default folders)" : r.status === 200 ? "logged-in" : "HTTP " + r.status; } catch (e) { idn = "ERR " + e.message; }
            idn += " | comfy-user: " + (who || "(not set)");
            const lines = ["v1.18 IDENTITY: " + idn];
            for (const n of app.graph._nodes) {
                if (n.type !== "LoadImage" && n.type !== "LoadVideo") continue;
                const v = n.widgets && n.widgets[0] && n.widgets[0].value;
                const sub = v && v.includes("/") ? "&subfolder=" + encodeURIComponent(v.split("/").slice(0, -1).join("/")) + "&filename=" + encodeURIComponent(v.split("/").pop()) : "&filename=" + encodeURIComponent(v || "");
                let st = "n/a";
                try { const r = await fetch("/view?" + sub + "&type=input"); st = r.status + " " + (r.headers.get("content-type") || ""); } catch (e) { st = "ERR " + e.message; }
                // v1.14: previews are CANVAS-drawn from Image objects on the node — inspect those, not the DOM
                let im = "no-imgs";
                const imgs = n.imgs || n.image || null;
                if (imgs) {
                    const arr = Array.isArray(imgs) ? imgs : [imgs];
                    const real = arr.filter((x) => x && (x.complete !== undefined));
                    im = real.length
                        ? real.map((x) => (x.complete && x.naturalWidth ? "LOADED " + x.naturalWidth + "x" + x.naturalHeight : "WAIT/FAIL nw=" + x.naturalWidth + " comp=" + x.complete)).join(",")
                        : "keys:" + Object.keys(n).filter((k) => /img|image|thumb|preview/i.test(k)).join("/");
                } else {
                    im = "keys:" + Object.keys(n).filter((k) => /img|image|thumb|preview|media/i.test(k)).join("/") + "|widgets:" + (n.widgets || []).map((w) => w.type + ":" + w.name).join(",");
                }
                const rect = (n.size || []).map(Math.round).join("x");
                lines.push("v1.15 IMG/VID " + v + " -> " + st + " || " + im + " size=" + rect);
                if (lines.length >= 8) break;
            }
            toParent({ type: "diag-result", lines });
            auditDump("node", lines);   // v1.16
            break;
        }
        case "keepalive": // v1.9: parent heartbeat — force a full node repaint so Chrome's freeze of
            // off-screen iframes can't leave the visible canvas without image previews
            try { app.graph.setDirtyCanvas(true, true); } catch {}
            break;
        case "load-workflow": // v1.2: parent right-click "Open in ComfyUI" (UI-format graph); v1.4 optional m.name names the workflow tab after the source video
            try {
                const g = typeof m.workflow === "string" ? JSON.parse(m.workflow) : m.workflow;
                app.loadGraphData(g, true, false, m.name || undefined);
                toParent({ type: "workflow-loaded" });
            } catch (e) {
                toParent({ type: "workflow-error", error: String(e) });
            }
            break;
        case "staged":
            await refreshNodeOptions();
            renameAssetOutputs(m.slug, m.payload);
            break;
        case "stage-file": // parent hands a DSH file URL; the upload POST must come from OUR origin
            try {
                const blob = await (await fetch(m.url)).blob();
                await uploadStaged(m.name, blob);
                toParent({ type: "stage-done", name: m.name });
            } catch (e) {
                toParent({ type: "stage-error", name: m.name, error: String(e) });
            }
            break;
    }
});

// ---- ComfyUI-side upload + node-def refresh ------------------------------
async function uploadStaged(name, blob) {
    const fd = new FormData();
    fd.append("image", blob, name);
    fd.append("type", "input");
    fd.append("subfolder", INIF);
    fd.append("overwrite", "true");
    const r = await fetch("/upload/image", { method: "POST", body: fd });
    if (!r.ok) throw new Error("upload/image " + r.status);
    return r.json();
}

async function refreshNodeOptions() {
    // INPUT_TYPES rescans input/dsh/ per object_info request, so refetching the
    // defs is enough to teach existing nodes about newly staged assets/files.
    for (const cls of ["DSStudioAsset", "DSStudioImage"]) {
        const r = await fetch("/object_info/" + cls);
        if (!r.ok) continue;
        const def = (await r.json())[cls];
        const opts = def?.input?.required?.asset?.[0] || def?.input?.required?.file?.[0];
        if (!opts) continue;
        for (const node of app.graph._nodes) {
            if (node.type !== cls) continue;
            for (const w of node.widgets || []) {
                if (w.name === "asset" || w.name === "file") {
                    w.options.values = opts;
                    if (!opts.includes(w.value)) { w.value = opts[0]; node.setDirtyCanvas(true, true); }
                }
            }
        }
    }
}

function renameAssetOutputs(slug, payload) {
    // Cosmetic: label the fixed video_/audio_ sockets with this asset's keys.
    if (!payload) return;
    for (const node of app.graph._nodes) {
        if (node.type !== "DSStudioAsset") continue;
        const w = node.widgets.find((x) => x.name === "asset");
        if (!w || w.value !== slug) continue;
        const vids = payload.videos || [];
        const auds = payload.audio || [];
        for (let i = 0; i < 3; i++) {
            if (node.outputs[1 + i]) node.outputs[1 + i].name = vids[i] ? "video · " + (vids[i].key || vids[i].file) : "video_" + (i + 1) + " (unused)";
            if (node.outputs[4 + i]) node.outputs[4 + i].name = auds[i] ? "audio · " + (auds[i].key || auds[i].file) : "audio_" + (i + 1) + " (unused)";
        }
        node.setDirtyCanvas(true, true);
    }
}

// ---- flows ---------------------------------------------------------------
async function stageAsset(slug) {
    if (isInIframe) {
        toParent({ type: "stage-asset", slug });
        return;
    }
    // standalone: fetch the sidecar + its media from DSH directly (CORS per contract).
    const base = dshOrigin();
    const sess = dshSession();
    const libUrl = `${base}/director-studio/api/library?kind=assets&session=${encodeURIComponent(sess)}`;
    // ponytail: exact assets-list payload shape is pinned by BRIDGE_CONTRACT.md v1;
    // if the dsh-director session renames it, this one call is the edit point.
    const entry = (await (await fetch(libUrl)).json()).assets?.find((a) => a.slug === slug);
    if (!entry) return;
    for (const grp of ["images", "videos", "audio"]) {
        for (const item of entry[grp] || []) {
            const blob = await (await fetch(`${base}/director-studio/api/file?path=${encodeURIComponent(item.abs)}&session=${encodeURIComponent(sess)}`)).blob();
            await uploadStaged(item.file || item.name, blob);
        }
    }
    const sc = { slug, ...entry };
    const fd = new FormData();
    fd.append("image", new Blob([JSON.stringify(sc)], { type: "application/json" }), `asset_${slug}.json`);
    fd.append("type", "input");
    fd.append("subfolder", INIF);
    fd.append("overwrite", "true");
    await fetch("/upload/image", { method: "POST", body: fd });
    await refreshNodeOptions();
    renameAssetOutputs(slug, entry);
}

const VER = "1.37";   // SINGLE version constant — bridge-hello, ver probe and the boot heartbeat all read this; cannot desync anymore

const nativeFetch = window.fetch;   // v1.26 FIX: was declared INSIDE setup() — every module-scope authed fetch (resolveUser, authedUrl, probes) threw a silent ReferenceError; that is the real reason previews never painted even on fresh frames
// ---- v1.31 AGENT DRIVE: ops file -> execute on live graph -> result file. Agent writes user/<uid>/dsh-ops.json via authenticated curl; this poller applies it here.
let lastOpsId = null;
function nodes2dst(lid) {   // node-owned scanning: which node's outputs claim this link id
    for (const m of app.graph._nodes) for (const o2 of m.outputs || []) if ((o2.links || []).includes(lid)) return m.id;
    return null;
}
function nodes2src(n) { return null; }   // resolved below per input link
function linkEnds(L) {   // v1.33: litegraph arrays [id,from,fs,to,ts,type] vs new-frontend objects — accept both, layout is only correct with this
    if (!L) return null;
    if (Array.isArray(L)) return { from: L[1], to: L[3] };
    if (L.origin_id !== undefined && L.target_id !== undefined) return { from: L.origin_id, to: L.target_id };
    return null;
}
function applyOps(ops) {
    const LG = window.LiteGraph;
    const created = [], errors = [];
    for (const o of ops) {
        try {
            if (o.t === "create") {
                const n = LG.createNode(o.type);
                if (!n) { errors.push("unknown node type " + o.type); continue; }
                n.pos = [o.x ?? 100, o.y ?? 100];
                if (o.title) n.title = o.title;
                app.graph.add(n);
                created.push(n.id);
                for (const [k, v] of Object.entries(o.widgets || {})) {
                    const w = (n.widgets || []).find((x) => x.name === k);
                    if (w) { w.value = v; w.callback && w.callback(n, k, v, null, null); }
                    else errors.push("no widget " + k + " on " + o.type);
                }
            } else if (o.t === "connect") {
                if (!app.graph.connect(o.from[0], o.from[1], o.to[0], o.to[1])) errors.push("connect failed " + JSON.stringify(o));
            } else if (o.t === "move") {
                const n = app.graph.getNodeById(o.id);
                if (n) n.pos = [o.x, o.y]; else errors.push("no node " + o.id);
            } else if (o.t === "widget") {
                const n = app.graph.getNodeById(o.id);
                const w = n?.widgets?.find((x) => x.name === o.name);
                if (w) { w.value = o.value; w.callback && w.callback(n, o.name, o.value, null, null); }
                else errors.push("widget " + o.name + " missing on " + o.id);
            } else if (o.t === "delete") {
                const n = app.graph.getNodeById(o.id);
                if (n) app.graph.remove(n); else errors.push("no node " + o.id);
            } else if (o.t === "layout") {
                if (o.undo) {   // v1.35: restore positions captured by the previous layout run
                    for (const m of (o.undo || [])) { const n = app.graph.getNodeById(m.id); if (n) n.pos = [m.x, m.y]; }
                    app.graph.setDirtyCanvas(true, true);
                    return { restored: (o.undo || []).length };
                }
                // v1.32: flow-organized layout — longest-path ranking into columns, nodes stacked by data-flow, measured sizes respected.
                const g = app.graph;
                const nodes = g._nodes.filter((n) => !n.flags || !n.flags.pinned || true);
                const idset = new Set(nodes.map((n) => n.id));
                const ins = new Map(nodes.map((n) => [n.id, []]));
                // v1.36: trust NODE-owned link ids, not any graph link table (shape varies by frontend build).
                // For every input link id, find which node's output claims the same id. O(n·k), fine for real canvases.
                for (const n of nodes) {
                    for (const i of n.inputs || []) {
                        if (i.link == null) continue;
                        for (const m of nodes) {
                            if (m === n) continue;
                            if ((m.outputs || []).some((o2) => (o2.links || []).includes(i.link))) { ins.get(n.id).push(m.id); break; }
                        }
                    }
                }
                const edgeCount = [...ins.values()].reduce((a, b) => a + b.length, 0);
                const rank = new Map(nodes.map((n) => [n.id, 0]));
                for (let pass = 0; pass < 64; pass++) {
                    let ch = false;
                    for (const n of nodes) {
                        let r = 0;
                        for (const p of ins.get(n.id)) r = Math.max(r, (rank.get(p) ?? 0) + 1);
                        if (r !== rank.get(n.id)) { rank.set(n.id, r); ch = true; }
                    }
                    if (!ch) break;
                }
                const cols = new Map();
                for (const n of nodes) { const r = rank.get(n.id); (cols.get(r) || cols.set(r, []).get(r)).push(n); }
                const colKeys = [...cols.keys()].sort((a, b) => a - b);
                const prev = nodes.map((n) => ({ id: n.id, x: n.pos[0], y: n.pos[1] }));
                let x = 60, moved = [];
                for (const r of colKeys) {
                    const col = cols.get(r);
                    col.sort((a, b) => a.pos[1] - b.pos[1] || a.pos[0] - b.pos[0]);
                    const w = Math.max(...col.map((n) => n.size?.[0] || 220));
                    let y = 60;
                    for (const n of col) { n.pos = [x, y]; y += (n.size?.[1] || 160) + (o.rowGap ?? 46); }
                    x += w + (o.colGap ?? 110);
                    moved.push(...col.map((n) => n.id));
                }
                app.graph.setDirtyCanvas(true, true);
                return { moved: moved.length, edges: edgeCount, ranks: Object.fromEntries(rank), prev };
            } else if (o.t === "fit") { // v1.35: zoom-to-fit whatever is on canvas
                const ns = app.graph._nodes;
                if (ns.length) {
                    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
                    for (const n of ns) { x0 = Math.min(x0, n.pos[0]); y0 = Math.min(y0, n.pos[1]); x1 = Math.max(x1, n.pos[0] + (n.size?.[0] || 220)); y1 = Math.max(y1, n.pos[1] + (n.size?.[1] || 120)); }
                    const cw = app.canvas.canvas.width, chh = app.canvas.canvas.height;
                    const sc = Math.min((cw - 80) / (x1 - x0), (chh - 80) / (y1 - y0), 1);
                    app.canvas.ds.offset = [-x0 * sc + (cw - (x1 - x0) * sc) / 2, -y0 * sc + (chh - (y1 - y0) * sc) / 2];
                    app.canvas.ds.scale = sc;
                    app.graph.setDirtyCanvas(true, true);
                    return { fitted: ns.length, scale: Math.round(sc * 100) / 100 };
                }
            } else if (o.t === "read") {
                app.graph.setDirtyCanvas(true, true);
                return { nodes: app.graph._nodes.map((n) => ({ id: n.id, type: n.type, title: n.title, pos: (n.pos || []).map(Math.round), inputs: (n.inputs || []).map((i) => i.name + (i.link != null ? "<-" + (nodes2dst(i.link) ?? "?") : "")), outputs: (n.outputs || []).map((o2) => o2.name + (o2.links && o2.links.length ? "->" + o2.links.map((lid) => nodes2dst(lid) ?? "?").join(",") : "")), widgets: (n.widgets || []).map((w) => w.name + "=" + String(w.value).slice(0, 80)) })) };
            } else errors.push("unknown op " + o.t);
            app.graph.setDirtyCanvas(true, true);
        } catch (e) { errors.push((o.t || "?") + ": " + e.message); }
    }
    return { created, errors };
}
async function opsTick() {
    try {
        const r = await fetch("/userdata/dsh-ops.json?t=" + Date.now(), { cache: "no-store" });   // v1.37: without this the browser served the CACHED ops file back forever — every command after the first was invisible
        if (r.status !== 200) return;
        const j = await r.json();
        if (!j || j.id === lastOpsId) return;
        lastOpsId = j.id;
        const out = applyOps(j.ops || []);
        await fetch("/userdata/dsh-ops-result.json", { method: "POST", body: JSON.stringify({ id: j.id, at: new Date().toISOString(), ...out }, null, 1), headers: { "Content-Type": "text/plain" } });
    } catch (e) {
        try { await fetch("/userdata/dsh-ops-error.txt", { method: "POST", body: "opsTick " + new Date().toISOString() + " " + (e && e.stack ? e.stack : String(e)), headers: { "Content-Type": "text/plain" } }); } catch {}
    }
}
const blobCache = new Map();   // module scope: shared by the element interceptor and the audit probe
let userPromise = null;
function resolveUser() { // setting holds a username OR a raw user_id; map via /users; blank -> leave requests untouched
    if (!userPromise) userPromise = (async () => {
        let want = setting("DSHStudio.comfyUser", "").trim();
        try {
            const j = await nativeFetch("/users").then((r) => (r.ok ? r.json() : {}));
            const multi = j.storage === "server" && j.users && Object.keys(j.users).length;
            if (!want) {
                // ponytail: blank setting on a multi-user box = first registered user (this fleet is single-owner per box)
                if (multi) want = Object.keys(j.users)[0];
                else return "";
            }
            if (multi && j.users[want]) return want;  // setting held a raw id
            const hit = Object.entries(j.users || {}).find(([, name]) => name === want);
            if (hit) return hit[0];
        } catch (e) { /* fall through */ }
        return want;
    })();
    return userPromise;
}

async function auditDump(kind, lines) { // v1.23: plain-text POST to /userdata (the /upload/image validator rejects non-images — that's why the .png dump silently died). Lands at user/<uid>/dsh-audit-<kind>.txt
    try {
        const who = await resolveUser();
        let extra = "user=" + (who || "(anonymous)");
        // probe like the FRONTEND does: /api/view with and without header on the first LoadImage value
        const n = app.graph._nodes.find((x) => x.type === "LoadImage" || x.type === "LoadVideo");
        const v = n && n.widgets && n.widgets[0] && n.widgets[0].value;
        if (v) {
            const q = "/api/view?type=input&filename=" + encodeURIComponent(v);
            const a = await nativeFetch(q).then((r) => r.status).catch(() => "ERR");
            const b = await nativeFetch(q, { headers: { "comfy-user": who || "none" } }).then((r) => r.status).catch(() => "ERR");
            extra += " | " + v + " /api/view anonymous=" + a + " header=" + b + " | blobcache=" + blobCache.size;
        }
        await fetch("/userdata/dsh-audit-" + kind + ".txt", { method: "POST", body: "dsh-audit " + kind + " v1.23\n" + extra + "\n" + lines.join("\n"), headers: { "Content-Type": "text/plain" } });
    } catch (e) { /* best effort */ }
}

function requestPick(node) {
    const reqId = "req" + (++reqSeq);
    pendingPicks.set(reqId, node);
    toParent({ type: "pick-request", reqId, kind: node.type === "LoadVideo" ? "footage" : "images" });
}

// ---- node wiring ----------------------------------------------------------
app.registerExtension({
    name: "dsh.studio.link",
    settings: [
        { id: "DSHStudio.comfyUser", name: "Comfy user (multi-user header)", type: "string", defaultValue: "", tooltip: "Username for the comfy-user header — this server runs --multi-user (per-user input/output). Blank = don't interfere. e.g. rhadec" },
        { id: "DSHStudio.dshOrigin", name: "DSH base URL (standalone mode)", type: "string", defaultValue: "http://127.0.0.1:3081" },
        { id: "DSHStudio.session", name: "DSH director-studio session token", type: "string", defaultValue: "" },
        { id: "DSHStudio.parentOrigin", name: "Director Studio origin (empty = any)", type: "string", defaultValue: "" },
    ],
    setup() {
        toParent({ type: "bridge-hello" });
        auditDump("version", [`frame v${VER} boot ` + new Date().toISOString()]);
        setInterval(opsTick, 1500);   // agent drive poll — executes user/<uid>/dsh-ops.json   // heartbeat: file absent = STALE pre-1.24 frame running
        // v1.6: confession — WHY did this page just load? Navigation Timing distinguishes a browser
        // reload (F5, our ⟳, crash-reload, memory-saver restore = 'reload') from fresh navigation
        // (parent writing src = 'navigate'). Parent logs it as a note.
        try {
            const n = performance.getEntriesByType("navigation")[0];
            if (n) toParent({ type: "iframe-nav", kind: n.type });
        } catch {}
        window.addEventListener("beforeunload", () => {
            try { toParent({ type: "iframe-leaving" }); } catch {}
        });
        // v1.8: ship the frame's JS errors to the parent's note line — the parent cannot read a
        // cross-origin iframe console, and 'preview broken only when embedded' demanded eyes inside.
        // v1.19: multi-user identity is the plain 'comfy-user: <user_id>' header (verified 404->200).
        // The embedded frame never went through the frontend login -> anonymous -> user files 404.
        // v1.21: multi-user media can NEVER load via <img>/<video> (headers impossible on element
        // requests; query-param identity is not accepted). Route element URLs through authenticated
        // fetch -> blob: URL. Covers litegraph LoadImage/LoadVideo previews and thumbnails wholesale.
        async function authedUrl(u) {
            const who = await resolveUser();
            if (!who) return u;
            if (blobCache.has(u)) return blobCache.get(u);
            try {
                const r = await nativeFetch(u, { headers: { "comfy-user": who } });
                if (!r.ok) return u;
                const b = URL.createObjectURL(await r.blob());
                blobCache.set(u, b);
                return b;
            } catch (e) { return u; }
        }
        function rewriteMediaSrc(proto) {
            const d = Object.getOwnPropertyDescriptor(proto, "src");
            if (!d || !d.set) return;
            Object.defineProperty(proto, "src", {
                configurable: true, enumerable: d.enumerable, get: d.get,
                set(v) {
                    if (typeof v === "string" && v.includes("/view?")) {
                        const el = this;
                        el.__dshSeq = (el.__dshSeq || 0) + 1;
                        const seq = el.__dshSeq;   // last writer wins; blob swap is async
                        authedUrl(v).then((u2) => { if (el.__dshSeq === seq) d.set.call(el, u2); });
                        return;
                    }
                    d.set.call(this, v);
                },
            });
        }
        rewriteMediaSrc(window.HTMLImageElement.prototype);
        rewriteMediaSrc(window.HTMLVideoElement.prototype);
        rewriteMediaSrc(window.HTMLAudioElement.prototype);

        window.fetch = async (input, init) => {
            const u = typeof input === "string" ? input : (input && input.url) || "";
            const path = u.startsWith("http") ? new URL(u).pathname : u;
            const who = await resolveUser();
            if (who && /^\/(view|upload|userdata|prompt|history|object_info|extensions\/)([?/]|$)/.test(path)) {   // v1.20: object_info too — INPUT_TYPES scans the USER's input dir, so the dropdown list is identity-scoped
                init = init || {};
                const h = new Headers(init.headers || (typeof input !== "string" && input.headers) || {});
                if (!h.has("comfy-user")) h.set("comfy-user", who);
                init = { ...init, headers: h };
            }
            return nativeFetch(input, init);
        };

        window.addEventListener("error", (e) => {
            try { toParent({ type: "iframe-error", msg: String(e.message), at: String(e.filename).split("/").pop() + ":" + e.lineno }); } catch {}
        });
        window.addEventListener("unhandledrejection", (e) => {
            try { toParent({ type: "iframe-error", msg: "promise: " + String(e.reason && e.reason.message || e.reason) }); } catch {}
        });
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "DSStudioAsset") {
            const onCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onCreated ? onCreated.apply(this, arguments) : undefined;
                this.addWidget("button", "⬇ Stage from Director Studio", null, () => {
                    const w = this.widgets.find((x) => x.name === "asset");
                    stageAsset(w ? w.value : "");
                });
                return r;
            };
        }
        // v1.12: LoadImage/LoadVideo wiring DISABLED per user request — re-enable by restoring:
        //   if (nodeData.name === "LoadImage" || nodeData.name === "LoadVideo") {
        if (false) {
            // v1.7: an on-node button (the v1.5 combo hijack lost to the frontend's own upload widget
            // interception — it fires the OS dialog before any wrapped callback). Button always works.
            const onCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onCreated ? onCreated.apply(this, arguments) : undefined;
                this.addWidget("button", "\u2B07 Pick from Director Studio", null, () => requestPick(this));
                return r;
            };
            const extra = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function (opts) {
                const r = extra ? extra.apply(this, arguments) : undefined;
                opts.push({ content: "Pick from Director Studio", callback: () => requestPick(this) });
                return r;
            };
        }
    },
});
