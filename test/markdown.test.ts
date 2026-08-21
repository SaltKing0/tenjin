import { describe, test, expect } from "bun:test";
import {
  parseMarkdown,
  sanitizeHref,
  renderMarkdown,
} from "../src/gateway/console/markdown.js";
import type { MarkdownBlock, MarkdownNode } from "../src/gateway/console/markdown.js";

type Block = MarkdownBlock & Record<string, any>;

function first(src: string): Block {
  return parseMarkdown(src)[0] as Block;
}

function mockDoc() {
  const make = (tag: string): MarkdownNode & any => ({
    tag,
    children: [] as any[],
    attrs: {} as Record<string, string>,
    text: "",
    set textContent(v: string) {
      this.text = String(v);
      this.children = [];
    },
    append(...nodes: any[]) {
      this.children.push(...nodes.flat(Infinity));
    },
    setAttribute(k: string, v: string) {
      this.attrs[k] = String(v);
    },
  });
  return {
    createElement: make,
    createTextNode: (t: string) => ({ text: String(t), textNode: true }),
    createDocumentFragment: (): any => {
      const frag: any = { children: [], fragment: true };
      frag.append = (...nodes: any[]) => frag.children.push(...nodes.flat(Infinity));
      return frag;
    },
  };
}

describe("parseMarkdown", () => {
  test("bold", () => {
    const b = first("hello **world**");
    expect(b.type).toBe("p");
    expect(b.spans).toContainEqual({ type: "strong", spans: [{ type: "text", text: "world" }] });
  });

  test("italic", () => {
    const b = first("*hi*");
    expect(b.spans).toContainEqual({ type: "em", spans: [{ type: "text", text: "hi" }] });
  });

  test("inline code", () => {
    const b = first("run `bun test` now");
    expect(b.spans).toContainEqual({ type: "code", text: "bun test" });
  });

  test("link", () => {
    const b = first("[docs](https://example.com)");
    expect(b.spans).toContainEqual({
      type: "link",
      href: "https://example.com",
      spans: [{ type: "text", text: "docs" }],
    });
  });

  test("unordered list", () => {
    const b = first("- a\n- b");
    expect(b.type).toBe("ul");
    expect(b.items).toHaveLength(2);
  });

  test("ordered list", () => {
    const b = first("1. first\n2. second");
    expect(b.type).toBe("ol");
    expect(b.items).toHaveLength(2);
  });

  test("fenced code block", () => {
    const b = first("```ts\nconst x = 1;\n```");
    expect(b.type).toBe("code");
    expect(b.text).toBe("const x = 1;");
    expect(b.lang).toBe("ts");
  });

  test("heading", () => {
    const b = first("## Title");
    expect(b.type).toBe("h");
    expect(b.level).toBe(2);
  });

  test("multiple paragraphs split on blank line", () => {
    const blocks = parseMarkdown("one\n\ntwo");
    expect(blocks).toHaveLength(2);
  });
});

describe("sanitizeHref", () => {
  test("allows http, https, mailto", () => {
    expect(sanitizeHref("https://example.com")).toBe("https://example.com");
    expect(sanitizeHref("http://example.com")).toBe("http://example.com");
    expect(sanitizeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
  });

  test("rejects javascript and data schemes", () => {
    expect(sanitizeHref("javascript:alert(1)")).toBeNull();
    expect(sanitizeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(sanitizeHref("data:text/html,<script>")).toBeNull();
    expect(sanitizeHref("vbscript:msgbox(1)")).toBeNull();
  });
});

describe("renderMarkdown (XSS-safe, textContent strategy)", () => {
  test("never uses innerHTML; all user text lands as text nodes", () => {
    const doc = mockDoc();
    const frag = renderMarkdown("<script>alert(1)</script> **bold**", doc);
    const p = frag.children[0]!;
    expect(p.tag).toBe("p");
    for (const child of collectNodes(p)) {
      expect((child as any).innerHTML).toBeUndefined();
    }
  });

  test("javascript: link is dropped (no anchor element)", () => {
    const doc = mockDoc();
    const frag = renderMarkdown("[x](javascript:alert(1))", doc);
    const p = frag.children[0]!;
    const anchors = collectNodes(p).filter((n) => n.tag === "a");
    expect(anchors).toHaveLength(0);
  });

  test("builds strong/em/code/list elements from parsed blocks", () => {
    const doc = mockDoc();
    const frag = renderMarkdown("- **item**", doc);
    const ul = frag.children.find((n: MarkdownNode) => n.tag === "ul");
    const strong = collectNodes(ul!).find((n) => n.tag === "strong");
    expect(strong).toBeTruthy();
  });
});

function collectNodes(node: MarkdownNode): MarkdownNode[] {
  const out: MarkdownNode[] = [];
  const stack: MarkdownNode[] = [node];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    if (cur.children) stack.push(...cur.children);
  }
  return out;
}
