// 行级 diff：把 Edit/Write 工具的 old/new 文本计算成并排（split）结构，供
// DiffToolCard 渲染。纯逻辑、零 DOM、可单测。
//
// claude 工具 input 形态：
//   Edit:  { file_path, old_string, new_string }
//   Write: { file_path, content }            （视为「空 → content」的全新增）
//   MultiEdit: { file_path, edits: [{old_string,new_string}, ...] }
// 视图层从 tool_use.input 取出 old/new 文本，调用 computeLineDiff 得到行对。

export type DiffRowKind = 'context' | 'add' | 'del';

// 并排 diff 的一行：左（旧）/右（新）任一可空（增/删时）。
export interface DiffRow {
  kind: DiffRowKind;
  left?: string; // 旧文本行（del / context）
  right?: string; // 新文本行（add / context）
  leftNo?: number; // 旧行号（1-based）
  rightNo?: number; // 新行号（1-based）
}

// 经典 LCS 行级 diff。返回按顺序排列的 DiffRow。
export function computeLineDiff(oldText: string, newText: string): DiffRow[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const lcs = lcsTable(a, b);

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let leftNo = 1;
  let rightNo = 1;

  // 回溯 LCS 表生成编辑脚本。
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'context', left: a[i], right: b[j], leftNo: leftNo++, rightNo: rightNo++ });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: 'del', left: a[i], leftNo: leftNo++ });
      i++;
    } else {
      rows.push({ kind: 'add', right: b[j], rightNo: rightNo++ });
      j++;
    }
  }
  while (i < a.length) rows.push({ kind: 'del', left: a[i++], leftNo: leftNo++ });
  while (j < b.length) rows.push({ kind: 'add', right: b[j++], rightNo: rightNo++ });

  return rows;
}

// 从 claude 工具 input 提取 (old, new) 文本对；无法识别返回 null。
export function diffFromToolInput(
  toolName: string,
  input: unknown,
): { oldText: string; newText: string } | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const name = toolName.toLowerCase();

  if (name === 'write') {
    return { oldText: '', newText: typeof o.content === 'string' ? o.content : '' };
  }
  if (name === 'edit') {
    if (typeof o.old_string === 'string' && typeof o.new_string === 'string') {
      return { oldText: o.old_string, newText: o.new_string };
    }
    return null;
  }
  if (name === 'multiedit' && Array.isArray(o.edits)) {
    // 把多段编辑拼成一个整体 old/new 视图（顺序拼接，简化呈现）。
    let oldT = '';
    let newT = '';
    for (const e of o.edits as Array<Record<string, unknown>>) {
      if (typeof e.old_string === 'string') oldT += (oldT ? '\n' : '') + e.old_string;
      if (typeof e.new_string === 'string') newT += (newT ? '\n' : '') + e.new_string;
    }
    return { oldText: oldT, newText: newT };
  }
  return null;
}

function splitLines(s: string): string[] {
  if (s === '') return [];
  // 保留内容行；去掉结尾多余空行造成的末尾空元素。
  const lines = s.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// lcs[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度。
function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  return lcs;
}
