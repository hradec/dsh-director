// VCONF conform files for the preview audio mixer (PreviewAudioEngine resolves
// mediaById.conform_path; AudioMixer/ConformSource range-reads a 28-byte header
// + 48 kHz f32le interleaved, 1-2 channels — header per native/src/jobs/conform.rs).
// DSH has no desktop conform job service, so the studio-api server produces the
// same artifact on demand with ffmpeg and caches it under .director-studio/conform/.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const INFLIGHT = new Map();
const HEADER_LEN = 28;

function buildHeader(frameCount, channels) {
  const buf = Buffer.alloc(HEADER_LEN);
  buf.write('VCONF', 0, 'ascii'); // magic @0; 5..7 padding zeros
  buf.writeUInt32LE(1, 8);       // version
  buf.writeUInt32LE(48000, 12);  // sample rate
  buf.writeUInt32LE(channels, 16);
  buf.writeBigUInt64LE(BigInt(frameCount), 20);
  return buf;
}

function decodePcm(source) {
  // one ffmpeg pass: strip video, resample 48k, cap at stereo (the engine rejects >2)
  return new Promise((resolveP, rejectP) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', source, '-vn', '-ac', '2', '-ar', '48000', '-acodec', 'pcm_f32le', '-f', 'f32le', 'pipe:1']);
    const chunks = [];
    let bytes = 0;
    child.stdout.on('data', (c) => { chunks.push(c); bytes += c.length; });
    child.stderr.on('data', () => {});
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code !== 0) { rejectP(new Error('conform decode failed (' + String(code) + ')')); return; }
      resolveP({ pcm: Buffer.concat(chunks), bytes });
    });
  });
}

// Returns the absolute .vconf path, or null when the source has no audio at all.
export function ensureConform(cacheRoot, source) {
  if (!existsSync(source)) return Promise.resolve(null);
  const info = statSync(source);
  const key = createHash('sha1').update(`vconf|${source}|${info.mtimeMs}|${info.size}`).digest('hex');
  const target = join(cacheRoot, `${key}.vconf`);
  if (existsSync(target)) return Promise.resolve(target);
  if (INFLIGHT.has(target)) return INFLIGHT.get(target);
  const work = (async () => {
    mkdirSync(cacheRoot, { recursive: true });
    try { for (const entry of readdirSync(cacheRoot)) { const full = join(cacheRoot, entry); const st = statSync(full); if (st.mtimeMs < Date.now() - 30 * 24 * 3600 * 1000) rmSync(full, { force: true }); } } catch {}
    const { pcm, bytes } = await decodePcm(source);
    if (bytes === 0) return null; // silent media: honest no-conform (engine keeps video-only playback)
    const channels = 2; // ffmpeg -ac 2 always emits stereo
    const frameCount = Math.floor(bytes / 4 / channels);
    writeFileSync(target + '.tmp', Buffer.concat([buildHeader(frameCount, channels), pcm]));
    renameSync(target + '.tmp', target);
    return target;
  })();
  const guarded = work.finally(() => INFLIGHT.delete(target));
  INFLIGHT.set(target, guarded);
  return guarded;
}

// Serve with byte-Range (ConformSource.readWindow range-reads windows).
export function readConformRange(target, rangeHeader, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader ?? ''));
  if (!m) return { start: 0, end: size - 1, partial: false };
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[2] === '' || m[1] === '' ? size - 1 : Math.min(size - 1, Number(m[2]));
  if (start > end || start >= size || end < 0) return null;
  return { start, end, partial: m[1] !== '' };
}
