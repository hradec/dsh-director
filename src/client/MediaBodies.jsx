// Document-tab media players: the sidebar has no renderer for video/audio, so the core shows the Open fallback.
// We register bodies that stream straight from the plugin's /api/file route (ranges supported — seeking works).
import React from 'react';
const VIDEO_EXT = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4v: 'video/mp4' };
const AUDIO_EXT = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4' };

function fileParts(address) {
  const prefix = 'dsh-resource://file/';
  const text = String(address ?? '');
  if (!text.startsWith(prefix)) return null;
  const [scope, ...rest] = text.slice(prefix.length).split(/[?#]/)[0].split('/');
  if (scope !== 'session' || rest.length < 2) return null;
  try {
    return { sessionId: decodeURIComponent(rest[0]), path: rest.slice(1).map(decodeURIComponent).join('/') };
  } catch {
    return null;
  }
}

export const MEDIA_KINDS = [['video', VIDEO_EXT], ['audio', AUDIO_EXT]];

export function createMediaBody(extensions) {
  return function MediaBody(props) {
    const react = React;
    const { content, resourceAddress } = props;
    const { tab } = props.useTabInfo();
    const parts = fileParts(resourceAddress);
    const ext = String(parts?.path ?? '').split('.').pop().toLowerCase();
    const mime = extensions[ext];
    const src = parts && mime ? `/director-studio/api/file?session=${encodeURIComponent(parts.sessionId)}&path=${encodeURIComponent(parts.path)}` : '';
    react.useEffect(() => {
      if (src && content?.kind === 'renderer' && typeof content.loaded === 'function') content.loaded(content.revision);
    }, [src, content]);
    if (!src) return react.createElement('p', { role: 'alert' }, 'This media file cannot be previewed.');
    const isAudio = mime.startsWith('audio/');
    const player = isAudio
      ? react.createElement('audio', { controls: true, preload: 'metadata', src, style: { width: '100%' } })
      : react.createElement('video', { controls: true, playsInline: true, preload: 'metadata', src, style: { maxWidth: '100%', maxHeight: '70vh' } });
    return react.createElement('div', { style: { padding: '0.8rem', display: 'flex', flexDirection: 'column', gap: '.5rem' } },
      player,
      react.createElement('div', { style: { fontSize: '12px', opacity: 0.7, wordBreak: 'break-all' } }, parts.path));
  };
}
