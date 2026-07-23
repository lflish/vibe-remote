import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

// Assistant text is claude's official output (markdown); we render it to HTML
// for readable code blocks / lists, then sanitize with DOMPurify before it ever
// touches innerHTML. This is display-layer formatting of official model output,
// not TUI parsing. User/tool text does NOT go through here (escapeHtml instead).
const md = new MarkdownIt({
  html: true, // allow HTML through so DOMPurify can strip dangerous attrs
  linkify: true,
  breaks: true,
});

export function renderMarkdown(text: string): string {
  const raw = md.render(text);
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
