import { describe, it, expect } from 'vitest';
import { slugForPath, parseSession } from '../src/main/sessions';

describe('slugForPath', () => {
  it('replaces every non-alphanumeric char with a dash', () => {
    expect(slugForPath('C:\\Users\\danma\\Documents\\Dan\\Projects\\Claude Explorer'))
      .toBe('C--Users-danma-Documents-Dan-Projects-Claude-Explorer');
  });
});

describe('parseSession', () => {
  it('extracts first user prompt as title and newest timestamp', () => {
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-07-20T10:00:00.000Z', message: { role: 'user', content: 'Fix the login bug' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-07-20T10:01:00.000Z', message: { role: 'assistant', content: 'ok' } }),
    ].join('\n');
    const s = parseSession('abc-123', 'C:\\proj', lines, 0);
    expect(s.id).toBe('abc-123');
    expect(s.title).toBe('Fix the login bug');
    expect(s.updated).toBe(Date.parse('2026-07-20T10:01:00.000Z'));
  });

  it('falls back to (untitled) and mtime when no user text present', () => {
    const s = parseSession('x', 'C:\\p', '', 5000);
    expect(s.title).toBe('(untitled)');
    expect(s.updated).toBe(5000);
  });
});
