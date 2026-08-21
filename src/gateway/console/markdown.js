/* Tenjin Console — markdown renderer. Vanilla JS, zero dependencies. */

const PROTOCOL_RE = /^(https?:|mailto:)/i;
const RELATIVE_RE = /^(\/|\.\/|\.\.\/|#)/;

export function sanitizeHref(href) {
  const h = String(href).trim();
  if (PROTOCOL_RE.test(h)) return h;
  if (RELATIVE_RE.test(h)) return h;
  return null;
}

function parseInline(src) {
  const spans = [];
  let i = 0;
  const text = (t) => {
    if (t) spans.push({ type: "text", text: t });
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === "*") {
      const strong = src.startsWith("**", i);
      const endMarker = strong ? "**" : "*";
      const close = src.indexOf(endMarker, i + endMarker.length);
      if (close !== -1) {
        const inner = src.slice(i + endMarker.length, close);
        if (inner) {
          spans.push({ type: strong ? "strong" : "em", spans: parseInline(inner) });
          i = close + endMarker.length;
          continue;
        }
      }
      text(ch);
      i++;
      continue;
    }
    if (ch === "`") {
      const close = src.indexOf("`", i + 1);
      if (close !== -1) {
        const code = src.slice(i + 1, close);
        if (code && !code.includes("\n")) {
          spans.push({ type: "code", text: code });
          i = close + 1;
          continue;
        }
      }
      text(ch);
      i++;
      continue;
    }
    if (ch === "[") {
      const closeBracket = src.indexOf("]", i + 1);
      const openParen = src.indexOf("(", closeBracket + 1);
      const closeParen = src.indexOf(")", openParen + 1);
      if (
        closeBracket !== -1 &&
        openParen === closeBracket + 1 &&
        closeParen !== -1
      ) {
        const label = src.slice(i + 1, closeBracket);
        const url = src.slice(openParen + 1, closeParen);
        if (label && url) {
          spans.push({ type: "link", href: url, spans: parseInline(label) });
          i = closeParen + 1;
          continue;
        }
      }
    }
    const next = nextMarker(src, i + 1);
    const end = next === -1 ? src.length : next;
    text(src.slice(i, end));
    i = end;
  }
  return spans;
}

function nextMarker(src, from) {
  let best = -1;
  for (const m of ["*", "`", "["]) {
    const idx = src.indexOf(m, from);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

function isBullet(line) {
  const m = /^(\s*)([-*+]|\d+\.)\s+/.exec(line);
  return m ? { indent: m[1].length, ordered: /^\d/.test(m[2]) } : null;
}

export function parseMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      i++;
      const out = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: "code", text: out.join("\n"), lang });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "h", level: heading[1].length, spans: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (isBullet(line)) {
      const list = [];
      let ordered = null;
      while (i < lines.length && isBullet(lines[i])) {
        const item = isBullet(lines[i]);
        ordered = item.ordered;
        const content = lines[i].replace(/^(\s*)([-*+]|\d+\.)\s+/, "");
        list.push(parseInline(content));
        i++;
      }
      blocks.push({ type: ordered ? "ol" : "ul", items: list });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para = [...parseInline(line)];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBullet(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^```/.test(lines[i])) {
      para.push(...parseInline(lines[i]));
      i++;
    }
    blocks.push({ type: "p", spans: para });
  }
  return blocks;
}

function appendSpans(parent, spans, doc) {
  for (const span of spans) {
    if (span.type === "text") {
      parent.append(doc.createTextNode(span.text));
    } else if (span.type === "code") {
      parent.append(makeCode(span.text, doc));
    } else if (span.type === "strong") {
      const el = doc.createElement("strong");
      appendSpans(el, span.spans, doc);
      parent.append(el);
    } else if (span.type === "em") {
      const el = doc.createElement("em");
      appendSpans(el, span.spans, doc);
      parent.append(el);
    } else if (span.type === "link") {
      const href = sanitizeHref(span.href);
      if (href) {
        const el = doc.createElement("a");
        el.setAttribute("href", href);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
        appendSpans(el, span.spans, doc);
        parent.append(el);
      } else {
        appendSpans(parent, span.spans, doc);
      }
    }
  }
}

function makeCode(text, doc) {
  const code = doc.createElement("code");
  code.textContent = text;
  return code;
}

export function renderMarkdown(src, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  for (const block of parseMarkdown(src)) {
    if (block.type === "code") {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      if (block.lang) code.setAttribute("class", `lang-${block.lang}`);
      code.textContent = block.text;
      pre.append(code);
      frag.append(pre);
    } else if (block.type === "h") {
      const el = doc.createElement(`h${Math.min(6, block.level)}`);
      appendSpans(el, block.spans, doc);
      frag.append(el);
    } else if (block.type === "ul" || block.type === "ol") {
      const list = doc.createElement(block.type);
      for (const item of block.items) {
        const li = doc.createElement("li");
        appendSpans(li, item, doc);
        list.append(li);
      }
      frag.append(list);
    } else {
      const el = doc.createElement("p");
      appendSpans(el, block.spans, doc);
      frag.append(el);
    }
  }
  return frag;
}
