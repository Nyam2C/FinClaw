// packages/web/src/markdown.ts
// Markdown rendering with marked + DOMPurify XSS protection

import DOMPurify from 'dompurify';
import { marked } from 'marked';

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

/**
 * Render markdown string to sanitized HTML.
 * Uses marked for parsing + DOMPurify to strip XSS vectors.
 */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw);
}
