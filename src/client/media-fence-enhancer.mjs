import React from "react";
import {createRoot} from "react-dom/client";
import {ChatMediaCard} from "./ChatMediaCard.jsx";

// Take over DSH GenUI media fences: any rendered fence whose blocks are all images/videos
// is replaced by our ChatMediaCard (tabs, wipe-compare, zoom/pan). "Pretty html" becomes a tool.
// ponytail: fences with mixed text+media are skipped ('skip' marker) — upgrade path: splice the
// card in place of the media blocks and keep the text. Genui re-renders re-mount the card (its
// local state resets); acceptable until we own the fence renderer.

const fenceRoot = ".genui-dom-fence";
const mediaFigure = (el) => el.tagName === "FIGURE" && [...el.classList].some((c) => c.endsWith("_media"));

function parseFence(root) {
  const container = root.querySelector(":scope > div") ?? root;
  const blocks = [...container.children];
  const items = [];
  for (const b of blocks) {
    if (!mediaFigure(b)) return null; // mixed-content fence: leave it to GenUI
    const video = b.querySelector("video"), img = b.querySelector("img");
    const el = video ?? img;
    if (!el || !el.getAttribute("src")) return null;
    const caption = b.querySelector('[class$="_mediaLabel"],figcaption');
    items.push({
      type: video ? "video" : "image",
      src: el.src,
      label: caption?.textContent?.trim() || el.getAttribute("alt") || "",
    });
  }
  return items.length ? items : null;
}

const cardRoots = new WeakMap(); // fence → React root (WeakMap is not iterable; live roots also go in this Set for cleanup)
const liveRoots = new Set();

function takeover(root) {
  if (root.querySelector(".dsh-fence-mount")) return;
  const items = parseFence(root);
  if (!items) { root.dataset.directorFence = "skip"; return; }
  const container = root.querySelector(":scope > div") ?? root;
  cardRoots.get(root)?.unmount();
  container.textContent = "";
  const mount = document.createElement("div");
  mount.className = "dsh-fence-mount";
  container.append(mount);
  const reactRoot = createRoot(mount);
  cardRoots.set(root, reactRoot);
  liveRoots.add(reactRoot);
  reactRoot.render(React.createElement(ChatMediaCard, { items }));
}

export function startMediaFenceTakeover(doc) {
  // Same no-DOM guard as startMediaPathFixer: plugin apply() runs in realms without a browser.
  const Observer = doc?.defaultView?.MutationObserver;
  if (!doc || !Observer) return () => {};
  let timer = 0;
  const scan = () => { for (const f of doc.querySelectorAll(fenceRoot)) takeover(f); };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(scan, 200); };
  scan();
  const observer = new Observer(schedule);
  observer.observe(doc.body, {childList: true, subtree: true});
  return () => { clearTimeout(timer); observer.disconnect(); for (const r of liveRoots) r.unmount(); liveRoots.clear(); };
}
