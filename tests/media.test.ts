import { describe, it, expect } from 'vitest';
import { extractMediaFile, buildMediaPrompt, mediaDestPath } from '../src/media.js';

describe('extractMediaFile', () => {
  it('picks the largest PhotoSize for a photo message', () => {
    const m = {
      photo: [
        { file_id: 'small', file_unique_id: 'u1', width: 90, height: 90 },
        { file_id: 'big', file_unique_id: 'u2', width: 1280, height: 1280 },
      ],
      caption: 'look at this',
    };
    const f = extractMediaFile(m)!;
    expect(f.kind).toBe('photo');
    expect(f.fileId).toBe('big');
    expect(f.fileName).toMatch(/\.jpg$/);
    expect(f.isAudio).toBe(false);
    expect(f.caption).toBe('look at this');
  });

  it('uses the document file_name and mime type', () => {
    const f = extractMediaFile({ document: { file_id: 'd1', file_name: 'Q3 Report.pdf', mime_type: 'application/pdf' } })!;
    expect(f.kind).toBe('document');
    expect(f.fileId).toBe('d1');
    expect(f.fileName).toBe('Q3 Report.pdf');
    expect(f.mimeType).toBe('application/pdf');
    expect(f.isAudio).toBe(false);
  });

  it('marks voice messages as audio and defaults to .ogg', () => {
    const f = extractMediaFile({ voice: { file_id: 'v1', mime_type: 'audio/ogg', duration: 5 } })!;
    expect(f.kind).toBe('voice');
    expect(f.isAudio).toBe(true);
    expect(f.fileName).toMatch(/\.ogg$/);
  });

  it('marks audio files as audio and keeps their name', () => {
    const f = extractMediaFile({ audio: { file_id: 'a1', file_name: 'song.mp3', mime_type: 'audio/mpeg' } })!;
    expect(f.kind).toBe('audio');
    expect(f.isAudio).toBe(true);
    expect(f.fileName).toBe('song.mp3');
  });

  it('handles video and video_note', () => {
    expect(extractMediaFile({ video: { file_id: 'vid1', mime_type: 'video/mp4' } })!.kind).toBe('video');
    expect(extractMediaFile({ video_note: { file_id: 'vn1' } })!.kind).toBe('video_note');
  });

  it('returns null for a text-only message', () => {
    expect(extractMediaFile({ text: 'hello' })).toBeNull();
  });
});

describe('buildMediaPrompt', () => {
  it('tells the agent to open a file by path for images/docs', () => {
    const p = buildMediaPrompt({
      kind: 'document',
      userId: 42,
      localPath: '/home/agent/incoming/12-report.pdf',
      caption: 'summarize this',
    });
    expect(p).toContain('42');
    expect(p).toContain('/home/agent/incoming/12-report.pdf');
    expect(p).toContain('summarize this');
    // must not claim to have a transcript for a non-audio file
    expect(p.toLowerCase()).not.toContain('transcript');
  });

  it('embeds the transcript for a successfully transcribed voice message', () => {
    const p = buildMediaPrompt({
      kind: 'voice',
      userId: 7,
      localPath: '/home/agent/incoming/9-voice.ogg',
      transcript: 'please remind me tomorrow at 9',
    });
    expect(p.toLowerCase()).toContain('transcript');
    expect(p).toContain('please remind me tomorrow at 9');
  });

  it('acknowledges audio it could not transcribe instead of pretending', () => {
    const p = buildMediaPrompt({
      kind: 'voice',
      userId: 7,
      localPath: '/home/agent/incoming/9-voice.ogg',
      transcribeError: 'whisper exited 1',
    });
    expect(p.toLowerCase()).toContain('could not');
    expect(p).not.toContain('whisper exited 1'); // internal detail, not shown verbatim in the user-facing instruction body
  });
});

describe('mediaDestPath', () => {
  it('namespaces by update id and sanitizes the filename', () => {
    const p = mediaDestPath('/home/agent', 55, 'Q3 Report.pdf');
    expect(p.startsWith('/home/agent/incoming/')).toBe(true);
    expect(p).toContain('55-');
    expect(p).toMatch(/Q3_Report\.pdf$/);
    expect(p).not.toContain(' ');
  });

  it('strips path traversal from a malicious filename', () => {
    const p = mediaDestPath('/home/agent', 1, '../../etc/passwd');
    expect(p).not.toContain('..');
    expect(p.startsWith('/home/agent/incoming/')).toBe(true);
  });
});
