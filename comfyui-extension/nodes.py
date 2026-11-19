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
    """One Director Studio asset -> H3-ready outputs.

    outputs: images (IMAGE batch) | video_1..3 (IMAGE frame batches @24fps) |
             audio_1..3 (AUDIO) | notes (STRING: description + model notes + tags)
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"asset": (_slugs(),)},
                "optional": {"video_scale": ("INT", {"default": 0, "step": 1,
                            "tooltip": "0 = native size; else longest side of every video frame downscaled to this"})}}

    RETURN_TYPES = ("IMAGE",) * (1 + MAX_VIDEOS) + ("AUDIO",) * MAX_AUDIOS + ("STRING",)
    RETURN_NAMES = ("images",) + tuple("video_%d" % (i + 1) for i in range(MAX_VIDEOS)) \
        + tuple("audio_%d" % (i + 1) for i in range(MAX_AUDIOS)) + ("notes",)
    OUTPUT_IS_LIST = (False,) * len(RETURN_TYPES)
    FUNCTION = "load"
    CATEGORY = "DirectorStudio"

    def load(self, asset, video_scale=0):
        sc = _sidecar(asset)
        imgs = _stack_images([i["file"] for i in sc.get("images", [])])
        vids = []
        for i in range(MAX_VIDEOS):
            item = sc.get("videos", [])[i] if i < len(sc.get("videos", [])) else None
            vids.append(_video_frames(item["file"], video_scale) if item else torch.zeros((0, 64, 64, 3)))
        auds = []
        for i in range(MAX_AUDIOS):
            item = sc.get("audio", [])[i] if i < len(sc.get("audio", [])) else None
            auds.append(_load_audio(item["file"]) if item else None)
        return (imgs,) + tuple(vids) + tuple(auds) + (_notes_text(sc),)


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
