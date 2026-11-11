import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { FilePathSource, Input, WEBM } from 'mediabunny';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeMedia } from '../server/media/probe.ts';

const run = promisify(execFile);
let directory: string;
const path = (name: string) => join(directory, name);

async function generate(name: string, args: string[]) {
  await run(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args, path(name)]);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'matraca-media-'));
  await generate('video.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=1.2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ]);
  await generate('live.webm', [
    '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=1.2',
    '-c:v', 'libvpx', '-deadline', 'realtime', '-live', '1',
  ]);
  await generate('offset.webm', [
    '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=1.2',
    '-c:v', 'libvpx', '-deadline', 'realtime', '-output_ts_offset', '12', '-live', '1',
  ]);
  await generate('audio.wav', [
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=1.25',
    '-c:a', 'pcm_s16le',
  ]);
  await generate('audio.mp3', [
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=1.2',
    '-c:a', 'libmp3lame',
  ]);
  await generate('five-minutes.mp4', [
    '-f', 'lavfi', '-i', 'color=size=32x32:rate=2:duration=300',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ]);
  await generate('mixed.mp4', [
    '-f', 'lavfi', '-i', 'color=size=32x32:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart',
  ]);
  await generate('fraction.wav', [
    '-f', 'lavfi', '-i', 'anullsrc=sample_rate=1000:channel_layout=mono',
    '-t', '60.001', '-c:a', 'pcm_s16le',
  ]);
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('server-side media probe with real encoded files', () => {
  it('reads MP4 packets and detects video without trusting a filename extension', async () => {
    await writeFile(path('misleading.txt'), await readFile(path('video.mp4')));
    const result = await probeMedia(path('misleading.txt'));
    expect(result.container).toBe('mp4');
    expect(result.durationMicroseconds).toBe(1_200_000);
    expect(result.hasVideo).toBe(true);
    expect(result.hasAudio).toBe(false);
    expect(result.tracks[0]?.packetCount).toBe(12);
  });

  it('reads a finalized WebM without a Duration metadata field', async () => {
    const input = new Input({ source: new FilePathSource(path('live.webm')), formats: [WEBM] });
    try {
      expect(await input.getDurationFromMetadata()).toBeNull();
    } finally {
      input.dispose();
    }
    const result = await probeMedia(path('live.webm'));
    expect(result.container).toBe('webm');
    expect(result.durationMicroseconds).toBe(1_200_000);
  });

  it('normalizes positive timestamps instead of charging the leading offset', async () => {
    const result = await probeMedia(path('offset.webm'));
    expect(result.firstTimestampMicroseconds).toBe(12_000_000);
    expect(result.durationMicroseconds).toBe(1_200_000);
  });

  it('reads a real Chromium MediaRecorder capture with no Duration metadata', async () => {
    const recording = fileURLToPath(new URL('./fixtures/media/media-recorder.webm', import.meta.url));
    const input = new Input({ source: new FilePathSource(recording), formats: [WEBM] });
    try {
      expect(await input.getDurationFromMetadata()).toBeNull();
    } finally {
      input.dispose();
    }
    const result = await probeMedia(recording);
    expect(result.container).toBe('webm');
    expect(result.hasVideo).toBe(true);
    expect(result.tracks[0]?.codec).toBe('vp8');
    // The fixture records a synthetic canvas for 1.1 s; allow frame scheduling jitter.
    expect(result.durationSeconds).toBeGreaterThan(1);
    expect(result.durationSeconds).toBeLessThan(1.3);
  });

  it('measures five minutes from actual video samples', async () => {
    const result = await probeMedia(path('five-minutes.mp4'));
    expect(result.durationMicroseconds).toBe(300_000_000);
    expect(result.tracks[0]?.packetCount).toBe(600);
  });

  it('uses the full presentation span across audio and video tracks', async () => {
    const result = await probeMedia(path('mixed.mp4'));
    expect(result.hasAudio).toBe(true);
    expect(result.hasVideo).toBe(true);
    expect(result.durationMicroseconds).toBe(2_000_000);
    expect(result.tracks.find((track) => track.type === 'video')?.durationMicroseconds).toBe(1_000_000);
  });

  it('reads audio-only WAV and MP3 without decoder or external services', async () => {
    const wave = await probeMedia(path('audio.wav'));
    const mp3 = await probeMedia(path('audio.mp3'));
    expect(wave.durationMicroseconds).toBe(1_250_000);
    expect(wave.hasAudio).toBe(true);
    expect(wave.hasVideo).toBe(false);
    expect(mp3.container).toBe('mp3');
    expect(mp3.hasAudio).toBe(true);
    // MP3 includes whole encoded frames; it need not equal the source PCM length.
    expect(mp3.durationSeconds).toBeGreaterThanOrEqual(1.2);
    expect(mp3.durationSeconds).toBeLessThan(1.4);
  });

  it('preserves a positive fraction beyond a minute for later credit accounting', async () => {
    expect((await probeMedia(path('fraction.wav'))).durationMicroseconds).toBe(60_001_000);
  });

  it('ignores forged global MP4 duration metadata', async () => {
    const data = await readFile(path('video.mp4'));
    const mvhd = data.indexOf(Buffer.from('mvhd'));
    expect(mvhd).toBeGreaterThan(0);
    expect(data[mvhd + 4]).toBe(0); // Version zero, generated by this test.
    data.writeUInt32BE(999_999, mvhd + 20);
    await writeFile(path('forged.mp4'), data);
    expect((await probeMedia(path('forged.mp4'))).durationMicroseconds).toBe(1_200_000);
  });

  it.each(['video.mp4', 'live.webm', 'audio.wav'])('rejects truncated %s', async (name) => {
    const data = await readFile(path(name));
    const damaged = path(`truncated-${name}`);
    await writeFile(damaged, data.subarray(0, Math.floor(data.length * 0.7)));
    await expect(probeMedia(damaged)).rejects.toMatchObject({ code: 'INVALID_MEDIA' });
  });

  it('rejects empty and unsupported files', async () => {
    await writeFile(path('empty'), '');
    await writeFile(path('text'), 'This is not a video or audio file.');
    await expect(probeMedia(path('empty'))).rejects.toMatchObject({ code: 'INVALID_MEDIA' });
    await expect(probeMedia(path('text'))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
  });

  it('enforces byte, duration, packet and track limits', async () => {
    await expect(probeMedia(path('video.mp4'), { maxBytes: 8 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(probeMedia(path('video.mp4'), { maxDurationSeconds: 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(probeMedia(path('video.mp4'), { maxPackets: 3 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(probeMedia(path('mixed.mp4'), { maxTracks: 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('cancels before opening and hides filesystem details on failure', async () => {
    await expect(probeMedia(path('video.mp4'), { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(probeMedia(path('missing'))).rejects.toMatchObject({ code: 'IO_ERROR', message: 'Não foi possível abrir a mídia.' });
  });
});
