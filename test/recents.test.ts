import { describe, it, expect } from 'vitest';
import { computeRecents } from '../src/main/recents';

describe('computeRecents', () => {
  it('dedupes by path, newest first, caps at 20', () => {
    let list = computeRecents([], 'C:\\a', 1000);
    list = computeRecents(list, 'C:\\b', 2000);
    list = computeRecents(list, 'C:\\a', 3000); // re-open a
    expect(list.map(r => r.path)).toEqual(['C:\\a', 'C:\\b']);
    expect(list[0].lastOpened).toBe(3000);

    let big: typeof list = [];
    for (let i = 0; i < 25; i++) big = computeRecents(big, `C:\\p${i}`, i);
    expect(big.length).toBe(20);
    expect(big[0].path).toBe('C:\\p24');
  });
});
