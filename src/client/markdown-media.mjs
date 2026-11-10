// Conversation-wide media repair: reply markdown and tool output often embed server filesystem
// paths (/tmp/..., /net/...) which browsers cannot load; the GUI shows "Image failed to load".
// This watcher rewrites any such <img> to the plugin's /api/file route and swaps video/audio
// paths that were stuffed into <img> tags for real player elements.
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|ico)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|flac|aac|m4a)$/i;
// ponytail: every path the web server itself serves must be whitelisted here — /director-media is
// the media card route; rewriting it into /api/file?path=… 404s and blanks every review card image.
const SERVED_PREFIX = /^\/(director-studio|director-media|api|assets|front|avatars|app)(\/|\b)/;

export function startMediaPathFixer(doc, { MutationObserver = doc.defaultView?.MutationObserver } = {}) {
  const target = src => `/director-studio/api/file?path=${encodeURIComponent(src)}`;
  const fixImg = img => {
    const raw = img.getAttribute?.('src');
    if (!raw || img.dataset?.directorMedia) return;
    if (!raw.startsWith('/') || raw.startsWith('//') || SERVED_PREFIX.test(raw)) return;
    const clean = raw.split(/[?#]/)[0];
    const media = VIDEO_EXT.test(clean) ? 'video' : AUDIO_EXT.test(clean) ? 'audio' : IMAGE_EXT.test(clean) ? 'image' : 'image';
    img.dataset.directorMedia = '1';
    if (media === 'image') { img.src = target(raw); return; }
    const player = doc.createElement(media);
    player.controls = true;
    player.preload = 'metadata';
    player.src = target(raw);
    if (media === 'video') { player.playsInline = true; player.style.maxWidth = '100%'; } else player.style.width = '100%';
    img.replaceWith(player);
  };
  const scan = root => { for (const img of root?.querySelectorAll?.('img') ?? []) fixImg(img); };
  scan(doc);
  if (!MutationObserver) return () => {};
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') { fixImg(record.target); continue; }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IMG') fixImg(node); else scan(node);
      }
    }
  });
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  return () => observer.disconnect();
}
