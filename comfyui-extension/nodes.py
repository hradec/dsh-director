"""Director Studio loader nodes for ComfyUI.

Read ONLY the staged library under <ComfyUI input>/dsh/ (see BRIDGE_CONTRACT.md):
the DSH server binds to 127.0.0.1 only, so the ComfyUI process never fetches
anything from DSH — the dsh_link.js extension stages files there first.

Sidecar per asset: dsh/asset_<slug>.json
  {"slug", "description", "notes",
   "images":[{"key","file","tags":[],"note"}], "videos":[...], "audio":[...]}
"""
import glob
import json
import os

import folder_paths
import numpy as np
import torch

DSH_SUBFOLDER = "dsh"
# External requirement of MiniMaxH3ReferenceToVideo: ref_video members are frames
# at 24 fps (tooltip in its object_info on 240.1.0.100/.243), not our choice.
TARGET_FPS = 24.0
# H3 autogrow caps (ref_videos max 3, ref_audios max 3) — fixed socket counts so
# server RETURN_TYPES and the saved graph never drift apart.
MAX_VIDEOS = 3
MAX_AUDIOS = 3


from urllib.parse import quote as _q
from urllib.request import urlopen as _urlopen
from urllib.error import HTTPError as _HTTP_ERR

_DSH_URL_DEFAULT = "http://240.0.0.10:3081"      # ZeroTier IP of the DSH workstation
_DSH_SESSION_DEFAULT = "session-c2b37e0b-eaa3-484d-9d7c-dd17b74fad8e"  # ai-production workspace


def _join(base, path):
    return base + path


def _read(url, timeout):
    with _urlopen(url, timeout=timeout) as r:
        return r.read().decode("utf-8")


def _read_raw(url, timeout):
    with _urlopen(url, timeout=timeout) as r:
        return r.read()


def _group(name):
    e = os.path.splitext(str(name))[1].lower()
    if e in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"):
        return "images"
    if e in (".mp4", ".webm", ".mov", ".mkv", ".avi"):
        return "videos"
    if e in (".wav", ".mp3", ".flac", ".ogg", ".m4a"):
        return "audio"
    return None


def _image_tensor_bytes(blob, max_side):
    import io
    from PIL import Image
    img = Image.open(io.BytesIO(blob)).convert("RGB")
    t = torch.from_numpy(np.asarray(img, dtype=np.float32) / 255.0)
    return _resize_side(t, max_side)


def _stack_bytes(blobs, max_side):
    ts = [_image_tensor_bytes(b, max_side) for b in blobs]
    H = max(t.shape[0] for t in ts)
    W = max(t.shape[1] for t in ts)
    out = []
    for t in ts:
        if t.shape[0] == H and t.shape[1] == W:
            out.append(t)
            continue
        p = torch.zeros((H, W, 3), dtype=torch.float32)
        p[: t.shape[0], : t.shape[1]] = t
        out.append(p)
    return torch.stack(out)


def _decode_audio_bytes(blob):
    # decode in RAM to ComfyUI's AUDIO format; no temp files touch the disk
    import io
    import torchaudio
    wav, sr = torchaudio.load(io.BytesIO(blob))
    return {"waveform": wav, "sample_rate": int(sr)}


def _video_frames_bytes(blob, max_side):
    import av
    import io
    frames = []
    c = av.open(io.BytesIO(blob))
    s = c.streams.video[0]
    fps = float(s.average_rate) if s.average_rate else TARGET_FPS
    for frame in c.decode(s):
        frames.append(frame.to_ndarray(format="rgb24"))
    c.close()
    if not frames:
        return torch.zeros((0, 64, 64, 3))
    if abs(fps - TARGET_FPS) > 0.01:
        step = fps / TARGET_FPS
        frames = [frames[min(len(frames) - 1, int(round(i * step)))] for i in range(int(round(len(frames) / step)))]
    ts = [torch.from_numpy(f.astype(np.float32) / 255.0) for f in frames]
    H = max(t.shape[0] for t in ts)
    W = max(t.shape[1] for t in ts)
    out = []
    for t in ts:
        if t.shape[0] == H and t.shape[1] == W:
            out.append(_resize_side(t, max_side))
            continue
        p = torch.zeros((H, W, 3), dtype=torch.float32)
        p[: t.shape[0], : t.shape[1]] = t
        out.append(_resize_side(p, max_side))
    return torch.stack(out)


def _dsh_dir():
    # folder_paths returns the merged input root; the dsh/ subdir namespaces everything this pack writes.
    return os.path.join(folder_paths.get_input_directory(), DSH_SUBFOLDER)


def _slugs():
    base = _dsh_dir()
    out = []
    for p in glob.glob(os.path.join(base, "asset_*.json")):
        out.append(os.path.basename(p)[len("asset_"):-len(".json")])
    if not out:
        return ["(none staged - open Director Studio tab)"]
    return sorted(out)


def _sidecar(slug):
    p = os.path.join(_dsh_dir(), "asset_%s.json" % slug)
    if not os.path.isfile(p):
        return {}
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def _stage_path(name):
    # Staged names come from the sidecar; joined straight onto the dsh/ dir.
    return os.path.join(_dsh_dir(), name)


def _load_image(name):
    from PIL import Image
    img = Image.open(_stage_path(name)).convert("RGB")
    return torch.from_numpy(np.asarray(img, dtype=np.float32) / 255.0)


def _stack_images(names):
    ts = [_load_image(n) for n in names]
    if not ts:
        return torch.zeros((0, 64, 64, 3))
    H = max(t.shape[0] for t in ts)
    W = max(t.shape[1] for t in ts)
    # ponytail: a torch batch must be uniform, so smaller images are black-padded
    # bottom/right, never resampled (keeps pixels lossless for the asset refs).
    # Upgrade path: per-image sockets if the H3 pack ever counts batches as members.
    out = []
    for t in ts:
        if t.shape[0] == H and t.shape[1] == W:
            out.append(t)
            continue
        p = torch.zeros((H, W, 3), dtype=torch.float32)
        p[: t.shape[0], : t.shape[1]] = t
        out.append(p)
    return torch.stack(out)


def _resize_side(t, max_side):
    # 0 / off means untouched; when set, longest side is scaled down (nearest).
    if not max_side or t.shape[0] <= max_side and t.shape[1] <= max_side:
        return t
    import torch.nn.functional as F
    scale = float(max_side) / float(max(t.shape[0], t.shape[1]))
    nh = max(1, int(round(t.shape[0] * scale)))
    nw = max(1, int(round(t.shape[1] * scale)))
    b = t.permute(2, 0, 1).unsqueeze(0)
    b = F.interpolate(b, size=(nh, nw), mode="nearest")
    return b.squeeze(0).permute(1, 2, 0)


def _video_frames(name, max_side):
    import av
    frames = []
    c = av.open(_stage_path(name))
    s = c.streams.video[0]
    fps = float(s.average_rate) if s.average_rate else TARGET_FPS
    for frame in c.decode(s):
        frames.append(frame.to_ndarray(format="rgb24"))
    c.close()
    if not frames:
        return torch.zeros((0, 64, 64, 3))
    if abs(fps - TARGET_FPS) > 0.01:
        # naive nearest-frame retiming to the H3's 24 fps contract.
        n = len(frames)
        want = max(1, int(round(n * TARGET_FPS / fps)))
        idxs = [min(n - 1, int(i * n / want)) for i in range(want)]
        frames = [frames[i] for i in idxs]
    # ponytail: a 4K 10 s clip is ~6.5 GB as a frame batch — the video_scale
    # widget above is the memory lever; no silent clamp by design.
    ts = [torch.from_numpy(np.asarray(f, dtype=np.float32) / 255.0) for f in frames]
    ts = [_resize_side(t, max_side) for t in ts]
    return torch.stack(ts)


def _load_audio(name):
    import torchaudio
    wav, sr = torchaudio.load(_stage_path(name))
    return {"waveform": wav.unsqueeze(0), "sample_rate": int(sr)}


def _notes_text(sc):
    parts = []
    if sc.get("description"):
        parts.append(sc["description"])
    if sc.get("notes"):
        parts.append(sc["notes"])
    for grp in ("images", "videos", "audio"):
        for item in sc.get(grp, []):
            tags = " ".join(item.get("tags", []))
            note = item.get("note", "")
            if tags or note:
                parts.append("%s: %s %s" % (item.get("key", item.get("file", "")), tags, note))
    return "\n".join(parts)


class DSStudioAsset:
    """Live pull of one Director Studio asset straight from the DSH server.

    No staging, no copies: every RUN asks DSH for the CURRENT asset record
    (/api/library) and streams each approved file over /api/file. The node
    carries the workspace identity via the `session` widget, so multiple
    workflows on multiple ComfyUI hosts always get the latest library state.
    """

    @classmethod
    def _library(cls, base, session):
        # 3 s budget: INPUT_TYPES runs on every object_info refresh; never hang the UI.
        try:
            with _urlopen(_join(base, "/director-studio/api/library?session=" + _q(session)), timeout=3) as r:
                return json.loads(r.read().decode("utf-8"))
        except _HTTP_ERR as e:
            if getattr(e, "code", 0) == 404:
                raise ValueError("DSH has no workspace for session '%s' - use the DSH session id (starts with 'session-')" % session)
            return None
        except Exception:
            return None

    @classmethod
    def INPUT_TYPES(cls):
        base = _DSH_URL_DEFAULT
        # session widget is a WORKSPACE NAME combo — the ZeroTier gateway maps
        # names (and paths) to the right DSH session automatically.
        try:
            ws = json.loads(_read(_join(base, "/director-studio/api/workspaces"), timeout=3))
            sessions = [w["name"] for w in ws if w.get("name")] or [_DSH_SESSION_DEFAULT]
        except Exception:
            sessions = [_DSH_SESSION_DEFAULT]
        session = sessions[0]
        assets = ["(DSH unreachable at %s)" % base]
        try:
            body = json.loads(_read(_join(base, "/director-studio/api/library?session=" + _q(session)), timeout=3))
            names = sorted(a["name"] for a in body if a.get("name"))
            if names:
                assets = names
        except Exception:
            pass
        return {"required": {
            "asset": (assets, {}),
            "dsh_url": ("STRING", {"default": base, "multiline": False, "tooltip": "DSH server origin reachable from this ComfyUI box (ZeroTier)."}),
            "session": (sessions, {"tooltip": "DSH workspace name (the folder holding the Director Studio library)."}),
            "approved_only": ("BOOLEAN", {"default": True, "tooltip": "approved refs only; off = also brainstorming"}),
            "include_library_refs": ("BOOLEAN", {"default": True, "tooltip": "also pull images//media/ files tagged to this asset"}),
            "max_side": ("INT", {"default": 0, "min": 0, "tooltip": "downscale longest side; 0 = untouched"}),
        }}

    # one socket PER approved item: images_1..8, videos_1..4 (frame stacks),
    # audios_1..4 (decoded in RAM, never written to disk), then the two text boxes.
    # ponytail: ComfyUI core 0.44 fixes socket counts per CLASS — an asset with
    # nothing in a slot gets a zero-sized tensor = "no output", not a fake frame.
    MAX_IMAGES, MAX_VIDEOS, MAX_AUDIOS = 8, 4, 4
    RETURN_TYPES = tuple(["IMAGE"] * MAX_IMAGES + ["IMAGE"] * MAX_VIDEOS + ["AUDIO"] * MAX_AUDIOS + ["STRING", "STRING"])
    RETURN_NAMES = tuple(["images_%d" % (i + 1) for i in range(MAX_IMAGES)] + ["videos_%d" % (i + 1) for i in range(MAX_VIDEOS)] + ["audios_%d" % (i + 1) for i in range(MAX_AUDIOS)] + ["description", "notes"])
    FUNCTION = "pull"
    CATEGORY = "DirectorStudio"

    def pull(self, asset, dsh_url, session, approved_only, include_library_refs, max_side):
        base = dsh_url.rstrip("/")
        body = self._library(base, session)
        if body is None:
            raise ValueError("DSH unreachable at %s (check dsh_url/session)" % base)
        item = next((a for a in body if a.get("name") == asset), None)
        if not item:
            raise ValueError("asset '%s' not in Director Studio of this workspace" % asset)
        notes = []
        description_text = item.get("description") or ""
        # notes socket = the studio "Notes (for the models)" box FIRST, then per-ref tags
        notes = [item["notes"]] if item.get("notes") else []
        imgs, vids, auds = [], [], []
        def meta_of(key):
            return (item.get("ref_meta") or {}).get(key) or {}
        # 1) files bound on the asset board: served by /api/files/library/<kind>/<id>/<key>
        for key, fname in (item.get("files") or {}).items():
            m = meta_of(key)
            tags = m.get("tags") or []
            if approved_only and "approved" not in tags:
                continue
            # /api/files/library has no server handler yet (0.2.85 restart pending) —
            # report the key so the human can tag it into the images library instead.
            notes.append("BOARD FILE %s (%s): not streamable yet - use library_refs (approved images/clips)" % (key, fname))
            continue
            g = _group(fname)
            if g == "images":
                imgs.append(data)
            elif g == "videos":
                vids.append(data)
            elif g == "audio":
                auds.append(data)
            if m.get("note"):
                notes.append("REF %s: %s" % (key, m["note"]))
            notes.append("REF %s tags: %s" % (key, ",".join(tags) or "-"))
        # 2) library_refs: pictures/clips tagged with this asset's name
        if include_library_refs:
            for ref in item.get("library_refs") or []:
                tags = ref.get("tags") or []
                if approved_only and "approved" not in tags:
                    continue
                url = _join(base, "/director-studio/api/file?path=" + _q(ref.get("abs") or "") + "&session=" + _q(session))
                data = _read_raw(url, timeout=60)
                g = _group(ref.get("name") or ref.get("path") or "")
                if g == "images":
                    imgs.append(data)
                elif g == "videos":
                    vids.append(data)
                elif g == "audio":
                    auds.append(data)
                if ref.get("note"):
                    notes.append("LIBREF %s: %s" % (ref.get("name"), ref["note"]))
        if not imgs and not vids:
            raise ValueError("asset '%s' has no %smedia - approve refs in Director Studio or switch approved_only off" % (asset, "approved " if approved_only else ""))
        # one IMAGE socket per picture: each is a 1-frame batch, nothing left stacked
        islots = [torch.zeros((0, 64, 64, 3)) for _ in range(self.MAX_IMAGES)]
        for i, blob in enumerate(imgs[:self.MAX_IMAGES]):
            islots[i] = _image_tensor_bytes(blob, max_side).unsqueeze(0)
        vslots = [torch.zeros((0, 64, 64, 3)) for _ in range(self.MAX_VIDEOS)]
        for i, blob in enumerate(vids[:self.MAX_VIDEOS]):
            vslots[i] = _video_frames_bytes(blob, max_side)
        aus = []
        for blob in auds[:self.MAX_AUDIOS]:
            aus.append(_decode_audio_bytes(blob))
        while len(aus) < self.MAX_AUDIOS:
            aus.append(None)
        def _empty_audio():
            return {"waveform": torch.zeros((1, 0)), "sample_rate": 44100}
        filled = list(islots) + list(vslots) + [a if a else _empty_audio() for a in aus] + [description_text, "\n".join(notes)]
        return tuple(filled)


class DSStudioImage:
    """Single staged Director Studio image -> IMAGE (for one H3 picture socket)."""

    @classmethod
    def INPUT_TYPES(cls):
        base = _dsh_dir()
        files = []
        for ext in ("png", "jpg", "jpeg", "webp", "gif", "bmp"):
            files += [os.path.basename(p) for p in glob.glob(os.path.join(base, "*.%s" % ext))]
        if not files:
            files = ["(none staged - open Director Studio tab)"]
        return {"required": {"file": (sorted(files),)}}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "load"
    CATEGORY = "DirectorStudio"

    def load(self, file):
        if not os.path.isfile(_stage_path(file)):
            raise ValueError("not staged in input/%s: %s (open the Director Studio tab to stage it)" % (DSH_SUBFOLDER, file))
        return (_load_image(file),)


class DSStudioPick:
    """Unpack one image from a DSStudioAsset batch (index 0 = first)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",),
                             "index": ("INT", {"default": 0, "min": 0})}}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "pick"
    CATEGORY = "DirectorStudio"

    def pick(self, images, index):
        if images.shape[0] == 0:
            raise ValueError("empty Director Studio image batch")
        i = min(index, images.shape[0] - 1)
        return (images[i:i + 1],)


NODE_CLASS_MAPPINGS = {
    "DSStudioAsset": DSStudioAsset,
    "DSStudioImage": DSStudioImage,
    "DSStudioPick": DSStudioPick,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "DSStudioAsset": "Director Studio Asset",
    "DSStudioImage": "Director Studio Image",
    "DSStudioPick": "Director Studio Pick",
}
