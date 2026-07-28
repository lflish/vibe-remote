import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

// assistant 文本是 claude 官方 markdown 输出，渲染成 HTML（代码块/列表可读），
// 再经 DOMPurify 消毒后才 touch innerHTML。这是对官方模型输出的展示层格式化，
// 非 TUI 解析。user/tool 文本不走这里（用纯文本转义）。
// 从 mobile/src/render.ts 上提到共享 ui 包。
const md = new MarkdownIt({
  html: true, // 放 HTML 进来，交给 DOMPurify 剥危险属性
  linkify: true,
  breaks: true,
});

export function renderMarkdown(text: string): string {
  const raw = md.render(text);
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
