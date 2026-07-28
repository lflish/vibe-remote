import { describe, it, expect } from 'vitest';
import { computeLineDiff, diffFromToolInput } from './diff';

describe('computeLineDiff', () => {
  it('全相同 → 全 context 行', () => {
    const rows = computeLineDiff('a\nb', 'a\nb');
    expect(rows.map((r) => r.kind)).toEqual(['context', 'context']);
    expect(rows[0]).toMatchObject({ left: 'a', right: 'a', leftNo: 1, rightNo: 1 });
  });

  it('纯新增（Write：空 → 内容）', () => {
    const rows = computeLineDiff('', 'x\ny');
    expect(rows.map((r) => r.kind)).toEqual(['add', 'add']);
    expect(rows[0]).toMatchObject({ right: 'x', rightNo: 1 });
    expect(rows[1]).toMatchObject({ right: 'y', rightNo: 2 });
  });

  it('一行替换 → 一删一增', () => {
    const rows = computeLineDiff('hello\nworld', 'hello\nthere');
    expect(rows.map((r) => r.kind)).toEqual(['context', 'del', 'add']);
    expect(rows.find((r) => r.kind === 'del')).toMatchObject({ left: 'world' });
    expect(rows.find((r) => r.kind === 'add')).toMatchObject({ right: 'there' });
  });

  it('行号在增删后仍各自连续', () => {
    const rows = computeLineDiff('a\nb\nc', 'a\nx\nc');
    const ctx = rows.filter((r) => r.kind === 'context');
    expect(ctx[0]).toMatchObject({ leftNo: 1, rightNo: 1 });
    expect(ctx[1]).toMatchObject({ leftNo: 3, rightNo: 3 });
  });
});

describe('diffFromToolInput', () => {
  it('Write → 空到 content', () => {
    expect(diffFromToolInput('Write', { file_path: '/a', content: 'hi' })).toEqual({ oldText: '', newText: 'hi' });
  });

  it('Edit → old_string/new_string', () => {
    expect(diffFromToolInput('Edit', { file_path: '/a', old_string: 'a', new_string: 'b' })).toEqual({ oldText: 'a', newText: 'b' });
  });

  it('MultiEdit → 拼接多段', () => {
    const r = diffFromToolInput('MultiEdit', { file_path: '/a', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] });
    expect(r).toEqual({ oldText: 'a\nc', newText: 'b\nd' });
  });

  it('非编辑类工具（Bash）返回 null', () => {
    expect(diffFromToolInput('Bash', { command: 'ls' })).toBeNull();
  });
});
