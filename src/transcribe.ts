import { spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { unlink } from 'node:fs/promises';
import { logger } from './log.js';

const log = logger('transcribe');

/** Result of running a subprocess. Injected in tests so the pure logic is exercised without spawning. */
export interface RunResult { stdout: string; stderr: string; code: number }
export type RunCommand = (cmd: string, args: string[]) => Promise<RunResult>;

/** ffmpeg args to decode any input to the 16 kHz mono PCM WAV that whisper.cpp requires. */
export function buildFfmpegArgs(input: string, output: string): string[] {
  return ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output];
}

export interface WhisperArgsOpts {
  modelPath: string;
  wavPath: string;
  /** ISO language code (e.g. 'ru', 'uz', 'en'); omitted → whisper auto-detects. */
  language?: string;
}

/** whisper-cli args: model + wav, no timestamps (so stdout is plain transcript text). */
export function buildWhisperArgs(o: WhisperArgsOpts): string[] {
  return ['-m', o.modelPath, '-f', o.wavPath, '-nt', '-l', o.language || 'auto'];
}

/**
 * Normalize whisper output: trim, collapse blank lines, and drop whisper's
 * non-speech markers (e.g. [BLANK_AUDIO], [MUSIC], (silence)) so that audio with
 * no speech cleanly reduces to an empty string — which the caller treats as
 * "couldn't transcribe" rather than replying to a bracketed noise token.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.trim())
    // a line that is ONLY a bracketed/parenthesized marker is noise, not speech
    .filter((line) => line && !/^[\[(][^\])]*[\])]$/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const defaultRun: RunCommand = (cmd, args) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => resolve({ stdout, stderr: stderr + String(e), code: 127 }));
    p.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });

export interface TranscribeOpts {
  whisperBin: string;
  modelPath: string;
  /** Directory for the temporary decoded WAV. */
  workDir: string;
  ffmpegBin?: string;
  language?: string;
  /** Injected in tests; defaults to a real spawn. */
  run?: RunCommand;
}

/**
 * Transcribe an audio file to text using a local whisper.cpp binary.
 * Pipeline: ffmpeg → 16 kHz mono WAV → whisper-cli → cleaned stdout.
 * Throws on ffmpeg or whisper failure so the caller can fall back to a graceful
 * "couldn't transcribe" message rather than silently dropping the voice note.
 */
export async function transcribeAudio(inputPath: string, opts: TranscribeOpts): Promise<string> {
  const run = opts.run ?? defaultRun;
  const ffmpeg = opts.ffmpegBin ?? 'ffmpeg';
  const wavPath = join(opts.workDir, `${basename(inputPath)}.16k.wav`);

  const ff = await run(ffmpeg, buildFfmpegArgs(inputPath, wavPath));
  if (ff.code !== 0) {
    throw new Error(`ffmpeg failed to decode audio (code ${ff.code}): ${ff.stderr.trim().slice(-300)}`);
  }

  try {
    const w = await run(opts.whisperBin, buildWhisperArgs({ modelPath: opts.modelPath, wavPath, language: opts.language }));
    if (w.code !== 0) {
      throw new Error(`whisper failed to transcribe (code ${w.code}): ${w.stderr.trim().slice(-300)}`);
    }
    const text = cleanTranscript(w.stdout);
    log.info('transcribed audio', { inputPath, chars: text.length });
    return text;
  } finally {
    // Best-effort cleanup of the temp WAV; never let cleanup failure mask the result.
    await unlink(wavPath).catch(() => {});
  }
}
