import { join } from 'node:path';

/**
 * The non-text Telegram message types this runtime ingests. `voice`/`audio` are
 * the two that need speech-to-text (see transcribe.ts); the rest are handed to
 * the agent as a local file path for its Read tool / document skills to open.
 */
export type MediaKind = 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'video_note';

export interface MediaFile {
  kind: MediaKind;
  /** Telegram file_id — resolve to a download URL via getFile. */
  fileId: string;
  /** Suggested local filename, always with an extension. */
  fileName: string;
  mimeType?: string;
  /** True for voice/audio — the runtime transcribes these before enqueueing. */
  isAudio: boolean;
  /** The message caption, if any. */
  caption?: string;
}

/** Minimal shape of the Telegram message fields we read; anything present wins in a fixed priority. */
interface TgFileMessage {
  photo?: Array<{ file_id: string }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  voice?: { file_id: string; mime_type?: string };
  audio?: { file_id: string; file_name?: string; mime_type?: string };
  video?: { file_id: string; file_name?: string; mime_type?: string };
  video_note?: { file_id: string };
  caption?: string;
  text?: string;
}

/**
 * Pull the single downloadable file out of a Telegram message, normalized.
 * Returns null when the message carries no supported media (e.g. text-only).
 * A message can technically hold more than one media field; Telegram only ever
 * populates one of these per message, so first-match order is unambiguous.
 */
export function extractMediaFile(message: TgFileMessage): MediaFile | null {
  const caption = message.caption;
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    // PhotoSize array is ordered smallest→largest; the last is the highest resolution.
    const largest = message.photo[message.photo.length - 1];
    return { kind: 'photo', fileId: largest.file_id, fileName: 'photo.jpg', mimeType: 'image/jpeg', isAudio: false, caption };
  }
  if (message.document) {
    const d = message.document;
    return { kind: 'document', fileId: d.file_id, fileName: d.file_name || 'document', mimeType: d.mime_type, isAudio: false, caption };
  }
  if (message.voice) {
    return { kind: 'voice', fileId: message.voice.file_id, fileName: 'voice.ogg', mimeType: message.voice.mime_type || 'audio/ogg', isAudio: true, caption };
  }
  if (message.audio) {
    const a = message.audio;
    return { kind: 'audio', fileId: a.file_id, fileName: a.file_name || 'audio.mp3', mimeType: a.mime_type, isAudio: true, caption };
  }
  if (message.video) {
    const v = message.video;
    return { kind: 'video', fileId: v.file_id, fileName: v.file_name || 'video.mp4', mimeType: v.mime_type, isAudio: false, caption };
  }
  if (message.video_note) {
    return { kind: 'video_note', fileId: message.video_note.file_id, fileName: 'video_note.mp4', mimeType: 'video/mp4', isAudio: false, caption };
  }
  return null;
}

/** Sanitize a Telegram-supplied filename into a safe basename (no path parts, no spaces). */
function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() || 'file';
  const cleaned = base.replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned.replace(/^\.+/, '') || 'file';
}

/**
 * Absolute path a downloaded Telegram file should be written to, under the agent's
 * `incoming/` dir. Namespaced by update id so concurrent/duplicate files never collide,
 * and the filename is sanitized so a hostile name can't escape the directory.
 */
export function mediaDestPath(agentHome: string, updateId: number, fileName: string): string {
  return join(agentHome, 'incoming', `${updateId}-${sanitizeFilename(fileName)}`);
}

export interface MediaPromptArgs {
  kind: MediaKind;
  userId: number;
  localPath: string;
  caption?: string;
  /** Present when an audio file was transcribed successfully. */
  transcript?: string;
  /** Present when audio transcription was attempted but failed (internal detail — not surfaced verbatim). */
  transcribeError?: string;
}

/**
 * Build the task prompt for a media message. Mirrors worker.effectivePrompt's
 * "[Message from Telegram user N]" framing so the agent knows who is asking, then
 * hands it either a file path to open (images/PDF/office docs) or the audio transcript.
 */
export function buildMediaPrompt(a: MediaPromptArgs): string {
  const who = `[Message from Telegram user ${a.userId}]`;
  const cap = a.caption ? `\nThe user's caption: "${a.caption}"` : '';

  if (a.kind === 'voice' || a.kind === 'audio') {
    if (a.transcript && a.transcript.trim()) {
      return (
        `${who}\n\nThe user sent a ${a.kind} message. It was auto-transcribed (speech-to-text, ` +
        `so it may contain small errors). Treat the transcript as if they had typed it, and reply to it.` +
        `${cap}\n\nTranscript:\n"""\n${a.transcript.trim()}\n"""`
      );
    }
    return (
      `${who}\n\nThe user sent a ${a.kind} message but it could not be transcribed ` +
      `(the audio may be empty, too noisy, or in an unsupported form). Briefly let them know you ` +
      `couldn't make out the audio and ask them to resend or type it.${cap}`
    );
  }

  return (
    `${who}\n\nThe user sent a ${a.kind} file, saved locally at:\n${a.localPath}\n\n` +
    `Open it to see its contents — use your Read tool for images and PDFs, or the matching ` +
    `document skill (docx/xlsx/pptx) for Office files — then respond to what it contains.${cap}`
  );
}
