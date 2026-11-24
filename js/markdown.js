/**
 * Perpetual Side-by-Side Web Diary — XSS-Safe Markdown Renderer & Text Utilities
 * Zero external dependencies. Escapes all HTML before applying Markdown rules
 * and strictly sanitizes link URLs.
 */

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes HTML special characters to prevent XSS injection.
 * @param {unknown} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

/**
 * Validates and sanitizes a URL for safe use in href/src attributes.
 * Blocks javascript:, vbscript:, data:text/html, and control characters.
 * @param {unknown} url
 * @returns {string | null}
 */
export function sanitizeUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Reject ASCII control chars or whitespace injection
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;

  // Allow safe relative paths and hash anchors
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('data/media/')
  ) {
    // Disallow protocol-relative URLs (//evil.example)
    if (trimmed.startsWith('//')) return null;
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Renders inline Markdown formatting on already-escaped text.
 * Supports: `code`, **bold**, __bold__, *italic*, _italic_, ~~strike~~, [label](url).
 * @param {string} rawText
 * @returns {string}
 */
function renderInline(rawText) {
  const codeTokens = [];
  let text = escapeHtml(rawText);

  // 1. Protect inline code spans first so formatting inside code is untouched
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code>${code}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  // 2. Markdown links [label](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (full, label, rawHref) => {
    // Unescape &amp; in URL before validating
    const decodedHref = rawHref.replace(/&amp;/g, '&');
    const safe = sanitizeUrl(decodedHref);
    if (!safe) {
      return label;
    }
    const isExternal = /^https?:\/\//i.test(safe);
    const attrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escapeHtml(safe)}"${attrs}>${label}</a>`;
  });

  // 3. Bold (**text** or __text__)
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s(])__([^_\n]+?)__(?=$|[\s).,!?:;])/g, '$1<strong>$2</strong>');

  // 4. Italic (*text* or _text_)
  text = text.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');

  // 5. Strikethrough (~~text~~)
  text = text.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');

  // 6. Restore inline code spans
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeTokens[Number(idx)] || '');

  return text;
}

/**
 * Renders Markdown prose into strictly XSS-safe HTML.
 * @param {string} md
 * @returns {string}
 */
export function renderMarkdown(md) {
  const source = String(md ?? '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '';

  const lines = source.split('\n');
  const htmlBlocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code blocks ```
    const fenceMatch = line.match(/^```([a-zA-Z0-9_-]*)\s*$/);
    if (fenceMatch) {
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // Consume closing ```
      htmlBlocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      htmlBlocks.push('<hr />');
      i += 1;
      continue;
    }

    // Headings (# to ####)
    const headingMatch = line.match(/^(#{1,4})\s+(.+?)\s*#*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      htmlBlocks.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Blockquotes (> ...)
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      const innerHtml = quoteLines
        .map((ql) => (ql.trim() ? `<p>${renderInline(ql)}</p>` : ''))
        .join('');
      htmlBlocks.push(`<blockquote>${innerHtml}</blockquote>`);
      continue;
    }

    // Unordered list (- , * , + )
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const content = lines[i].replace(/^\s*[-*+]\s+/, '');
        items.push(`<li>${renderInline(content)}</li>`);
        i += 1;
      }
      htmlBlocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list (1. )
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const content = lines[i].replace(/^\s*\d+\.\s+/, '');
        items.push(`<li>${renderInline(content)}</li>`);
        i += 1;
      }
      htmlBlocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Standard paragraph (collect contiguous non-block lines)
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(lines[i])
    ) {
      paraLines.push(renderInline(lines[i]));
      i += 1;
    }

    htmlBlocks.push(`<p>${paraLines.join('<br />')}</p>`);
  }

  return htmlBlocks.join('\n');
}

/**
 * Strips Markdown formatting to produce clean plain text for search, snippets, and word counts.
 * @param {string} md
 * @returns {string}
 */
export function stripMarkdown(md) {
  let text = String(md ?? '');
  if (!text) return '';

  // Remove fenced code block markers while preserving inner text
  text = text.replace(/```[a-zA-Z0-9_-]*\n?/g, '');
  // Convert links [label](url) -> label
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Strip inline code ticks
  text = text.replace(/`([^`]+)`/g, '$1');
  // Strip headings, blockquotes, and list prefixes
  text = text.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '');
  // Strip emphasis and strikethrough symbols
  text = text.replace(/(\*\*|__|~~|\*|_)/g, '');
  // Strip horizontal rules
  text = text.replace(/^\s*(?:---+|\*\*\*+|___+)\s*$/gm, ' ');
  // Normalize whitespace
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Counts words in Markdown or plain text.
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  const plain = stripMarkdown(text);
  if (!plain) return 0;
  return plain.split(/\s+/).filter(Boolean).length;
}

/**
 * Counts characters in the provided text.
 * @param {string} text
 * @returns {number}
 */
export function countChars(text) {
  return String(text ?? '').length;
}

/**
 * Extracts a sensible default quote from an entry's Markdown when the user clicks
 * the column's Quote button without an active text selection.
 * Prefers the first Markdown blockquote if present; otherwise uses opening sentences.
 * @param {string} md
 * @param {number} [maxLen=180]
 * @returns {string}
 */
export function extractDefaultQuote(md, maxLen = 180) {
  const source = String(md ?? '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '';

  // Prefer first Markdown blockquote if available
  const quoteMatch = source.match(/^\s*>\s*(.+)$/m);
  let candidate = quoteMatch ? stripMarkdown(quoteMatch[1]) : stripMarkdown(source);

  if (!candidate) return '';

  if (candidate.length <= maxLen) {
    return candidate;
  }

  // Try to cut cleanly at a sentence or word boundary
  const slice = candidate.slice(0, maxLen);
  const sentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (sentenceEnd >= Math.floor(maxLen * 0.45)) {
    return slice.slice(0, sentenceEnd + 1).trim();
  }

  const lastSpace = slice.lastIndexOf(' ');
  const trimmed = lastSpace > 40 ? slice.slice(0, lastSpace) : slice;
  return `${trimmed.trim()}…`;
}