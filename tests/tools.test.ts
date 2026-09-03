import { describe, it, expect } from 'vitest';
import { resolveRunAt } from '../src/tools.js';

const now = new Date('2026-06-11T10:00:00'); // local time

describe('resolveRunAt', () => {
  it('delay_seconds → now + delay', () => {
    const r = resolveRunAt({ delay_seconds: 60 }, now);
    expect('runAt' in r && new Date(r.runAt).getTime()).toBe(now.getTime() + 60_000);
  });
  it('absolute ISO at is passed through', () => {
    const r = resolveRunAt({ at: '2026-06-11T12:30:00.000Z' }, now);
    expect('runAt' in r && r.runAt).toBe('2026-06-11T12:30:00.000Z');
  });
  it('HH:MM later today → today', () => {
    const r = resolveRunAt({ at: '14:00' }, now) as { runAt: string };
    const d = new Date(r.runAt);
    expect(d.getHours()).toBe(14); expect(d.getMinutes()).toBe(0); expect(d.getDate()).toBe(11);
  });
  it('HH:MM already passed → tomorrow', () => {
    const r = resolveRunAt({ at: '09:00' }, now) as { runAt: string };
    expect(new Date(r.runAt).getDate()).toBe(12);
  });
  it('rejects neither delay_seconds nor at', () => { expect('error' in resolveRunAt({}, now)).toBe(true); });
  it('rejects both', () => { expect('error' in resolveRunAt({ delay_seconds: 60, at: '14:00' }, now)).toBe(true); });
  it('rejects non-positive delay', () => { expect('error' in resolveRunAt({ delay_seconds: 0 }, now)).toBe(true); });
  it('rejects garbage at', () => { expect('error' in resolveRunAt({ at: 'nonsense' }, now)).toBe(true); });
  it('rejects out-of-range HH:MM', () => { expect('error' in resolveRunAt({ at: '99:99' }, now)).toBe(true); });
});

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSendableFile, queueFileForDelivery, MAX_SEND_FILE_BYTES } from '../src/tools.js';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

describe('checkSendableFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sendfile-'));
  const ok = join(dir, 'report.pdf');
  writeFileSync(ok, 'pdf bytes');
  mkdirSync(join(dir, 'sub'));

  it('accepts an existing regular file and reports name + size', () => {
    const r = checkSendableFile(ok);
    expect(r).toEqual({ ok: true, name: 'report.pdf', size: 9 });
  });
  it('rejects a relative path', () => {
    const r = checkSendableFile('report.pdf');
    expect('error' in r && r.error).toMatch(/absolute/i);
  });
  it('rejects a missing file', () => {
    const r = checkSendableFile(join(dir, 'nope.pdf'));
    expect('error' in r && r.error).toMatch(/not found|does not exist/i);
  });
  it('rejects a directory', () => {
    const r = checkSendableFile(join(dir, 'sub'));
    expect('error' in r && r.error).toMatch(/not a (regular )?file|directory/i);
  });
  it('rejects a file over the Bot API upload limit', () => {
    const r = checkSendableFile(ok, { maxBytes: 4 });
    expect('error' in r && r.error).toMatch(/too large|MB/i);
  });
  it('MAX_SEND_FILE_BYTES is the 50 MB Bot API upload cap', () => {
    expect(MAX_SEND_FILE_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe('queueFileForDelivery (send_file tool body)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sendfile2-'));
  const f = join(dir, 'notes.txt');
  writeFileSync(f, 'hello');

  it('enqueues an outbox file row scoped to the requesting task chat', () => {
    const store = new Store(openDb(':memory:'));
    const r = queueFileForDelivery(store, { userId: 1, chatId: 42 }, { path: f, caption: 'my <b>notes</b>' });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/notes\.txt/);
    const [m] = store.unsentMessages();
    expect(m).toMatchObject({ chatId: 42, filePath: f, content: 'my <b>notes</b>' });
  });

  it('returns an error and enqueues nothing for an invalid path', () => {
    const store = new Store(openDb(':memory:'));
    const r = queueFileForDelivery(store, { userId: 1, chatId: 42 }, { path: join(dir, 'missing.txt') });
    expect(r.isError).toBe(true);
    expect(store.unsentMessages()).toEqual([]);
  });

  it('ignores any chat_id-like input: delivery target is always the task chat', () => {
    const store = new Store(openDb(':memory:'));
    queueFileForDelivery(store, { userId: 1, chatId: 42 }, { path: f, chat_id: 999 } as any);
    expect(store.unsentMessages()[0].chatId).toBe(42);
  });
});
