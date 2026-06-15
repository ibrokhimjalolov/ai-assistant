import { describe, it, expect } from 'vitest';
import { escapeHtml, htmlToPlain } from '../src/format.js';

describe('escapeHtml', () => {
  it('escapes &, <, > so runtime text is safe inside an HTML message', () => {
    expect(escapeHtml('1 < 2 & 3 > 0')).toBe('1 &lt; 2 &amp; 3 &gt; 0');
  });

  it('escapes & before < and > (no double-escaping)', () => {
    expect(escapeHtml('<tag>')).toBe('&lt;tag&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('just text')).toBe('just text');
  });
});

describe('htmlToPlain', () => {
  it('strips tags so a rejected HTML message still delivers readable text', () => {
    expect(htmlToPlain('<b>hi</b>')).toBe('hi');
  });

  it('keeps link text and drops the anchor markup', () => {
    expect(htmlToPlain('<a href="https://x.io">link</a>')).toBe('link');
  });

  it('unescapes HTML entities back to literal characters', () => {
    expect(htmlToPlain('a &lt;tag&gt; &amp; b')).toBe('a <tag> & b');
  });

  it('turns <br> and block-closing tags into newlines', () => {
    expect(htmlToPlain('line1<br>line2')).toBe('line1\nline2');
  });

  it('returns empty and plain strings unchanged', () => {
    expect(htmlToPlain('')).toBe('');
    expect(htmlToPlain('plain text')).toBe('plain text');
  });
});
