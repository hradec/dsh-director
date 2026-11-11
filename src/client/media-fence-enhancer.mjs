import React from "react";
import {createRoot} from "react-dom/client";
import {ChatMediaCard} from "./ChatMediaCard.jsx";

// Take over DSH GenUI media fences: fences whose blocks are all images/videos are replaced
// by our ChatMediaCard (tabs, wipe-compare, zoom/pan). Consecutive media fences in the same
// message group into ONE card — agents that split an A/B/C comparison across cards still get
// a single compare card. Left-drag a card onto another merges them; ↺ original splits back.
// ponytail: mixed text+media fences are skipped ('skip' marker); GenUI re-renders reset merges
// and re-group (mount state is live-only). Upgrade path: persist groups by src list.

const fenceRoot = ".genui-dom-fence";
const mediaFigure = (el) => el.tagName === "FIGURE" && [...el.classList].some((c) => c.endsWith("_media"));

function parseFence(root) {
  const container = root.querySelector(":scope > div") ?? root;
  const items = [];
  for (const b of [...container.children]) {
    if (!mediaFigure(b)) return null; // mixed-content fence: maybe still convertible from its source JSON
    const video = b.querySelector("video"), img = b.querySelector("img");
    const el = video ?? img;
    if (!el || !el.getAttribute("src")) return null;
    const caption = b.querySelector('[class$="_mediaLabel"],figcaption');
    items.push({type: video ? "video" : "image", src: el.src, label: caption?.textContent?.trim() || el.getAttribute("alt") || ""});
  }
  return items.length ? items : null;
}

// GenUI renders each fence from a code-block element that keeps the fence's raw JSON
// ([data-code-block-content] inside .md-code-block/.code-block — the very selectors GenUI
// depends on, so this ages exactly as fast as GenUI upgrades). Needed because a tabs-flip
// fence keeps only the ACTIVE tab's image in the DOM; the source JSON has all of them.
function rawSpec(root) {
  const code = root.closest(".md-code-block, .code-block, .code-block-small");
  if (!code) return null;
  const holder = code.querySelector("[data-code-block-content]");
  const raw = holder?.getAttribute("data-code-block-content") || holder?.textContent || "";
  try {
    const spec = JSON.parse(raw);
    if (Array.isArray(spec)) return {items: spec};
    return spec && typeof spec === "object" ? spec : null;
  } catch { return null; }
}

function specItems(spec) {
  const list = Array.isArray(spec.items) ? spec.items : Array.isArray(spec) ? spec : null;
  if (!list) return null;
  const out = [];
  let media = 0;
  for (const it of list) {
    if (!it || typeof it !== "object") return null;
    if (it.type === "image" || it.type === "video") {
      const src = it.src || it.url;
      if (!src) return null;
      media++;
      out.push({type: it.type, src, label: it.alt || it.title || it.caption || ""});
    } else if (it.type === "tabs") {
      for (const tab of Array.isArray(it.tabs) ? it.tabs : []) {
        let found = false;
        for (const k of Array.isArray(tab.items) ? tab.items : []) {
          if (k && (k.type === "image" || k.type === "video")) {
            const src = k.src || k.url;
            if (!src) return null;
            media++;
            found = true;
            out.push({type: k.type, src, label: tab.label || k.alt || ""});
          } else if (k && k.type !== "text" && k.type !== "caption") return null;
        }
        if (!found) return null; // a tab without media: not a media flip
      }
    } else if (it.type === "text" || it.type === "caption") {
      const text = String(it.content ?? it.text ?? "").trim();
      if (text) out.push({type: "note", text});
    } else return null; // unknown block types: leave the fence to GenUI
  }
  return media ? out : null;
}

function fenceItems(root) {
  const dom = parseFence(root);
  if (dom) return dom;
  const spec = rawSpec(root);
  return spec ? specItems(spec) : null;
}

const liveRoots = new Set();
const mounts = new WeakMap(); // fence → {mount, reactRoot}

function containerOf(fence) { return fence.querySelector(":scope > div") ?? fence; }
const isEmptySpacer = (el) => !el.textContent.trim() && !el.querySelector("img,video,canvas,svg,a,button");

function collectGroups(doc) {
  const parsed = new Map();
  for (const f of doc.querySelectorAll(fenceRoot)) {
    if (f.dataset.directorFence === "skip") continue;
    const items = fenceItems(f);
    if (!items) { f.dataset.directorFence = "skip"; continue; }
    parsed.set(f, items);
  }
  const groups = [];
  for (const [f, items] of parsed) {
    const last = groups[groups.length - 1];
    if (last && last.parent === f.parentElement) {
      let n = last.fences[last.fences.length - 1].nextElementSibling, adjacent = false;
      while (n) { if (n === f) { adjacent = true; break; } if (!isEmptySpacer(n)) break; n = n.nextElementSibling; }
      if (adjacent) { last.fences.push(f); last.items.push(items); continue; }
    }
    groups.push({parent: f.parentElement, fences: [f], items: [items]});
  }
  return groups;
}

function ensureMount(fence) {
  let entry = mounts.get(fence);
  if (entry && entry.mount.isConnected) return entry;
  const mount = document.createElement("div");
  mount.className = "dsh-fence-mount";
  containerOf(fence).append(mount);
  const reactRoot = createRoot(mount);
  entry = {mount, reactRoot};
  mounts.set(fence, entry);
  liveRoots.add(reactRoot);
  return entry;
}

function dropMount(fence) {
  const entry = mounts.get(fence);
  if (!entry) return;
  mounts.delete(fence);
  liveRoots.delete(entry.reactRoot);
  entry.mount.remove();
  entry.reactRoot.render(null); // ponytail: deferred unmount via render(null); React warns none at runtime
}

function takeGroup(group) {
  const [first] = group.fences;
  if (first.dataset.directorGroup && first.querySelector(":scope > div > .dsh-fence-mount, :scope > .dsh-fence-mount")) return;
  first.dataset.directorGroup = "1";
  const base = group.items; // per-fence original sets
  let per = [[...base.flat()]]; // default: everything in one card (auto-group)
  const render = () => {
    group.fences.forEach((f, i) => {
      const items = i === 0 ? (per[0] ?? []) : (per[i] ?? []);
      if (!items.length) { dropMount(f); return; }
      const entry = ensureMount(f);
      entry.reactRoot.render(React.createElement(ChatMediaCard, {
        items,
        merged: JSON.stringify(per) !== JSON.stringify(base),
        onMerge: (incoming) => {
          const seen = new Set(per.flat().map((x) => x.src));
          per = [[...per.flat(), ...(Array.isArray(incoming) ? incoming : []).filter((x) => x?.src && !seen.has(x.src))]];
          render();
        },
        onReset: () => { per = base.map((a) => [...a]); render(); },
      }));
    });
  };
  render();
}

export function startMediaFenceTakeover(doc) {
  // Same no-DOM guard as startMediaPathFixer: plugin apply() runs in realms without a browser.
  const Observer = doc?.defaultView?.MutationObserver;
  if (!doc || !Observer) return () => {};
  let timer = 0;
  const scan = () => { for (const g of collectGroups(doc)) takeGroup(g); };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(scan, 200); };
  scan();
  const observer = new Observer(schedule);
  observer.observe(doc.body, {childList: true, subtree: true});
  return () => { clearTimeout(timer); observer.disconnect(); for (const r of liveRoots) r.unmount(); liveRoots.clear(); };
}
