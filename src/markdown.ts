import { NodeHtmlMarkdown } from 'node-html-markdown';

export interface MarkdownOptions {
  /** Remove base64 data images (default: true) */
  removeDataImages?: boolean;
  /** Remove script tags (default: true) */
  removeScripts?: boolean;
  /** Remove style tags (default: true) */
  removeStyles?: boolean;
  /** Strip HTML comments (default: true) */
  stripComments?: boolean;
  /** Placeholder for removed images (default: '[image omitted]') */
  imagePlaceholder?: string;
  /** Collapse excessive whitespace (default: true) */
  collapseWhitespace?: boolean;
}

const DEFAULT_OPTIONS: Required<MarkdownOptions> = {
  removeDataImages: true,
  removeScripts: true,
  removeStyles: true,
  stripComments: true,
  imagePlaceholder: '[image omitted]',
  collapseWhitespace: true,
};

/**
 * Convert HTML to Markdown with sanitization
 * 
 * Removes potentially dangerous content (scripts, event handlers, javascript: URIs)
 * and cleans up base64 images and excessive whitespace.
 */
export function parseHtmlToMarkdown(rawHtml: string, options: MarkdownOptions = {}): string {
  if (!rawHtml || typeof rawHtml !== 'string') {
    return '';
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };
  let html = rawHtml;

  // Remove HTML comments
  if (opts.stripComments) {
    html = html.replace(/<!--[\s\S]*?-->/g, '');
  }

  // Remove script blocks
  if (opts.removeScripts) {
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  }

  // Remove style blocks
  if (opts.removeStyles) {
    html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  }

  // Remove inline event handlers (onclick, onload, etc.)
  html = html.replace(/\s(on\w+)\s*=\s*("[\s\S]*?"|'[\s\S]*?'|[^\s>]+)/gi, '');

  // Neutralize javascript: URIs
  html = html.replace(/href\s*=\s*("|')\s*javascript:[\s\S]*?\1/gi, 'href="#"');
  html = html.replace(/src\s*=\s*("|')\s*javascript:[\s\S]*?\1/gi, 'src="#"');

  // Replace base64 data images with placeholder
  if (opts.removeDataImages) {
    html = html.replace(/<img\b[^>]*>/gi, (imgTag) => {
      const isDataImage = /src\s*=\s*("|')?data:[^\s>"']+/i.test(imgTag);
      if (!isDataImage) return imgTag;

      // Extract alt text or use placeholder
      const altMatch = imgTag.match(/alt\s*=\s*("|')(.*?)\1/i);
      const altText = altMatch?.[2] || opts.imagePlaceholder;

      return `<p>${altText}</p>`;
    });
  }

  // Collapse whitespace
  if (opts.collapseWhitespace) {
    html = html.replace(/[\t\n\r]+/g, ' ');
    html = html.replace(/ {2,}/g, ' ');
  }

  // Convert to markdown
  try {
    const markdown = NodeHtmlMarkdown.translate(html);
    return typeof markdown === 'string' ? markdown.trim() : '';
  } catch (err) {
    // Log error but return empty string to allow graceful degradation
    console.warn('[markdown] Conversion failed:', err instanceof Error ? err.message : err);
    return '';
  }
}
