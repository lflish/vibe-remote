// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './render';

describe('renderMarkdown', () => {
  it('renders basic markdown to html', () => {
    const html = renderMarkdown('**bold** and `code`');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('renders fenced code blocks', () => {
    const html = renderMarkdown('```\nconst x = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('const x = 1;');
  });

  it('sanitizes script tags (XSS defense)', () => {
    const html = renderMarkdown('hi <script>alert(1)</script>');
    expect(html).not.toContain('<script>');
  });

  it('sanitizes javascript: hrefs and onerror handlers', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });
});
