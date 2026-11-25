/**
 * js/markdown.js — Perpetual Side-by-Side Web Diary Editorial Markdown Engine (File 5 of 11 · Final Build)
 *
 * Zero external dependencies. Escapes all HTML before applying Markdown rules
 * and strictly sanitizes every link URL to prevent XSS injection.
 *
 * Capabilities:
 * - Standard Markdown: headings, bold, italic, strikethrough, ==highlights==, inline/fenced code,
 *   blockquotes, ordered/unordered lists, task checkboxes (- [ ] / - [x]), links, horizontal rules
 * - Phase 13: Bi-Directional Wiki-Links (`[[YYYY-MM-DD]]`, `[[MM-DD]]`, `[[YYYY-MM-DD|Custom Label]]`)
 *   plus `extractWikiLinks(md)` for instant backlinks indexing
 * - Phase 16: Verse / Formalist Prose Mode (`preserveWhitespace: true`) preserving exact stanza
 *   breaks, leading indentation, and poetic spacing
 * - Phase 17: Scoped Footnotes (`[^1]` + `[^1]: definition`), Tufte-style Margin Sidenotes
 *   (`^[margin note]` or `{sn: margin note}`), and Editorial Callouts (`> [!note]`, `> [!reflection]`,
 *   `> [!memory]`, `> [!quote]`, `> [!tip]`, `> [!warning]`, `> [!milestone]`)
 */

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const CALLOUT_TYPES = Object.freeze({
  note: { label: 'Note', icon: '✎' },
  reflection: { label: 'Reflection', icon: '◈' },
  memory: { label: 'Memory', icon: '✦' },
  quote: { label: 'Quote', icon: '❝' },
  tip: { label: 'Insight', icon: '◇' },
  insight: { label: 'Insight', icon: '◇' },
  warning: { label: 'Caution', icon: '⚠' },
  milestone: { label: 'Milestone', icon: '★' },
  question: { label: 'Question', icon: '?' },
});

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Use \x60 escape so code fence regexes never embed literal triple-backticks
const FENCE_OPEN_RE = /^\x60{3}([a-zA-Z0-9_-]*)\s*$/;
const FENCE_CLOSE_RE = /^\x60{3}\s*$/;
const FENCE_ANY_RE = /^\x60{3}/;
const CALLOUT_HEADER_RE = /^\[!([a-zA-Z]+)\](?:\s+(.*))?$/;
const FOOTNOTE_DEF_RE = /^\[\^([a-zA-Z0-9_-]+)\]:\s*(.*)$/;
const WIKI_LINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

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
 * Blocks javascript:, vbscript:, data:text/html, protocol-relative URLs, and control characters.
 * @param {unknown} url
 * @returns {string | null}
 */
export function sanitizeUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;

  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('data/media/')
  ) {
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
 * Parses a wiki-link inner payload (`YYYY-MM-DD`, `MM-DD`, or `target|Custom Label`).
 * @param {string} rawInner
 * @returns {{ target: string, dayStr: string, year: string, label: string } | null}
 */
export function parseWikiLinkSpec(rawInner) {
  const parts = String(rawInner || '').split('|');
  const rawTarget = (parts[0] || '').trim();
  const customLabel = parts.slice(1).join('|').trim();

  // Match full ISO date: YYYY-MM-DD
  const fullMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawTarget);
  if (fullMatch) {
    const year = fullMatch[1];
    const mm = Number(fullMatch[2]);
    const dd = Number(fullMatch[3]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const dayStr = `${fullMatch[2]}-${fullMatch[3]}`;
    const defaultLabel = `${MONTH_ABBR[mm - 1]} ${dd}, ${year}`;
    return {
      target: rawTarget,
      dayStr,
      year,
      label: customLabel || defaultLabel,
    };
  }

  // Match perpetual calendar date: MM-DD
  const dayMatch = /^(\d{2})-(\d{2})$/.exec(rawTarget);
  if (dayMatch) {
    const mm = Number(dayMatch[1]);
    const dd = Number(dayMatch[2]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const defaultLabel = `${MONTH_ABBR[mm - 1]} ${dd}`;
    return {
      target: rawTarget,
      dayStr: rawTarget,
      year: '',
      label: customLabel || defaultLabel,
    };
  }

  return null;
}

/**
 * Extracts all valid bi-directional wiki-links from Markdown prose (ignoring code blocks).
 * Used by Phase 13 to build automatic backlinks ("Referenced by...") across years.
 * @param {string} md
 * @returns {Array<{ target: string, dayStr: string, year: string, label: string }>}
 */
export function extractWikiLinks(md) {
  const source = String(md ?? '').replace(/\r\n?/g, '\n');
  if (!source.includes('[[')) return [];

  // Strip fenced code blocks and inline code spans before scanning
  const lines = source.split('\n');
  const proseLines = [];
  let inFence = false;
  for (const line of lines) {
    if (!inFence && FENCE_OPEN_RE.test(line)) {
      inFence = true;
      continue;
    }
    if (inFence && FENCE_CLOSE_RE.test(line)) {
      inFence = false;
      continue;
    }
    if (!inFence) proseLines.push(line);
  }

  const cleaned = proseLines.join('\n').replace(/\x60[^\x60\n]+\x60/g, '');
  const found = [];
  const seen = new Set();

  let match;
  WIKI_LINK_RE.lastIndex = 0;
  while ((match = WIKI_LINK_RE.exec(cleaned)) !== null) {
    const spec = parseWikiLinkSpec(match[1]);
    if (!spec) continue;
    const key = `${spec.target}::${spec.label}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push(spec);
    }
  }

  return found;
}

/**
 * Pre-scans lines outside fenced code blocks for footnote definitions (`[^id]: text`).
 * Supports indented continuation lines belonging to the same footnote.
 * @param {string[]} lines
 * @returns {{ bodyLines: string[], definitions: Map<string, string> }}
 */
function extractFootnoteDefinitions(lines) {
  const bodyLines = [];
  const definitions = new Map();
  let inFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!inFence && FENCE_OPEN_RE.test(line)) {
      inFence = true;
      bodyLines.push(line);
      i += 1;
      continue;
    }
    if (inFence) {
      if (FENCE_CLOSE_RE.test(line)) inFence = false;
      bodyLines.push(line);
      i += 1;
      continue;
    }

    const fnMatch = FOOTNOTE_DEF_RE.exec(line);
    if (fnMatch) {
      const fnId = fnMatch[1];
      const parts = [fnMatch[2].trim()];
      i += 1;
      while (i < lines.length && /^(?: {2,}|\t+)\S/.test(lines[i])) {
        parts.push(lines[i].trim());
        i += 1;
      }
      definitions.set(fnId, parts.filter(Boolean).join(' '));
      continue;
    }

    bodyLines.push(line);
    i += 1;
  }

  return { bodyLines, definitions };
}

/**
 * Preserves leading spaces and tabs for Verse / Formalist Prose Mode
 * by converting leading indentation into non-breaking space runs.
 * @param {string} line
 * @returns {{ indentHtml: string, content: string }}
 */
function splitVerseIndentation(line) {
  const m = /^([ \t]+)(.*)$/.exec(line);
  if (!m) return { indentHtml: '', content: line };
  const expanded = m[1].replace(/\t/g, '    ');
  return {
    indentHtml: `<span class="verse-indent">${'&nbsp;'.repeat(expanded.length)}</span>`,
    content: m[2],
  };
}

/**
 * Renders inline Markdown formatting on raw text (escaping HTML first).
 * Supports:
 * - `inline code`
 * - Bi-directional wiki-links `[[YYYY-MM-DD]]` / `[[MM-DD|Label]]`
 * - Tufte-style margin sidenotes `^[note]` and `{sn: note}`
 * - Scoped footnote citations `[^id]`
 * - Links `[label](url)`
 * - Editorial highlighter `==text==`
 * - Bold `**text**` / `__text__`, Italic `*text*` / `_text_`, Strikethrough `~~text~~`
 *
 * @param {string} rawText
 * @param {{
 *   scopePrefix?: string,
 *   footnoteDefs?: Map<string, string>,
 *   usedFootnotes?: string[],
 *   sidenoteCounter?: { count: number },
 *   allowSidenotes?: boolean
 * }} [ctx]
 * @returns {string}
 */
function renderInline(rawText, ctx = {}) {
  const tokens = [];
  const stash = (html) => {
    const idx = tokens.length;
    tokens.push(html);
    return `\u0000TOK${idx}\u0000`;
  };

  let text = escapeHtml(rawText);

  // 1. Protect inline code spans first so inner syntax is never processed
  text = text.replace(/\x60([^\x60\n]+)\x60/g, (_, code) => stash(`<code>${code}</code>`));

  // 2. Bi-directional Wiki-Links: [[YYYY-MM-DD]] or [[MM-DD|Custom Label]]
  text = text.replace(/\[\[([^\[\]\n]+?)\]\]/g, (full, innerEscaped) => {
    const unescapedInner = innerEscaped
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
    const spec = parseWikiLinkSpec(unescapedInner);
    if (!spec) return full;

    const href = `#${spec.dayStr}`;
    const yearAttr = spec.year ? ` data-wiki-year="${escapeHtml(spec.year)}"` : '';
    const titleTip = spec.year
      ? `Jump to ${spec.target} side-by-side`
      : `Jump to calendar date ${spec.dayStr}`;
    return stash(
      `<a class="wiki-link" href="${href}" data-wiki-target="${escapeHtml(
        spec.target
      )}" data-wiki-day="${escapeHtml(spec.dayStr)}"${yearAttr} title="${escapeHtml(
        titleTip
      )}"><span class="wiki-link-glyph" aria-hidden="true">↗</span>${escapeHtml(spec.label)}</a>`
    );
  });

  // 3. Margin Sidenotes: ^[sidenote text] or {sn: sidenote text}
  if (ctx.allowSidenotes !== false) {
    const counter = ctx.sidenoteCounter || { count: 0 };
    const buildSidenote = (noteHtmlRaw) => {
      counter.count += 1;
      const num = counter.count;
      const noteRendered = renderInline(
        noteHtmlRaw
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'"),
        { ...ctx, allowSidenotes: false }
      );
      return stash(
        `<span class="md-sidenote-wrap">` +
          `<button type="button" class="md-sidenote-ref" aria-expanded="false" title="Toggle margin sidenote ${num}">†${num}</button>` +
          `<span class="md-sidenote-body" role="note"><span class="md-sidenote-num">†${num}</span> ${noteRendered}</span>` +
          `</span>`
      );
    };

    text = text.replace(/\^\[([^\[\]\n]+?)\]/g, (_, noteText) => buildSidenote(noteText.trim()));
    text = text.replace(/\{sn:\s*([^{}\n]+?)\}/gi, (_, noteText) => buildSidenote(noteText.trim()));
  }

  // 4. Footnote References: [^id]
  if (ctx.footnoteDefs && ctx.footnoteDefs.size > 0) {
    const used = ctx.usedFootnotes || [];
    const scope = ctx.scopePrefix || 'fn';
    text = text.replace(/\[\^([a-zA-Z0-9_-]+)\]/g, (full, fnId) => {
      if (!ctx.footnoteDefs.has(fnId)) return full;
      let orderIdx = used.indexOf(fnId);
      if (orderIdx === -1) {
        used.push(fnId);
        orderIdx = used.length - 1;
      }
      const displayNum = orderIdx + 1;
      const safeId = escapeHtml(fnId);
      return stash(
        `<sup class="md-fn-ref"><a href="#${scope}-def-${safeId}" id="${scope}-ref-${safeId}" data-fn-target="${scope}-def-${safeId}" title="Jump to footnote ${displayNum}">${displayNum}</a></sup>`
      );
    });
  }

  // 5. Standard Markdown Links: [label](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, rawHref) => {
    const decodedHref = rawHref.replace(/&amp;/g, '&');
    const safe = sanitizeUrl(decodedHref);
    if (!safe) return label;
    const isExternal = /^https?:\/\//i.test(safe);
    const attrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
    return stash(`<a href="${escapeHtml(safe)}"${attrs}>${label}</a>`);
  });

  // 6. Editorial Highlight: ==highlighted passage==
  text = text.replace(/==([^=\n]+?)==/g, '<mark class="md-highlight">$1</mark>');

  // 7. Bold (**text** or __text__)
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s(])__([^_\n]+?)__(?=$|[\s).,!?:;])/g, '$1<strong>$2</strong>');

  // 8. Italic (*text* or _text_)
  text = text.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');

  // 9. Strikethrough (~~text~~)
  text = text.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');

  // 10. Restore protected HTML tokens (supports nested tokens cleanly)
  let guard = 0;
  while (text.includes('\u0000TOK') && guard < 4) {
    text = text.replace(/\u0000TOK(\d+)\u0000/g, (_, idx) => tokens[Number(idx)] || '');
    guard += 1;
  }

  return text;
}

/**
 * Renders Markdown prose into strictly XSS-safe editorial HTML.
 *
 * @param {string} md
 * @param {{ preserveWhitespace?: boolean, scopeId?: string }} [options]
 * @returns {string}
 */
export function renderMarkdown(md, options = {}) {
  const source = String(md ?? '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '';

  const preserveWhitespace = Boolean(options.preserveWhitespace);
  const rawScope = String(options.scopeId || 'entry')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 32);
  const scopePrefix = `fn-${rawScope || 'entry'}`;

  const rawLines = source.split('\n');
  const { bodyLines: lines, definitions: footnoteDefs } = extractFootnoteDefinitions(rawLines);

  const usedFootnotes = [];
  const sidenoteCounter = { count: 0 };
  const inlineCtx = {
    scopePrefix,
    footnoteDefs,
    usedFootnotes,
    sidenoteCounter,
    allowSidenotes: true,
  };

  const htmlBlocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line separator
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code blocks
    const fenceMatch = FENCE_OPEN_RE.exec(line);
    if (fenceMatch) {
      const lang = fenceMatch[1] ? ` class="lang-${escapeHtml(fenceMatch[1])}"` : '';
      const codeLines = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      htmlBlocks.push(`<pre><code${lang}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      htmlBlocks.push('<hr />');
      i += 1;
      continue;
    }

    // Headings (# to ####)
    const headingMatch = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      htmlBlocks.push(`<h${level}>${renderInline(headingMatch[2], inlineCtx)}</h${level}>`);
      i += 1;
      continue;
    }

    // Blockquotes & Editorial Callouts (> [!note], > [!reflection], > [!memory], etc.)
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }

      const firstTrimmed = (quoteLines[0] || '').trim();
      const calloutMatch = CALLOUT_HEADER_RE.exec(firstTrimmed);
      if (calloutMatch) {
        const rawType = calloutMatch[1].toLowerCase();
        const cfg = CALLOUT_TYPES[rawType] || CALLOUT_TYPES.note;
        const safeType = CALLOUT_TYPES[rawType] ? rawType : 'note';
        const customTitle = (calloutMatch[2] || '').trim();
        const bodyQuoteLines = quoteLines.slice(1);
        const bodyHtml = bodyQuoteLines
          .map((ql) => (ql.trim() ? `<p>${renderInline(ql, inlineCtx)}</p>` : ''))
          .join('');
        htmlBlocks.push(
          `<aside class="md-callout md-callout-${safeType}" role="note">` +
            `<div class="md-callout-title"><span class="md-callout-icon" aria-hidden="true">${cfg.icon}</span><span>${
              customTitle ? renderInline(customTitle, inlineCtx) : cfg.label
            }</span></div>` +
            `<div class="md-callout-body">${bodyHtml}</div>` +
            `</aside>`
        );
      } else {
        const innerHtml = quoteLines
          .map((ql) => (ql.trim() ? `<p>${renderInline(ql, inlineCtx)}</p>` : ''))
          .join('');
        htmlBlocks.push(`<blockquote>${innerHtml}</blockquote>`);
      }
      continue;
    }

    // Unordered list & Task checkboxes (- [ ] / - [x]) — skipped when Verse Mode has indented poetry
    if (!preserveWhitespace && /^\s*[-*+]\s+/.test(line)) {
      const items = [];
      let isTaskList = false;
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const content = lines[i].replace(/^\s*[-*+]\s+/, '');
        const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(content);
        if (taskMatch) {
          isTaskList = true;
          const checked = taskMatch[1].toLowerCase() === 'x';
          items.push(
            `<li class="md-task-item${checked ? ' is-done' : ''}">` +
              `<span class="md-task-box" aria-hidden="true">${checked ? '✓' : ''}</span>` +
              `<span>${renderInline(taskMatch[2], inlineCtx)}</span></li>`
          );
        } else {
          items.push(`<li>${renderInline(content, inlineCtx)}</li>`);
        }
        i += 1;
      }
      htmlBlocks.push(`<ul${isTaskList ? ' class="md-task-list"' : ''}>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list (1. )
    if (!preserveWhitespace && /^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const content = lines[i].replace(/^\s*\d+\.\s+/, '');
        items.push(`<li>${renderInline(content, inlineCtx)}</li>`);
        i += 1;
      }
      htmlBlocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Standard Paragraph or Verse / Formalist Stanza
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE_ANY_RE.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      (preserveWhitespace || !/^\s*[-*+]\s+/.test(lines[i])) &&
      (preserveWhitespace || !/^\s*\d+\.\s+/.test(lines[i])) &&
      !/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(lines[i])
    ) {
      if (preserveWhitespace) {
        const { indentHtml, content } = splitVerseIndentation(lines[i]);
        // Preserve multi-space interior gaps in formalist verse
        const rendered = renderInline(content, inlineCtx).replace(/ {2,}/g, (spaces) =>
          '&nbsp;'.repeat(spaces.length)
        );
        paraLines.push(`${indentHtml}${rendered}`);
      } else {
        paraLines.push(renderInline(lines[i], inlineCtx));
      }
      i += 1;
    }

    if (preserveWhitespace) {
      htmlBlocks.push(`<p class="verse-stanza">${paraLines.join('<br />')}</p>`);
    } else {
      htmlBlocks.push(`<p>${paraLines.join('<br />')}</p>`);
    }
  }

  // Append Footnotes section if any footnotes were defined
  if (footnoteDefs.size > 0) {
    // Include referenced footnotes in order first, then any remaining unreferenced definitions
    const orderedIds = [...usedFootnotes];
    for (const defId of footnoteDefs.keys()) {
      if (!orderedIds.includes(defId)) orderedIds.push(defId);
    }

    const fnItems = orderedIds.map((fnId, idx) => {
      const rawDef = footnoteDefs.get(fnId) || '';
      const safeId = escapeHtml(fnId);
      const renderedDef = renderInline(rawDef, {
        ...inlineCtx,
        footnoteDefs: new Map(),
        allowSidenotes: false,
      });
      return (
        `<li id="${scopePrefix}-def-${safeId}" value="${idx + 1}">` +
        `<span>${renderedDef}</span> ` +
        `<a class="md-fn-back" href="#${scopePrefix}-ref-${safeId}" data-fn-target="${scopePrefix}-ref-${safeId}" title="Return to prose">↩</a>` +
        `</li>`
      );
    });

    htmlBlocks.push(
      `<section class="md-footnotes" aria-label="Footnotes">` +
        `<div class="md-footnotes-label mono-label">FOOTNOTES</div>` +
        `<ol class="md-footnotes-list">${fnItems.join('')}</ol>` +
        `</section>`
    );
  }

  const joined = htmlBlocks.join('\n');
  return preserveWhitespace ? `<div class="prose-verse">${joined}</div>` : joined;
}

/**
 * Strips Markdown, callout tags, footnote markers, sidenote wrappers, and wiki-link brackets
 * to produce clean plain text for search indexing, snippets, and accurate word counts.
 * @param {string} md
 * @returns {string}
 */
export function stripMarkdown(md) {
  let text = String(md ?? '').replace(/\r\n?/g, '\n');
  if (!text) return '';

  // Remove fenced code block markers while keeping inner text
  text = text.replace(/\x60{3}[a-zA-Z0-9_-]*\n?/g, '');
  // Convert footnote definitions to plain prose and strip inline footnote markers
  text = text.replace(/^\[\^[a-zA-Z0-9_-]+\]:\s*/gm, '');
  text = text.replace(/\[\^[a-zA-Z0-9_-]+\]/g, '');
  // Unwrap margin sidenotes to readable text
  text = text.replace(/\^\[([^\[\]\n]+?)\]/g, ' ($1)');
  text = text.replace(/\{sn:\s*([^{}\n]+?)\}/gi, ' ($1)');
  // Convert wiki-links [[target|Label]] -> Label or target
  text = text.replace(/\[\[([^\[\]\n]+?)\]\]/g, (_, inner) => {
    const parts = inner.split('|');
    return (parts[1] || parts[0] || '').trim();
  });
  // Convert Markdown links [label](url) -> label
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Strip callout header tokens > [!note]
  text = text.replace(/^\s*>\s*\[![a-zA-Z]+\]\s*/gm, '');
  // Strip inline code ticks
  text = text.replace(/\x60([^\x60]+)\x60/g, '$1');
  // Strip task checkbox prefixes
  text = text.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '');
  // Strip headings, blockquotes, and list prefixes
  text = text.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '');
  // Strip highlights, emphasis, and strikethrough symbols
  text = text.replace(/(==|\*\*|__|~~|\*|_)/g, '');
  // Strip horizontal rules
  text = text.replace(/^\s*(?:---+|\*\*\*+|___+)\s*$/gm, ' ');

  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Counts words in Markdown or plain text cleanly.
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
 * Detects whether a text block looks like indented verse/poetry
 * (useful for suggesting Verse / Formalist Prose Mode).
 * @param {string} md
 * @returns {boolean}
 */
export function hasVerseFormatting(md) {
  const lines = String(md ?? '').split('\n');
  let indentedLines = 0;
  for (const line of lines) {
    if (/^(?: {2,}|\t+)\S/.test(line) && !/^\s*[-*+\d]/.test(line)) {
      indentedLines += 1;
    }
  }
  return indentedLines >= 2;
}

/**
 * Extracts a sensible default quote from an entry's Markdown when the user clicks
 * the column's Quote button without an active text selection.
 * Prefers the first non-callout Markdown blockquote if present; otherwise uses opening sentences.
 * @param {string} md
 * @param {number} [maxLen=180]
 * @returns {string}
 */
export function extractDefaultQuote(md, maxLen = 180) {
  const source = String(md ?? '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '';

  // Prefer first regular Markdown blockquote (skipping `[!callout]` headers)
  const lines = source.split('\n');
  let quoteCandidate = '';
  for (const line of lines) {
    const m = /^\s*>\s*(.+)$/.exec(line);
    if (!m) continue;
    if (CALLOUT_HEADER_RE.test(m[1].trim())) continue;
    quoteCandidate = stripMarkdown(m[1]);
    if (quoteCandidate) break;
  }

  const candidate = quoteCandidate || stripMarkdown(source);
  if (!candidate) return '';

  if (candidate.length <= maxLen) {
    return candidate;
  }

  const slice = candidate.slice(0, maxLen);
  const sentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? ')
  );
  if (sentenceEnd >= Math.floor(maxLen * 0.45)) {
    return slice.slice(0, sentenceEnd + 1).trim();
  }

  const lastSpace = slice.lastIndexOf(' ');
  const trimmed = lastSpace > 40 ? slice.slice(0, lastSpace) : slice;
  return `${trimmed.trim()}…`;
}
