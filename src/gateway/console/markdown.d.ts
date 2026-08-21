export interface MarkdownSpanText {
  type: "text";
  text: string;
}
export interface MarkdownSpanCode {
  type: "code";
  text: string;
}
export interface MarkdownSpanContainer {
  type: "strong" | "em" | "link";
  href?: string;
  spans: MarkdownSpan[];
}
export type MarkdownSpan = MarkdownSpanText | MarkdownSpanCode | MarkdownSpanContainer;

export interface MarkdownBlockParagraph {
  type: "p";
  spans: MarkdownSpan[];
}
export interface MarkdownBlockHeading {
  type: "h";
  level: number;
  spans: MarkdownSpan[];
}
export interface MarkdownBlockList {
  type: "ol" | "ul";
  items: MarkdownSpan[][];
}
export interface MarkdownBlockCode {
  type: "code";
  text: string;
  lang: string;
}
export type MarkdownBlock =
  | MarkdownBlockParagraph
  | MarkdownBlockHeading
  | MarkdownBlockList
  | MarkdownBlockCode;

export function parseMarkdown(src: string): MarkdownBlock[];
export function sanitizeHref(href: string): string | null;
export function renderMarkdown(src: string, doc?: MarkdownDocument): MarkdownFragment;

export interface MarkdownFragment {
  children: MarkdownNode[];
  append(nodes: MarkdownNode | MarkdownNode[]): void;
}
export interface MarkdownNode {
  tag?: string;
  text?: string;
  children?: MarkdownNode[];
  attrs?: Record<string, string>;
}
export interface MarkdownDocument {
  createElement(tag: string): MarkdownNode;
  createTextNode(text: string): MarkdownNode;
  createDocumentFragment(): MarkdownFragment;
}
