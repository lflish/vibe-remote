import { useState } from 'react';
import { diffFromToolInput } from '@vibe-remote/core';
import type { Part } from '@vibe-remote/core';
import { DiffToolCard } from './DiffToolCard';

// 工具调用卡片：折叠头（工具名 + 参数摘要 + 状态点），展开显示 input / diff / 结果。
// 编辑类工具（Edit/Write/MultiEdit）展开显示并排 diff；其它显示 input JSON + 结果文本。
export function ToolCard({ part }: { part: Extract<Part, { type: 'tool_use' }> }) {
  const [open, setOpen] = useState(false);
  const result = part.result;
  const pending = !result;
  const isError = result?.isError === true;
  const statusClass = pending ? 'vr-tool-pending' : isError ? 'vr-tool-error' : 'vr-tool-ok';

  const diff = diffFromToolInput(part.name, part.input);
  const summary = toolSummary(part.input);

  return (
    <div className={`vr-tool ${statusClass}`}>
      <button className="vr-tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="vr-tool-caret">{open ? '▾' : '▸'}</span>
        <span className="vr-tool-name">{part.name}</span>
        {summary && <span className="vr-tool-summary">{summary}</span>}
        <span className="vr-tool-status">{pending ? '运行中…' : isError ? '失败' : '完成'}</span>
      </button>
      {open && (
        <div className="vr-tool-body">
          {diff ? (
            <DiffToolCard oldText={diff.oldText} newText={diff.newText} />
          ) : (
            <pre className="vr-tool-input">{safeStringify(part.input)}</pre>
          )}
          {result && <pre className="vr-tool-result">{result.content}</pre>}
        </div>
      )}
    </div>
  );
}

// 从工具 input 里挑一个最显著的参数做摘要（best-effort）。
function toolSummary(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'description']) {
    const v = o[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
