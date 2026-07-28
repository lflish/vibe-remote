import { describe, it, expect } from 'vitest';
import { makeLineSplitter } from './lines';

describe('makeLineSplitter', () => {
  it('单帧多行 → 逐行回调', () => {
    const out: string[] = [];
    const split = makeLineSplitter((l) => out.push(l));
    split('a\nb\nc\n');
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('一行跨多帧 → 缓冲到完整才回调', () => {
    const out: string[] = [];
    const split = makeLineSplitter((l) => out.push(l));
    split('hel');
    split('lo wor');
    expect(out).toEqual([]); // 尚无 '\n'
    split('ld\n');
    expect(out).toEqual(['hello world']);
  });

  it('结尾无换行的残段留在缓冲区', () => {
    const out: string[] = [];
    const split = makeLineSplitter((l) => out.push(l));
    split('done\npartial');
    expect(out).toEqual(['done']);
  });
});
