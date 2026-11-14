// Tool blocks (R4): one collapsible block per tool_use, with a one-line
// summary, the input and output, and a line diff for Edit / Write /
// MultiEdit. Everything here is tool input/output, so it is set with
// textContent only — never parsed as markup.

import { t } from '../i18n';
import { computeLineDiff, diffFromToolInput } from './diff';
import { summarizePermissionInput } from './permission';
import type { Part } from './types';

type ToolUse = Extract<Part, { type: 'tool_use' }>;

export type ToolStatus = 'running' | 'ok' | 'error' | 'pending';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function chevron(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('class', 'chev');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'm7 5 5 5-5 5');
  svg.appendChild(p);
  return svg;
}

function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function str(input: unknown, key: string): string {
  if (input && typeof input === 'object') {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return '';
}

function row(label: string, text: string): HTMLElement {
  const r = el('div', 'trow');
  r.append(el('span', 'lb', label), el('pre', undefined, text));
  return r;
}

function inputText(tool: ToolUse): string {
  const name = tool.name.toLowerCase();
  if (name === 'bash') return str(tool.input, 'command');
  try {
    return JSON.stringify(tool.input ?? {}, null, 2);
  } catch {
    return '';
  }
}

/** Status of a tool block: waiting for permission, running, done, failed. */
export function toolStatus(tool: ToolUse, pending: boolean): ToolStatus {
  if (tool.result) return tool.result.isError ? 'error' : 'ok';
  return pending ? 'pending' : 'running';
}

/** The diff view for an edit tool, or null for other tools. */
export function renderDiff(toolName: string, input: unknown): HTMLElement | null {
  const pair = diffFromToolInput(toolName, input);
  if (!pair) return null;
  const box = el('div', 'diff');
  box.dataset.testid = 'chat-diff';
  for (const r of computeLineDiff(pair.oldText, pair.newText)) {
    const line = el('div', `dl${r.kind === 'context' ? '' : ` ${r.kind}`}`);
    const no = r.kind === 'del' ? r.leftNo : r.rightNo;
    line.append(
      el('span', 'n', no ? String(no) : ''),
      el('span', 's', r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '),
      el('span', 'x', (r.kind === 'del' ? r.left : r.right) ?? ''),
    );
    box.appendChild(line);
  }
  return box;
}

function diffStat(toolName: string, input: unknown): string {
  const pair = diffFromToolInput(toolName, input);
  if (!pair) return '';
  let add = 0;
  let del = 0;
  for (const r of computeLineDiff(pair.oldText, pair.newText)) {
    if (r.kind === 'add') add++;
    else if (r.kind === 'del') del++;
  }
  return t('chat.tool.diffStat', { add, del });
}

/**
 * Renders one tool block. Read / Grep and other tools start collapsed (R4.1);
 * Bash shows its command in the summary (R4.2); edits show the path and an
 * open diff (R4.3); a failed result is marked and shown (R4.4).
 */
export function renderToolBlock(tool: ToolUse, pending: boolean, open?: boolean): HTMLElement {
  const status = toolStatus(tool, pending);
  const name = tool.name;
  const lower = name.toLowerCase();
  const wrap = el('div', `ti ${status === 'ok' ? 'ok' : status === 'error' ? 'err' : 'pend'}`);
  const details = el('details', 'tool');
  details.dataset.testid = 'chat-tool';
  details.dataset.tool = name;
  details.dataset.status = status;
  details.dataset.toolUseId = tool.id;

  const summary = el('summary');
  summary.append(chevron(), el('span', 'tn', name));
  const path = str(tool.input, 'file_path') || str(tool.input, 'notebook_path');
  const isEdit = lower === 'edit' || lower === 'write' || lower === 'multiedit';
  if (lower === 'bash') {
    const desc = str(tool.input, 'description');
    summary.appendChild(el('span', 't2', str(tool.input, 'command')));
    if (desc) summary.appendChild(el('span', 't2p', desc));
  } else if (path) {
    const p = el('span', 't2', baseName(path));
    p.title = path;
    summary.appendChild(p);
  } else {
    summary.appendChild(el('span', 't2', summarizePermissionInput(name, tool.input)));
  }
  let meta = '';
  let metaCls = 'tm';
  if (status === 'pending') meta = t('chat.tool.waiting');
  else if (status === 'running') meta = t('chat.tool.running');
  else if (status === 'error') {
    meta = t('chat.tool.failed');
    metaCls = 'tm bad';
  } else if (isEdit) {
    meta = diffStat(name, tool.input);
    metaCls = 'tm good';
  }
  if (meta) summary.appendChild(el('span', metaCls, meta));
  details.appendChild(summary);

  const diff = isEdit ? renderDiff(name, tool.input) : null;
  if (diff) details.appendChild(diff);
  else details.appendChild(row(t('chat.tool.input'), inputText(tool)));
  if (tool.result) details.appendChild(row(t('chat.tool.output'), tool.result.content));

  // Edits and failures start open; reads, searches and commands start folded.
  details.open = open ?? (isEdit || status === 'error');
  wrap.appendChild(details);
  return wrap;
}
