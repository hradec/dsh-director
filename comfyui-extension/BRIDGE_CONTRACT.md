# DSH ↔ ComfyUI Director Studio bridge — v1 contract

Two halves, built in two sessions. Implement EXACTLY this contract; changes require editing this file first (append a changelog line).

- **DSH half** (session "Install dsh-director Plugin"): dsh-director package (sidebar tab, CORS, upload relay).
- **ComfyUI half** (session in `/NVME/Videos/ai-production`): custom node pack `dsh-studio-link` under `comfyui-custom-plugins/dsh-studio-link/`, rsync-installed to the ComfyUI hosts (.242 / .243 / .100) like `comfyui-cache-immutable`.

## Topology and the binding constraint

```
DSH GUI page (127.0.0.1:3081)
 ├─ new "ComfyUI" sidebar tab: <iframe src=http://240.x:8188>   (verified embeddable: no X-Frame-Options, no CSP either side)
 ├─ same-origin fetches of /director-studio/api/*  (already exists today)
 └─ postMessage ⇄ iframe (works cross-origin)

ComfyUI (240.0.0.242 / .243 / 240.1.0.100)
 ├─ frontend extension (dsh-studio-link/web/)  — bridge + node combo population + uploads
 └─ python nodes (nodes.py) — read staged files from the input dir ONLY
```

**Constraint (verified 2026-11-18):** `dsh` listens on `127.0.0.1:3081` only. The ComfyUI *server process* (GCP box) can never fetch DSH URLs. The *browser* is on the workstation, so it CAN reach 127.0.0.1:3081.
Therefore bytes move in two lanes only:

1. **Images (browser relay):** extension JS fetches `http://127.0.0.1:3081/director-studio/api/file?path=…&session=…` → POSTs multipart to ComfyUI `/upload/image` (same-origin as the ComfyUI page). Requires the CORS change below.
2. **Footage / big files (server relay):** DSH server route below POSTs multipart to the ComfyUI host's `/upload/image`; the browser only moves the returned filename.

No re-binding of DSH to ZeroTier (would expose the whole harness API to the net; not doing it without an explicit human decision).

## Staging convention (shared)

Every file bridged from DSH lands in ComfyUI's input dir under subfolder **`dsh/`**, filename = `<library-name>` verbatim (deduped by name; overwrite allowed). A per-asset sidecar JSON is uploaded with it:

`dsh/asset_<slug>.json`
```json
{ "slug": "nelare-voss", "contract": 1, "updated_at": "ISO",
  "images": [{"key":"bust_threeview","file":"nelare-bust.png","tags":["approved","frontal"],"note":"arms are wings; never draw separate arms"}],
  "videos": [{"key":"master","file":"C1-4k-dsh-upscalerv1-0002.mp4","tags":["c1"]}],
  "audio":  [{"key":"voice_ref","file":"nelare-voice.wav","tags":[]}],
  "description": "…asset in-story description…",
  "notes": "…model-facing notes…" }
```

## postMessage contract (iframe mode)

Namespace field `ns: "dsh-studio"`, version `v: 1`. Parent→iframe targetOrigin = the iframe's configured ComfyUI origin (exact). iframe→parent may use `"*"`.

iframe→parent:
- `{ns,v,type:"bridge-hello"}` on extension load (parent replies `bridge-ready` with `{hosts:[…]}`).
- `{ns,v,type:"library-request", kind:"images"|"footage"|"assets"}` — parent answers with the JSON from `/api/library` / assets API.
- `{ns,v,type:"stage-asset", slug}` — parent ensures all media of that asset is present in the Comfy input dir (small images via browser relay, footage via the server route), then sends `{type:"staged", slug, payload:<the sidecar JSON above>}`.
- `{ns,v,type:"pick-request", reqId, kind}` — user clicked "Pick from Director Studio" on a node; parent opens the picker dialog and answers `{type:"pick-result", reqId, file:<comfy input name under dsh/>|null}`.

parent→iframe also: `{type:"set-node", nodeId, file}` if the parent picker initiated the flow.

## Standalone mode (no iframe)

If `window.parent === window` the extension runs in direct mode: fetches the DSH API itself from `http://127.0.0.1:3081` (CORS below). DSH origin + session token are pack settings (`dsh-studio-link` settings block in ComfyUI settings; session value copied from the DSH GUI URL bar by the user).

## dsh-director changes (other session's files)

1. **CORS** on GET `/director-studio/api/library*`, `/director-studio/api/file`, `/director-studio/api/footage/thumb`: `Access-Control-Allow-Origin: *` (+ OPTIONS preflight 204). Auth model unchanged (`?session=`).
2. **New sidebar tab "ComfyUI"** in the director client: iframe + host selector (.242/.243/.100, from existing ComfyUI origin settings) + the parent-side postMessage glue + Director Studio picker dialog reusing the Images/Footage gallery components.
3. **`POST /director-studio/api/comfy-upload`** body `{path, comfy_origin}`: reads the workspace/home/tmp file, POSTs multipart to `<comfy_origin>/upload/image` (type=input, subfolder=`dsh`), returns ComfyUI's `{name, subfolder, type}` verbatim. No size caps.
4. Version bump + tgz publish + cordis update.

## dsh-studio-link changes (this session's files)

- `__init__.py` — WEB_DIRECTORY export, node registration, config route (pack settings defaults only).
- `web/dsh_link.js` — `app.registerExtension`: bridge (iframe + standalone), "Pick from Director Studio" on LoadImage/LoadVideo menus and node body, combo population, browser-relay uploads (images), sidecar handling.
- `nodes.py` — `DSStudioAsset` (asset combo → the four outputs per semantics below), `DSStudioImage` (single library image → IMAGE), `DSStudioPick` (batch index → single IMAGE). Output semantics = open question tracked in this file's changelog until the human answers.
- `install.sh` / `verify.sh` — rsync to `.242/.243/.100` custom_nodes, pattern copied from `../comfyui-cache-immutable/verify.sh`.

## H3 target node facts (verified live on 240.1.0.100 /object_info, 2026-11-18)

`MiniMaxH3ReferenceToVideo` optional group inputs (COMFY_AUTOGROW_V3 templates):
- `ref_images` → members `ref_image_0..9`, type **IMAGE** (downscale >2048 short edge, never upscale)
- `ref_videos` → members `ref_video_0..3`, type **IMAGE** — video is fed as a FRAME BATCH at 24 fps, NOT a VIDEO type
- `ref_video_audios` → members `ref_video_audio_0..3`, type **AUDIO** (soundtrack of the same-numbered ref video)
- `ref_audios` → members `ref_audio_0..3`, type **AUDIO**
There is also `H3References` (collects the four groups → `H3_REFS`) consumed by `H3ReferenceToVideoRefs.refs`.

Consequently `DSStudioAsset` outputs: `images` IMAGE batch, `video_1..3` IMAGE frame-batches retimed to 24 fps (unused slots return a 0-frame batch), `audio_1..3` AUDIO (unused = None), `notes` STRING. Socket counts fixed at the H3 autogrow max so server RETURN_TYPES never drift from saved graphs; the extension renames socket labels per asset.

## Changelog
- v1 2026-11-18 20:40 PT — initial contract (this file), ai-production session.
- v1.1 2026-11-18 21:05 PT — ai-production session: staging lane clarified — the `/upload/image` POST must originate from the ComfyUI page context (ComfyUI sends no CORS headers, so the DSH parent cannot POST into it). Parent therefore sends `{type:"stage-file", url, name}` (DSH `/api/file` URL carrying `?session=`) and the iframe extension fetches (needs the contract's DSH CORS change) and uploads itself; large footage uses the DSH server relay and only its returned name crosses postMessage. Node output types pinned per the H3 facts section above. Pack built: nodes.py (DSStudioAsset/DSStudioImage/DSStudioPick), web/dsh_link.js (bridge-hello/stage-asset/stage-file/pick-request), install.sh/verify.sh; installed on .100, load at next restart.
- v1.1 2026-11-18 21:10 PT — dsh-director half implemented; names v1 left open, now FIXED (iframe half must match): library-request → parent replies {type:"library-data",kind,payload} (payload = the raw JSON of /api/{kind} for images/footage, or {kinds:[{kind,items[]}]} for assets). stage-asset handshake: parent → {type:"stage-images",slug,items:[{key,file:"dsh/<name>",url,tags,note}]}; iframe uploads each via /upload/image then replies {type:"stage-images-done",slug,failed?:[url…]}; parent then sends the promised {type:"staged",slug,payload}. pick-result file = "<subfolder>/<name>" e.g. "dsh/nelare-bust.png". Audio entries also move via the SERVER relay (browser lane is images only). New parent→iframe msg: {type:"load-workflow",workflow:<UI-format JSON string>} — right-click "Open in ComfyUI" sends it when the sidebar tab is linked; iframe half must call app.loadGraphData(JSON.parse(workflow)). Host selector source = Studio app-settings comfy.urls (GET /api/library/app-settings). Bridge messages are ignored by the parent unless e.origin equals the embedded host origin.
- v1.2 2026-11-18 21:45 PT (dsh-director session) — aligned parent to the SHIPPED dsh_link.js; supersedes v1.1 where noted: image staging handshake is per-file {type:"stage-file",name,url} → iframe replies {type:"stage-done",name} or {type:"stage-error",name,error}; parent sends the promised {type:"staged",slug,payload} once every name is done. pick-result.file is now the BARE filename (the iframe composes INIF+"/"+file; v1.1's "dsh/name" would double-prefix). GET /api/library?kind=assets exists for the extension's standalone mode: {assets:[{slug,description,notes,images:[{key,file,abs,tags,note}],videos:[…],audio:[…]}]}. REQUEST TO IFRAME HALF — please add one case to the message switch in web/dsh_link.js: case "load-workflow": { const g = typeof m.workflow === "string" ? JSON.parse(m.workflow) : m.workflow; app.loadGraphData(g); break; } The parent already sends {type:"load-workflow",workflow:<UI-format graph>} on right-click "Open in ComfyUI" whenever the sidebar tab is linked; without this case the message is silently dropped.
- v1.2-iframe 2026-11-18 21:55 PT (ai-production session) — implemented the requested `load-workflow` case in web/dsh_link.js: JSON.parse-if-string → app.loadGraphData, plus iframe→parent ack `{type:"workflow-loaded"}` / `{type:"workflow-error",error}` so the parent can surface failures instead of silence. Deployed to .100 (extension JS is re-served per page load — browser refresh picks it up, ?v= token rotates; no ComfyUI restart needed). All other v1.2 points already matched the shipped code (per-file stage-file handshake, bare pick-result file, kind=assets shape).
- v1.3 2026-11-18 22:45 PT (dsh-director session) — DEFECT in the iframe half, blocks the whole bridge on EVERY endpoint: toParent() posts with targetOrigin = setting("DSHStudio.comfyOrigin", location.origin) but that setting is registered with defaultValue: "", so the fallback never applies — postMessage(msg, "") throws and bridge-hello is never delivered. The value it needs is the PARENT page origin (the DSH app), not ComfyUI's own origin — the name has the wrong meaning. Requested fix in web/dsh_link.js: rename to DSHStudio.parentOrigin (label "Director Studio origin (iframe handshake)"), defaultValue "http://127.0.0.1:3081" — or simply post hello/stage-done/etc. with targetOrigin "*" (the parent already authenticates e.origin against the endpoint list, and these messages carry no secrets). Interim workaround that works today: set the existing setting to http://127.0.0.1:3081 inside each embedded ComfyUI and reload it.
- v1.3-iframe 2026-11-18 23:00 PT (ai-production session) — parentOrigin fix (applied in-workspace by the dsh-director session: empty default → postMessage "*" fallback, label fixed) redeployed to ALL THREE hosts: .100 via SMB rsync (pack already resident — browser refresh picks it up), and NEW install into the shared NFS checkout via rsync→240.0.0.243:/mnt/nfsshare/comfyui/ComfyUI/custom_nodes/dsh-studio-link; both queues verified empty, then `systemctl restart comfyui` on .242 and .243. Served-module probes on all three: JS contains `load-workflow` AND `parentOrigin`, /object_info/DSStudioAsset 200. Bridge now live on 100/242/243. install.sh gained no NFS change — workstation /mnt/nfsshare mount is absent by choice; ssh-rsync is the working deploy lane for the GCP pair.
- v1.4 2026-11-18 23:07 PT (dsh-director session, user request) — load-workflow gains optional "name": the parent sends the source file's stem; the frame passes it to loadGraphData as the workflow path so ComfyUI's workflow tab is named after the video instead of "Unsaved Workflow". Applied to web/dsh_link.js by the director session (previously authorized), redeployed via install.sh.
- v1.5 2026-11-18 23:22 PT (dsh-director session, user request) — LoadImage/LoadVideo "choose file to upload" (+ "upload image") combo entries now open the Director Studio library dialog (existing pick-request/pick-result lane) instead of the OS file picker; previous value restored so the sentinel never persists. Applied to web/dsh_link.js (standing authorization), redeployed via install.sh to 100. Needs ONE ComfyUI page reload (⟳) to take effect; no ComfyUI server restart.
- v1.6 2026-11-18 23:26 PT — iframe confessions: on setup it posts iframe-nav{kind} from Navigation Timing (reload vs navigate) and beforeunload posts iframe-leaving, so the parent can name WHO reloaded the ComfyUI page. Parent side: dsh-director 0.2.105.
- v1.7 2026-11-18 23:34 PT (user request) — LoadImage/LoadVideo get a "⬇ Pick from Director Studio" BUTTON added in onNodeCreated (v1.5 combo hijack removed: the frontend's upload widget opens the OS dialog internally before wrapped callbacks run). Right-click menu entry unchanged.
- v1.8 2026-11-19 00:55 PT — iframe forwards window.onerror + unhandledrejection as iframe-error{msg,at} to the parent note line (embed-only preview bug demanded inside visibility).
- v1.9 2026-11-19 00:03 PT — parent sends keepalive every 20s while a linked host is visible; iframe responds app.graph.setDirtyCanvas(true,true) (full node repaint). Motivated by: all LoadImage/LoadVideo previews vanished at once in the embedded frame (values intact, no JS errors) while the same page in a normal tab kept previews — Chrome froze painting of the off-screen parked frame documents.
- v1.10 2026-11-19 01:20 PT — parent 'diag' message → iframe audits up to 8 LoadImage/LoadVideo nodes (value + live /view status inside the frame) and replies diag-result{lines}.
- v1.11 2026-11-19 01:30 PT — parent→iframe 'upload-pick{reqId,name,data:ArrayBuffer}' : frame POSTs /upload/image to ITS OWN origin (input root, overwrite=true) and sets the requesting node's image/file combo to the returned name; replies pick-done{reqId,name}/pick-error{reqId,why}. Replaces dsh/-subfolder staging for node picks (red-outline + dropdown absence fixed at the source; cross-origin parent upload is CORS-blocked — no ACAO on /upload/image).
- v1.12 2026-11-19 02:12 PT — LoadImage (rewritten: original one-line disable had an operator-precedence slip, now an explicit if(false) block with the restore snippet in comment)/LoadVideo node wiring (on-node button, right-click 'Pick from Director Studio') DISABLED per user request; upload-pick/pick lanes remain for the DSStudioAsset node and future re-enable.
- v1.13 2026-11-19 02:55 PT — parent 'diag-dom' → iframe reports every /view <img>/<video> element: name, load state (complete/naturalWidth or video readyState), element rect and in-viewport — the frontend's own preview DOM exposed through the bridge.
- v1.14 2026-11-19 03:05 PT — diag additionally reports each Load node's canvas Image objects (complete/naturalWidth) plus img-ish property names and node size: previews are canvas-painted, DOM scan proved no <img> elements exist.
- v1.15 2026-11-19 03:15 PT — audit lines version-tagged: a line WITHOUT 'v1.15'/'dom:' means the running frame is STALE (explains the user's last paste: old v1.12 frame answered, v1.14 node audit never executed).
