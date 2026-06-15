import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/version.js';

describe('smoke', () => {
  it('toolchain compiles and runs TS', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
