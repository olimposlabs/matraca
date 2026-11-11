import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  CustomSource,
  EncodedPacketSink,
  Input,
  MP3,
  MP4,
  WAVE,
  WEBM,
} from 'mediabunny';

export type MediaProbeErrorCode =
  | 'INVALID_MEDIA'
  | 'UNSUPPORTED_MEDIA'
  | 'LIMIT_EXCEEDED'
  | 'IO_ERROR'
  | 'ABORTED';

export class MediaProbeError extends Error {
  constructor(public readonly code: MediaProbeErrorCode, message: string) {
    super(message);
    this.name = 'MediaProbeError';
  }
}

export interface MediaProbeOptions {
  maxBytes?: number;
  maxDurationSeconds?: number;
  maxTracks?: number;
  maxPackets?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProbedTrack {
  type: 'audio' | 'video';
  codec: string;
  packetCount: number;
  firstTimestampMicroseconds: number;
  endTimestampMicroseconds: number;
  durationMicroseconds: number;
}

export interface MediaProbeResult {
  container: 'mp4' | 'webm' | 'wav' | 'mp3';
  mimeType: string;
  byteLength: number;
  durationMicroseconds: number;
  durationSeconds: number;
  firstTimestampMicroseconds: number;
  hasAudio: boolean;
  hasVideo: boolean;
  tracks: ProbedTrack[];
}

const DEFAULT_LIMITS = {
  maxBytes: 200 * 1024 * 1024,
  maxDurationSeconds: 300,
  maxTracks: 8,
  maxPackets: 200_000,
  timeoutMs: 15_000,
} as const;

const FORMATS = [MP4, WEBM, WAVE, MP3];
const CONTAINERS = ['mp4', 'webm', 'wav', 'mp3'] as const;
const CACHE_BYTES = 2 * 1024 * 1024;

/**
 * Inspect a finalized, private server-side file. The caller must resolve and
 * authorize its path; this function deliberately accepts no browser metadata.
 * It validates readable encoded packets, not full audio/video decoding.
 */
export async function probeMedia(
  filePath: string,
  options: MediaProbeOptions = {},
): Promise<MediaProbeResult> {
  const limits = { ...DEFAULT_LIMITS, ...options };
  for (const name of Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[]) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (options.signal?.aborted) throw aborted();

  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new MediaProbeError('IO_ERROR', 'Não foi possível abrir a mídia.');
  }

  let input: Input | undefined;
  let interrupted = false;
  const abort = () => {
    interrupted = true;
    input?.dispose();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, limits.timeoutMs);
  timer.unref();

  try {
    const initial = await file.stat();
    if (!initial.isFile() || initial.size === 0) {
      throw new MediaProbeError('INVALID_MEDIA', 'A mídia precisa ser um arquivo não vazio.');
    }
    if (initial.size > limits.maxBytes) throw limit('A mídia excede o tamanho permitido.');
    let bytesRead = 0;
    const read = async (start: number, end: number): Promise<Uint8Array> => {
      if (interrupted || options.signal?.aborted) throw aborted();
      if (start < 0 || end > initial.size || end <= start) throw invalid();
      if (end - start > 8 * 1024 * 1024) throw limit('A mídia requer um bloco de leitura excessivo.');
      bytesRead += end - start;
      if (bytesRead > initial.size * 8 + CACHE_BYTES) {
        throw limit('A mídia excede o orçamento de leitura.');
      }
      const buffer = Buffer.alloc(end - start);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await file.read(buffer, offset, buffer.length - offset, start + offset);
        if (result.bytesRead === 0) throw invalid();
        offset += result.bytesRead;
      }
      return buffer;
    };

    const source = new CustomSource({
      getSize: () => initial.size,
      read,
      maxCacheSize: CACHE_BYTES,
      prefetchProfile: 'none',
    });
    input = new Input({ source, formats: FORMATS });
    if (!(await input.canRead())) {
      throw new MediaProbeError('UNSUPPORTED_MEDIA', 'Formato de mídia não suportado.');
    }
    const format = await input.getFormat();
    const container = CONTAINERS[FORMATS.indexOf(format)];
    if (!container) throw invalid();
    await validateEnvelope(container, initial.size, read);

    const inputTracks = await input.getTracks();
    if (inputTracks.length === 0) throw invalid();
    if (inputTracks.length > limits.maxTracks) throw limit('A mídia contém trilhas demais.');
    const tracks: ProbedTrack[] = [];
    let totalPackets = 0;
    for (const track of inputTracks) {
      if (track.type !== 'audio' && track.type !== 'video') throw invalid();
      const codec = await track.getCodec();
      if (!codec) throw new MediaProbeError('UNSUPPORTED_MEDIA', 'Codec não reconhecido.');
      let start = Infinity;
      let end = -Infinity;
      let packetCount = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        if (interrupted || options.signal?.aborted) throw aborted();
        if (++totalPackets > limits.maxPackets) throw limit('A mídia contém pacotes demais.');
        if (
          !Number.isFinite(packet.timestamp) ||
          !Number.isFinite(packet.duration) ||
          packet.duration < 0 ||
          packet.data.length === 0 ||
          packet.data.length !== packet.byteLength
        ) throw invalid();
        const packetStart = Math.round(packet.timestamp * 1_000_000);
        const packetEnd = Math.round((packet.timestamp + packet.duration) * 1_000_000);
        if (!Number.isSafeInteger(packetStart) || !Number.isSafeInteger(packetEnd)) throw invalid();
        // Negative presentation time belongs to codec priming, not the lesson.
        if (packetEnd <= 0) continue;
        start = Math.min(start, Math.max(0, packetStart));
        end = Math.max(end, packetEnd);
        packetCount++;
        if (end - start > limits.maxDurationSeconds * 1_000_000) {
          throw limit('A mídia excede a duração permitida.');
        }
      }
      if (packetCount === 0 || end <= start) throw invalid();
      tracks.push({
        type: track.type,
        codec,
        packetCount,
        firstTimestampMicroseconds: start,
        endTimestampMicroseconds: end,
        durationMicroseconds: end - start,
      });
    }

    const start = Math.min(...tracks.map((track) => track.firstTimestampMicroseconds));
    const end = Math.max(...tracks.map((track) => track.endTimestampMicroseconds));
    const durationMicroseconds = end - start;
    if (durationMicroseconds > limits.maxDurationSeconds * 1_000_000) {
      throw limit('A mídia excede a duração permitida.');
    }
    const final = await file.stat();
    if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) throw invalid();
    return {
      container,
      mimeType: await input.getMimeType(),
      byteLength: initial.size,
      durationMicroseconds,
      durationSeconds: durationMicroseconds / 1_000_000,
      firstTimestampMicroseconds: start,
      hasAudio: tracks.some((track) => track.type === 'audio'),
      hasVideo: tracks.some((track) => track.type === 'video'),
      tracks,
    };
  } catch (error) {
    if (interrupted || options.signal?.aborted) throw aborted();
    if (error instanceof MediaProbeError) throw error;
    throw invalid();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    input?.dispose();
    await file.close();
  }
}

async function validateEnvelope(
  container: MediaProbeResult['container'],
  size: number,
  read: (start: number, end: number) => Promise<Uint8Array>,
): Promise<void> {
  if (container === 'wav') {
    const header = Buffer.from(await read(0, 12));
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.readUInt32LE(4) + 8 > size) {
      throw invalid();
    }
  }
  if (container === 'mp4') {
    // A parser may salvage a truncated mdat; billing must reject that file.
    let offset = 0;
    while (offset < size) {
      if (offset + 8 > size) throw invalid();
      const header = Buffer.from(await read(offset, offset + 8));
      let boxSize = header.readUInt32BE(0);
      let headerSize = 8;
      if (boxSize === 1) {
        if (offset + 16 > size) throw invalid();
        boxSize = Number(Buffer.from(await read(offset + 8, offset + 16)).readBigUInt64BE());
        headerSize = 16;
      }
      if (boxSize === 0) boxSize = size - offset;
      if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || offset + boxSize > size) {
        throw invalid();
      }
      offset += boxSize;
    }
  }
}

function invalid(): MediaProbeError {
  return new MediaProbeError('INVALID_MEDIA', 'Mídia inválida, incompleta ou sem duração verificável.');
}

function limit(message: string): MediaProbeError {
  return new MediaProbeError('LIMIT_EXCEEDED', message);
}

function aborted(): MediaProbeError {
  return new MediaProbeError('ABORTED', 'A leitura da mídia foi interrompida ou excedeu o tempo limite.');
}
