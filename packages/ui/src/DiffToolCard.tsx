import { computeLineDiff, type DiffRow } from '@vibe-remote/core';

// 并排 diff 视图：消费 core 的 computeLineDiff（纯逻辑）。用于 Edit/Write/MultiEdit
// 工具卡片。左旧右新，增绿删红。
export function DiffToolCard({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = computeLineDiff(oldText, newText);
  return (
    <div className="vr-diff">
      {rows.map((r, i) => (
        <DiffLine key={i} row={r} />
      ))}
    </div>
  );
}

function DiffLine({ row }: { row: DiffRow }) {
  return (
    <div className={`vr-diff-row vr-diff-${row.kind}`}>
      <span className="vr-diff-gutter">{row.leftNo ?? ''}</span>
      <span className="vr-diff-gutter">{row.rightNo ?? ''}</span>
      <span className="vr-diff-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</span>
      <span className="vr-diff-text">{row.kind === 'del' ? row.left : row.right}</span>
    </div>
  );
}
