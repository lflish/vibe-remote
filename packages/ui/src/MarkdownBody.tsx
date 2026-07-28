import { renderMarkdown } from './markdown';

// 渲染 assistant markdown 文本。
// 安全约束：renderMarkdown 内部已用 DOMPurify.sanitize 消毒，故此处 innerHTML 安全。
// ⚠️ 切勿改成直接注入未经 renderMarkdown 的字符串——那会引入 XSS。
export function MarkdownBody({ text }: { text: string }) {
  return <div className="vr-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
