import { describe, it, expect } from 'vitest';
import { buildFfmpegArgs, buildWhisperArgs, cleanTranscript, transcribeAudio } from '../src/transcribe.js';

describe('buildFfmpegArgs', () => {
  it('decodes to 16 kHz mono PCM WAV (what whisper.cpp requires)', () => {
    const args = buildFfmpegArgs('/in/voice.ogg', '/tmp/voice.wav');
    expect(args).toContain('/in/voice.ogg');
    expect(args).toContain('/tmp/voice.wav');
    expect(args).toContain('-ar');
    expect(args).toContain('16000');
    expect(args).toContain('-ac');
    expect(args).toContain('1');
    // overwrite without prompting so it never hangs
    expect(args).toContain('-y');
  });
});

describe('buildWhisperArgs', () => {
  it('passes the model, the wav, and no-timestamps for clean stdout', () => {
    const args = buildWhisperArgs({ modelPath: '/m/turbo.bin', wavPath: '/tmp/v.wav' });
    expect(args).toContain('-m');
    expect(args).toContain('/m/turbo.bin');
    expect(args).toContain('-f');
    expect(args).toContain('/tmp/v.wav');
    expect(args).toContain('-nt'); // no timestamps
  });

  it('sets the language when given, and leaves whisper to auto-detect otherwise', () => {
    expect(buildWhisperArgs({ modelPath: 'm', wavPath: 'w', language: 'ru' })).toContain('ru');
    const auto = buildWhisperArgs({ modelPath: 'm', wavPath: 'w' });
    const li = auto.indexOf('-l');
    // when auto, either no -l flag or -l auto — never a stale fixed language
    if (li !== -1) expect(auto[li + 1]).toBe('auto');
  });
});

describe('cleanTranscript', () => {
  it('trims whitespace and collapses blank lines', () => {
    expect(cleanTranscript('  hello there \n\n')).toBe('hello there');
  });

  it('drops whisper non-speech markers so silence becomes empty', () => {
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
    expect(cleanTranscript('(silence)')).toBe('');
    expect(cleanTranscript('[MUSIC]\n[BLANK_AUDIO]')).toBe('');
  });

  it('keeps real speech even when a marker is mixed in', () => {
    expect(cleanTranscript('[MUSIC]\nplease call me back')).toBe('please call me back');
  });
});

describe('transcribeAudio', () => {
  const okRun = async (cmd: string) => {
    if (cmd.includes('ffmpeg')) return { stdout: '', stderr: '', code: 0 };
    return { stdout: 'remind me tomorrow at nine\n', stderr: 'whisper: loading model...', code: 0 };
  };

  it('returns the cleaned transcript on success', async () => {
    const text = await transcribeAudio('/in/voice.ogg', {
      whisperBin: 'whisper-cli',
      modelPath: '/m/turbo.bin',
      workDir: '/tmp',
      run: okRun,
    });
    expect(text).toBe('remind me tomorrow at nine');
  });

  it('throws when ffmpeg fails so the caller can fall back gracefully', async () => {
    const run = async (cmd: string) =>
      cmd.includes('ffmpeg')
        ? { stdout: '', stderr: 'Invalid data found', code: 1 }
        : { stdout: '', stderr: '', code: 0 };
    await expect(
      transcribeAudio('/in/bad.ogg', { whisperBin: 'whisper-cli', modelPath: '/m/turbo.bin', workDir: '/tmp', run }),
    ).rejects.toThrow(/ffmpeg/i);
  });

  it('throws when whisper fails', async () => {
    const run = async (cmd: string) =>
      cmd.includes('ffmpeg')
        ? { stdout: '', stderr: '', code: 0 }
        : { stdout: '', stderr: 'model not found', code: 1 };
    await expect(
      transcribeAudio('/in/voice.ogg', { whisperBin: 'whisper-cli', modelPath: '/missing.bin', workDir: '/tmp', run }),
    ).rejects.toThrow(/whisper/i);
  });
});
