// Waveform peaks for timeline lanes: the vendored WaveformTileProducer wants
//   get_waveform_levels -> {channels, levels:[{level, peaksPerSecond, peakCount}]}
//   get_waveform_tile   -> {peaksPerSecond, min[], max[], rms[]}  (per level+channel, sliced)
// DSH builds the whole LOD pyramid on demand with one ffmpeg decode per source
// file, cached as meta JSON + an int16 binary under .director-studio/waveform/.
// Levels halve density upward (classic pyramid); peaksPerSecond stays EXACT
// (sampleRate / integer window), matching the producer's fractional indexing.
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const INFLIGHT = new Map(); // cacheKey -> promise(meta)

function ffprobeAudio(source) {
  return new Promise((done) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0:s=x', source], { timeout: 20000 }, (error, stdout) => {
      const m = error ? null : /(\d+)x(\d+)/.exec(String(stdout).trim());
      done(m ? { sampleRate: Number(m[1]), channels: Number(m[2]) } : null);
    });
  });
}

function decodeStream(source) {
  // interleaved little-endian f32 at the source's own rate/channel count.
  // ponytail: whole-decode in memory (a 30-min stereo 48k clip ≈ 350 MB, fine
  // on this box); upgrade path is windowed streaming through the producer.
  return new Promise((resolveP, rejectP) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', source, '-vn', '-acodec', 'pcm_f32le', '-f', 'f32le', 'pipe:1']);
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', () => {});
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code !== 0) { rejectP(new Error('ffmpeg audio decode failed (' + String(code) + ')')); return; }
      resolveP(Buffer.concat(chunks));
    });
  });
}

function buildLevels(pcm, info) {
  const { sampleRate, channels } = info;
  const totalFrames = pcm.length / 4 / channels;
  const spn0 = Math.max(1, Math.round(sampleRate / 512)); // base window (samples/frame), <=512 peaks/s
  // L0: exact windows over the interleaved stream
  const peakCount0 = Math.max(1, Math.ceil(totalFrames / spn0));
  const mins = []; const maxs = []; const sumsq = []; const counts = [];
  for (let c = 0; c < channels; c++) {
    mins.push(new Float32Array(peakCount0).fill(1));
    maxs.push(new Float32Array(peakCount0).fill(-1));
    sumsq.push(new Float64Array(peakCount0));
    counts.push(new Int32Array(peakCount0));
  }
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let frameIdx = 0;
  for (let i = 0; (i + channels) * 4 <= pcm.length; i += channels, frameIdx++) {
    const slot = Math.min(peakCount0 - 1, Math.floor(frameIdx / spn0));
    for (let c = 0; c < channels; c++) {
      const s = view.getFloat32((i + c) * 4, true);
      if (s < mins[c][slot]) mins[c][slot] = s;
      if (s > maxs[c][slot]) maxs[c][slot] = s;
      sumsq[c][slot] += s * s;
      counts[c][slot]++;
    }
  }
  const grid = [];
  const first = [];
  for (let c = 0; c < channels; c++) {
    const rms = new Float32Array(peakCount0);
    for (let p = 0; p < peakCount0; p++) {
      // an empty window (silent media past EOF, or all-zero) collapses to flat
      rms[p] = counts[c][p] > 0 ? Math.sqrt(sumsq[c][p] / counts[c][p]) : 0;
      if (mins[c][p] > maxs[c][p]) { mins[c][p] = 0; maxs[c][p] = 0; }
    }
    first.push({ min: mins[c], max: maxs[c], rms });
  }
  grid.push(first);
  const levels = [{ peaksPerSecond: sampleRate / spn0 }];
  // pyramid: each level halves density, exact fractional pps preserved
  for (let l = 0; grid[l][0].min.length > 1; l++) {
    const prev = grid[l]; const half = Math.ceil(prev[0].min.length / 2);
    const next = [];
    for (let c = 0; c < channels; c++) {
      const mn = new Float32Array(half); const mx = new Float32Array(half); const rm = new Float32Array(half);
      for (let p = 0; p < half; p++) {
        const a = p * 2; const b = Math.min(a + 1, prev[c].min.length - 1);
        mn[p] = Math.min(prev[c].min[a], prev[c].min[b]);
        mx[p] = Math.max(prev[c].max[a], prev[c].max[b]);
        rm[p] = Math.sqrt((prev[c].rms[a] * prev[c].rms[a] + prev[c].rms[b] * prev[c].rms[b]) / 2);
      }
      next.push({ min: mn, max: mx, rms: rm });
    }
    grid.push(next);
    levels.push({ peaksPerSecond: levels[l].peaksPerSecond / 2, channels });
  }
  return { grid, levels };
}

function keyFor(source) {
  const info = statSync(source);
  return createHash('sha1').update(`${source}|${info.mtimeMs}|${info.size}`).digest('hex');
}

// Returns {channels, levels:[{level,peaksPerSecond,peakCount}]} and records where
// the binary block lives (caller reads slices). Throws Error('not_ready') when
// the source has no audio or cannot be decoded.
export function ensureWaveform(cacheRoot, source) {
  if (!existsSync(source)) return Promise.reject(new Error('not_ready'));
  const key = keyFor(source);
  const metaPath = join(cacheRoot, `wave-${key}.json`);
  const binPath = join(cacheRoot, `wave-${key}.bin`);
  if (existsSync(metaPath) && existsSync(binPath)) return Promise.resolve(JSON.parse(readFileSync(metaPath, 'utf8')));
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  const work = (async () => {
    mkdirSync(cacheRoot, { recursive: true });
    try { for (const entry of readdirSync(cacheRoot)) { const full = join(cacheRoot, entry); const st = statSync(full); if (st.mtimeMs < Date.now() - 30 * 24 * 3600 * 1000) rmSync(full, { force: true }); } } catch {}
    const info = await ffprobeAudio(source);
    if (!info) throw new Error('not_ready'); // silent media: honest no-waveform
    const pcm = await decodeStream(source);
    if (!pcm.length) throw new Error('not_ready');
    const { grid, levels } = buildLevels(pcm, info);
    // binary: for each level, for each channel, for each peak: min i16, max i16, rms u16
    const chunks = [];
    const meta = { file: binPath, sampleRate: info.sampleRate, channels: info.channels, levels: [] };
    for (let l = 0; l < grid.length; l++) {
      for (let c = 0; c < info.channels; c++) {
        const { min, max, rms } = grid[l][c];
        const buf = Buffer.alloc(min.length * 6);
        for (let p = 0; p < min.length; p++) {
          buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(min[p] * 32767))), p * 6);
          buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(max[p] * 32767))), p * 6 + 2);
          buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(rms[p] * 65535))), p * 6 + 4);
        }
        chunks.push(buf);
      }
      meta.levels.push({ level: l, peaksPerSecond: levels[l].peaksPerSecond, peakCount: grid[l][0].min.length });
    }
    writeFileSync(binPath + '.tmp', Buffer.concat(chunks));
    writeFileSync(metaPath + '.tmp', JSON.stringify(meta));
    // .tmp then rename keeps concurrent readers seeing a whole file or none
    renameSync(binPath + '.tmp', binPath); renameSync(metaPath + '.tmp', metaPath);
    return meta;
  })();
  const guarded = work.finally(() => INFLIGHT.delete(key));
  INFLIGHT.set(key, guarded);
  return guarded;
}

// offsets computed from the meta's own peakCounts (levels then channels)
export function readWaveformTile(meta, level, channel, startPeak, count) {
  const bin = readFileSync(meta.file);
  const rows = []; // [level][channel] = {start,n}
  let off = 0;
  for (const lv of meta.levels) {
    const row = [];
    for (let c = 0; c < meta.channels; c++) { row.push({ start: off, n: lv.peakCount }); off += lv.peakCount * 6; }
    rows.push(row);
  }
  const l = Math.max(0, Math.min(meta.levels.length - 1, Number(level) || 0));
  const c = Math.max(0, Math.min(meta.channels - 1, Number(channel) || 0));
  const { start, n } = rows[l][c];
  const from = Math.max(0, Math.min(n, Number(startPeak) || 0));
  const take = Math.max(0, Math.min(n - from, Number(count) || 0));
  const min = new Array(take); const max = new Array(take); const rms = new Array(take);
  for (let p = 0; p < take; p++) {
    const at = start + (from + p) * 6;
    min[p] = Math.round(bin.readInt16LE(at) / 32767 * 1e4) / 1e4;
    max[p] = Math.round(bin.readInt16LE(at + 2) / 32767 * 1e4) / 1e4;
    rms[p] = Math.round(bin.readUInt16LE(at + 4) / 65535 * 1e4) / 1e4;
  }
  return { peaksPerSecond: meta.levels[l].peaksPerSecond, min, max, rms };
}
