// Layered Director Studio Book UI (v10 port): parchment + 15-slice leather frame +
// stains/illustrations + bookmark navigation, hosting the existing AssetWorkspace
// panels. Navigation (top tabs, Library, side markers) turns a real 3D page leaf:
// a flexible sheet approximated with 22 independent strips. The frame never moves.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

const B = "/director-studio/book";
const TURN_MS = 850;

export type BookCategory = "library" | "actors" | "scenes" | "props" | "voices";
export type BookChapter = "references" | "lorekeeper" | "lineage";
export interface BookView { category: BookCategory; chapter: BookChapter; }

const ORDER: BookCategory[] = ["library", "actors", "scenes", "props", "voices"];
const TOP_TABS: Exclude<BookCategory, "library">[] = ["actors", "scenes", "props", "voices"];
// A chapter marker is live only where its page component actually renders.
const chapterEnabled = (category: BookCategory, id: string) =>
  (id === "lorekeeper" && (category === "actors" || category === "scenes" || category === "props")) ||
  (id === "lineage" && category === "actors");
// Nine-slice leather markers: Lorekeeper + Lineage are wired; three stay blank placeholders.
const MARKERS: { id: string; color: string; label: string }[] = [
  { id: "lorekeeper", color: "burgundy", label: "Lorekeeper" },
  { id: "lineage", color: "blue", label: "Lineage" },
  { id: "spare-3", color: "green", label: "" },
  { id: "spare-4", color: "gold", label: "" },
  { id: "spare-5", color: "navy", label: "" },
];

// The common page contour in the reference 15-slice frame (v10).
const OUTLINE: number[][] = [[108,112],[110,101],[115,92],[124,84],[138,79],[155,77],[210,77],[350,78],[500,79],[610,78],[670,79],[705,83],[726,90],[744,102],[756,116],[761,126],[761,838],[750,827],[737,816],[723,807],[706,800],[688,796],[665,793],[640,793],[610,795],[570,799],[510,803],[450,804],[350,804],[250,804],[165,804],[144,803],[129,800],[118,792],[112,782],[108,769]];

interface PageRect { left: number; top: number; width: number; height: number; clip: string; }
// Clones keep their ORIGINAL boxes: each is re-positioned absolutely in the face,
// so the snapshot can never reflow to a different size than the resting page (blink fix).
interface SideSnap { rect: PageRect; clones: HTMLElement[]; boxes: { left: number; top: number; width: number; height: number }[]; }

function mapAxis(v: number, src: number[], dst: number[]): number {
  for (let i = 0; i < src.length - 1; i++) if (v <= src[i + 1]) return dst[i] + ((v - src[i]) * (dst[i + 1] - dst[i])) / (src[i + 1] - src[i]);
  return dst[dst.length - 1];
}

// A resting content element = visible grid item; panels and their <main> wrappers
// are display:contents, so recurse through every contents level.
function gridItems(container: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (el: HTMLElement) => {
    for (const c of Array.from(el.children) as HTMLElement[]) {
      if (getComputedStyle(c).display === "contents") walk(c);
      else if (c.offsetParent) out.push(c);
    }
  };
  walk(container);
  return out;
}

function snapshot(el: HTMLElement): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.dataset.savedScroll = String(el.scrollTop || 0);
  copy.removeAttribute("id");
  copy.querySelectorAll("[id]").forEach((e) => e.removeAttribute("id"));
  const from = el.querySelectorAll("input,textarea,select"), to = copy.querySelectorAll("input,textarea,select");
  from.forEach((e, i) => { const c = to[i] as HTMLInputElement; if ("value" in c) { c.value = (e as HTMLInputElement).value; c.checked = (e as HTMLInputElement).checked; } });
  return copy;
}

function snapSide(items: HTMLElement[]): SideSnap | null {
  if (!items.length) return null;
  const boxes = items.map((el) => { const q = el.getBoundingClientRect(); return { left: q.left, top: q.top, width: q.width, height: q.height }; });
  const clones = items.map(snapshot);
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const q of boxes) { l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.left + q.width); b = Math.max(b, q.top + q.height); }
  return { rect: { left: l, top: t, width: r - l, height: b - t, clip: "" }, clones, boxes };
}

export interface BookShellHandle { navigate: (category: BookCategory, chapter?: BookChapter) => void; }

export const BookShell = forwardRef<BookShellHandle, {
  view: BookView;
  onView: (view: BookView) => void;
  askDsh: () => void;
  importActor: () => void;
  settings: () => void;
  queue: () => void;
  children: ReactNode;
}>(function BookShell({ view, onView, askDsh, importActor, settings, queue, children }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const decoRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const surfacesRef = useRef<HTMLDivElement>(null);
  const pageRectsRef = useRef<PageRect[]>([]);
  const pageSurfacesRef = useRef<HTMLElement[]>([]);
  const turningRef = useRef(false);
  const finishRef = useRef<null | (() => void)>(null);
  const queuedRef = useRef<BookView | null>(null);
  const pendingRef = useRef<{ front: SideSnap | null; holdLeft: SideSnap | null; holdRight: SideSnap | null } | null>(null);
  const lastRef = useRef<BookView>(view);
  const viewRef = useRef(view);
  viewRef.current = view;

  // The book fills its container; --s keeps the art's proportions (v10 resize()).
  function resize() {
    if (finishRef.current) finishRef.current();
    const book = bookRef.current, wrap = wrapRef.current;
    if (!book || !wrap) return;
    book.style.width = "100%";
    const actual = book.clientWidth;
    const height = Math.max(wrap.clientHeight, 640);
    const s = Math.min(1, actual / 1150, height / 840);
    const needed = Math.ceil((138 + 5 * 84 + 4 * 6 + 150) * s);
    const effective = Math.max(height, needed);
    book.style.setProperty("--s", String(s));
    book.style.height = effective + "px";
    refreshSurfaces();
  }

  function edgeAging(side: string) {
    const edge = document.createElement("div");
    edge.className = "edge-aging " + side;
    edge.setAttribute("aria-hidden", "true");
    for (const name of ["top", "bottom", "outer"]) { const i = document.createElement("i"); i.className = "edge-" + name; edge.append(i); }
    return edge;
  }

  function geometry(): PageRect[] {
    const book = bookRef.current!;
    const b = book.getBoundingClientRect();
    const s = Number(getComputedStyle(book).getPropertyValue("--s")) || 1;
    const x = [0, 150, 710, 812, 1372, 1522], X = [0, 150 * s, b.width / 2 - 51 * s, b.width / 2 + 51 * s, b.width - 150 * s, b.width];
    const y = [0, 485, 625, 940], Y = [0, 485 * s, b.height - 315 * s, b.height];
    const mx = (v: number) => mapAxis(v, x, X), my = (v: number) => mapAxis(v, y, Y);
    const left = mx(108), top = my(70), width = b.width / 2 - left, height = my(842) - top;
    return ["left", "right"].map((side) => {
      const ox = side === "left" ? left : b.width / 2;
      const pts = OUTLINE.map(([px, py]) => [mx(side === "left" ? px : 1522 - px) - ox, my(py) - top]);
      return { left: b.left + ox, top: b.top + top, width, height, clip: "polygon(" + pts.map(([px, py]) => `${px}px ${py}px`).join(",") + ")" };
    });
  }

  // One shared page surface, used for resting pages and cloned for moving faces.
  function buildSurface(side: "left" | "right", rect: PageRect): HTMLElement {
    const book = bookRef.current!, frame = frameRef.current!, deco = decoRef.current!;
    const face = document.createElement("div");
    face.className = "leaf-art " + side;
    Object.assign(face.style, { width: rect.width + "px", height: rect.height + "px", clipPath: rect.clip });
    const br = book.getBoundingClientRect();
    const border = frame.cloneNode(true) as HTMLElement;
    border.classList.add("leaf-border");
    Object.assign(border.style, { inset: "auto", left: (br.left - rect.left) + "px", top: (br.top - rect.top) + "px", width: br.width + "px", height: br.height + "px" });
    face.style.backgroundPosition = `${br.left - rect.left}px ${br.top - rect.top}px`;
    face.append(border, edgeAging(side));
    const sheet = (deco.querySelectorAll(".sheet") as NodeListOf<HTMLElement>)[side === "left" ? 0 : 1];
    const sr = sheet.getBoundingClientRect();
    const art = sheet.cloneNode(true) as HTMLElement;
    Object.assign(art.style, { visibility: "visible", left: (sr.left - rect.left) + "px", top: (sr.top - rect.top) + "px", right: "auto", bottom: "auto", width: sr.width + "px", height: sr.height + "px" });
    face.append(art);
    return face;
  }

  function refreshSurfaces() {
    const book = bookRef.current, surfaces = surfacesRef.current;
    if (!book || !surfaces) return;
    pageRectsRef.current = geometry();
    const b = book.getBoundingClientRect();
    pageSurfacesRef.current = pageRectsRef.current.map((rect, i) => {
      const face = buildSurface(i ? "right" : "left", rect);
      Object.assign(face.style, { left: (rect.left - b.left) + "px", top: (rect.top - b.top) + "px" });
      return face;
    });
    surfaces.replaceChildren(...pageSurfacesRef.current);
  }

  // A moving face = the resting page surface + a live snapshot of the content on it.
  function makeFace(side: "left" | "right", snap: SideSnap | null): HTMLElement {
    const face = pageSurfacesRef.current[side === "left" ? 0 : 1].cloneNode(true) as HTMLElement;
    Object.assign(face.style, { left: "0px", top: "0px" });
    if (snap) {
      const rect = pageRectsRef.current[side === "left" ? 0 : 1];
      const c = document.createElement("div");
      c.className = "content leaf-content";
      Object.assign(c.style, { display: "block", position: "absolute", left: "0px", top: "0px", width: rect.width + "px", height: rect.height + "px" });
      snap.clones.forEach((clone, i) => {
        clone.inert = true;
        const q = snap.boxes[i];
        Object.assign(clone.style, { position: "absolute", left: (q.left - rect.left) + "px", top: (q.top - rect.top) + "px", width: q.width + "px", height: q.height + "px", margin: "0", overflow: "hidden" });
        c.append(clone);
      });
      face.append(c);
    }
    return face;
  }

  function runTurn(prev: BookView, next: BookView, frontSnap: SideSnap | null, holdLeft: SideSnap | null, holdRight: SideSnap | null) {
    const book = bookRef.current!;
    // ponytail: every bookmark flips the right leaf leftward (v10 geometry); a
    // back-ward flip would need the left page to carry the outgoing chapter.
    const forward = true;
    const side: "left" | "right" = forward ? "right" : "left";
    const backSide: "left" | "right" = forward ? "left" : "right";
    // The real DOM already shows the NEW view (React committed): clone it for the back face.
    const content = contentRef.current!;
    const items = gridItems(content);
    const spine = book.getBoundingClientRect().left + book.getBoundingClientRect().width / 2;
    const backSnap = snapSide(items.filter((el) => (el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2 > spine) === (side === "left"))) || snapSide(items);
    const rects = pageRectsRef.current;
    const b = book.getBoundingClientRect();
    const W = rects[0].width, H = rects[0].height, Y = rects[0].top - b.top;
    turningRef.current = true;
    book.setAttribute("aria-busy", "true");
    const layer = document.createElement("div");
    layer.className = "turn-layer";
    layer.setAttribute("aria-hidden", "true");
    book.append(layer);
    const shadow = document.createElement("div");
    shadow.className = "turn-shadow";
    Object.assign(shadow.style, { top: Y + "px", height: H + "px", width: W + "px" });
    layer.append(shadow);
    const world = document.createElement("div");
    world.className = "turn-world";
    layer.append(world);
    // Both resting pages keep the OLD spread (opaque paper + old clones) for the whole
    // turn; the NEW view rides ONLY on the leaf's back face and lands over the old UI.
    const holds: HTMLElement[] = [];
    for (const [i, side, snap] of [[0, "left", holdLeft], [1, "right", holdRight]] as const) {
      if (!snap) continue;
      const lb = rects[i];
      const h = makeFace(side, snap);
      h.classList.add("hold-layer");
      Object.assign(h.style, { zIndex: "19", pointerEvents: "none", left: (lb.left - b.left) + "px", top: (lb.top - b.top) + "px" });
      book.append(h);
      holds.push(h);
    }
    const front = makeFace(side, frontSnap), back = makeFace(backSide, backSnap);
    const N = 22, dx = W / N, strips: { el: HTMLElement; front: HTMLElement; back: HTMLElement }[] = [];
    for (let i = 0; i < N; i++) {
      const strip = document.createElement("div");
      strip.className = "leaf-strip";
      Object.assign(strip.style, { width: (dx + 1.2) + "px", height: H + "px", top: Y + "px" });
      for (const [isBack, template] of [[false, front], [true, back]] as const) {
        const skin = document.createElement("div");
        skin.className = "leaf-skin " + (isBack ? "back" : "front");
        skin.hidden = isBack;
        const clip = template.cloneNode(true) as HTMLElement;
        const index = forward ? (isBack ? N - 1 - i : i) : (isBack ? i : N - 1 - i);
        clip.style.left = -index * dx + "px";
        skin.append(clip);
        strip.append(skin);
      }
      world.append(strip);
      for (const section of strip.querySelectorAll<HTMLElement>(".leaf-content section,.leaf-content aside")) section.scrollTop = Number(section.dataset.savedScroll) || 0;
      strips.push({ el: strip, front: strip.children[0] as HTMLElement, back: strip.children[1] as HTMLElement });
    }
    let start: number | undefined, finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      finishRef.current = null;
      layer.remove();
      for (const h of holds) h.remove();
      book.removeAttribute("aria-busy");
      turningRef.current = false;
      if (queuedRef.current) { const q = queuedRef.current; queuedRef.current = null; navigate(q.category, q.chapter); }
    }
    finishRef.current = finish;
    function tick(now: number) {
      if (finished) return;
      if (start === undefined) start = now;
      const raw = Math.min(1, (now - start) / TURN_MS);
      const p = raw * raw * (3 - 2 * raw);
      layer.dataset.progress = String(raw);
      let x = 0, z = 0;
      const bend = 1.15 * Math.sin(Math.PI * p);
      for (let i = 0; i < N; i++) {
        const theta = Math.PI * p + bend * ((i + 0.5) / N - 0.5);
        const x2 = x + dx * Math.cos(theta), z2 = z + dx * Math.sin(theta);
        const px = forward ? x : -x2, pz = forward ? z : z2;
        const piece = strips[i];
        piece.el.style.transform = `translate3d(${px}px,0,${pz}px) rotateY(${forward ? -theta : theta}rad)`;
        // Select exactly one opaque face based on its normal and the perspective camera.
        const centerX = (forward ? 1 : -1) * (x + x2) / 2, centerZ = (z + z2) / 2;
        const frontFacing = (3000 - centerZ) * Math.cos(theta) + (forward ? 1 : -1) * centerX * Math.sin(theta) >= 0;
        piece.front.hidden = !frontFacing;
        piece.back.hidden = frontFacing;
        piece.el.style.setProperty("--shade", String(0.32 * Math.sin(Math.PI * p) * (0.3 + 0.7 * (i / N))));
        x = x2; z = z2;
      }
      shadow.style.left = `calc(50% + ${forward ? -W * p : -W * (1 - p)}px)`;
      shadow.style.opacity = String(0.38 * Math.sin(Math.PI * p));
      shadow.style.transform = `scaleX(${0.65 + 0.35 * Math.sin(Math.PI * p)})`;
      if (raw < 1) requestAnimationFrame(tick);
      else finish();
    }
    tick(performance.now());
  }

  // Bookmark navigation: snapshot the CURRENT pages, then swap the view; the
  // layout effect turns the leaf between the two DOM states.
  function navigate(category: BookCategory, chapter: BookChapter = "references") {
    if (category === "library" || category === "voices") chapter = "references";
    const prev = viewRef.current;
    if (category === prev.category && chapter === prev.chapter) return;
    if (turningRef.current) { queuedRef.current = { category, chapter }; return; }
    const content = contentRef.current, book = bookRef.current;
    if (!content || !book) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { onView({ category, chapter }); return; }
    const rects = book.getBoundingClientRect();
    const spine = rects.left + rects.width / 2;
    const items = gridItems(content);
    const right = items.filter((el) => { const q = el.getBoundingClientRect(); return q.left + q.width / 2 > spine; });
    const left = items.filter((el) => { const q = el.getBoundingClientRect(); return q.left + q.width / 2 <= spine; });
    // Book physics (v10 demo): the NEW view exists ONLY on the turning leaf's back face;
    // both resting pages keep holding the OLD spread (paper + old clones) until the leaf lands.
    // Library/voices cards span both pages: the leaf carries the whole spread instead of skipping.
    const frontSrc = right.length ? right : items;
    pendingRef.current = { front: snapSide(frontSrc), holdLeft: snapSide(left), holdRight: snapSide(frontSrc) };
    lastRef.current = prev;
    onView({ category, chapter });
  }
  useImperativeHandle(ref, () => ({ navigate }), []);

  useLayoutEffect(() => {
    const prev = lastRef.current;
    if (!pendingRef.current || prev.category === view.category && prev.chapter === view.chapter) return;
    const snap = pendingRef.current;
    pendingRef.current = null;
    runTurn(prev, view, snap.front, snap.holdLeft, snap.holdRight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.category, view.chapter]);

  useEffect(() => {
    const book = bookRef.current!, frame = frameRef.current!;
    for (let r = 1; r <= 3; r++) for (let c = 1; c <= 5; c++) { const img = document.createElement("img"); img.src = `${B}/frame/r${r}-c${c}.png`; img.alt = ""; frame.append(img); }
    // The resting sheets are replaced by the contour-clipped surfaces.
    (decoRef.current!.querySelectorAll(".sheet") as NodeListOf<HTMLElement>).forEach((el) => { el.style.visibility = "hidden"; });
    refreshSurfaces();
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrapRef.current!);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const on = (c: BookCategory) => view.category === c;
  return (
    <div className="book-viewport" ref={wrapRef}>
      <main className="book" ref={bookRef} data-chapter={view.chapter} aria-label="Asset library book">
        <div className="paper" aria-hidden="true" />
        <div className="frame" ref={frameRef} aria-hidden="true" />
        <div className="decoration" ref={decoRef} aria-hidden="true">
          <div className="sheet left">
            <img className="stain s1" src={`${B}/stains/left-top.png`} alt="" />
            <img className="stain s2" src={`${B}/stains/left-bottom.png`} alt="" />
            <img className="stain s3" src={`${B}/stains/left-inner.png`} alt="" />
            <img className="art dragon" src={`${B}/art/dragon.png`} alt="" />
            <img className="art landscape" src={`${B}/art/landscape-left.png`} alt="" />
          </div>
          <div className="sheet right">
            <img className="stain s1" src={`${B}/stains/right-top.png`} alt="" />
            <img className="stain s2" src={`${B}/stains/right-bottom.png`} alt="" />
            <img className="art landscape" src={`${B}/art/landscape-right.png`} alt="" />
          </div>
        </div>
        <div className="resting-surfaces" ref={surfacesRef} aria-hidden="true" />
        <nav className="top-tabs" aria-label="Main sections">
          {TOP_TABS.map((k) => (
            <button key={k} type="button" data-section={k} aria-label={k} aria-pressed={on(k)} onClick={() => navigate(k, view.chapter)}>
              <img src={`${B}/tabs/${k}-${on(k) ? "selected" : "normal"}.png`} alt="" />
            </button>
          ))}
          <button type="button" className="action" aria-label="Ask DSH" onClick={askDsh}><img src={`${B}/tabs/ask-dsh.png`} alt="" /></button>
          <button type="button" className="action" aria-label="Import Actor" onClick={importActor}><img src={`${B}/tabs/import-actor.png`} alt="" /></button>
          <button type="button" className="action" aria-label="Settings" onClick={settings}><img src={`${B}/tabs/settings.png`} alt="" /></button>
        </nav>
        <button type="button" className="library bookmark" aria-label="Library" aria-pressed={on("library")} onClick={() => navigate("library")}><img src={`${B}/tabs/library.png`} alt="" /></button>
        <nav className="side-tabs" aria-label="Asset chapters">
          {MARKERS.map((m) => (
            <button key={m.id} type="button" data-color={m.color} aria-label={m.label || `Bookmark ${MARKERS.indexOf(m) + 1}`}
              aria-pressed={view.chapter === m.id} disabled={!chapterEnabled(view.category, m.id)}
              onClick={() => navigate(view.category, view.chapter === m.id ? "references" : (m.id as BookChapter))}>
              <span className="marker-grid" aria-hidden="true">
                {[1, 2, 3].map((r) => [1, 2, 3].map((c) => (
                  <i key={c} style={{ backgroundImage: `url(${B}/marker-slices/${m.color}/r${r}-c${c}.png)`, ["--tile-w" as string]: c === 2 ? "88px" : "10px", ["--tile-h" as string]: r === 2 ? "120px" : "12px" }} />
                )))}
              </span>
              {m.label ? <span>{m.label}</span> : null}
            </button>
          ))}
        </nav>
        <button type="button" className="queue bookmark" aria-label="DSH Queue" onClick={queue}><img src={`${B}/tabs/dsh-queue.png`} alt="" /></button>
        <button type="button" className="extra bookmark" aria-label="More" onClick={() => {}}><img src={`${B}/tabs/bottom-symbol.png`} alt="" /></button>
        <div className="content" ref={contentRef}>{children}</div>
      </main>
    </div>
  );
});
