import { describe, test, expect } from "bun:test";
import {
  Screen,
  styleAnsi,
  decodeKey,
  LineEditor,
  RESET,
  HIDE_CURSOR,
  SHOW_CURSOR,
  type Writer,
} from "../src/ui/screen.js";
class Buf implements Writer {
  s = "";
  write(x: string) {
    this.s += x;
  }
}

describe("styleAnsi", () => {
  test("empty style renders nothing", () => {
    expect(styleAnsi()).toBe("");
  });
  test("bold, dim and colors compose", () => {
    expect(styleAnsi({ bold: true })).toContain("\x1b[1m");
    expect(styleAnsi({ dim: true })).toContain("\x1b[2m");
    expect(styleAnsi({ fg: 1 })).toBe("\x1b[31m");
    expect(styleAnsi({ fg: 9 })).toBe("\x1b[91m"); // bright red
    expect(styleAnsi({ bg: 4 })).toBe("\x1b[44m");
  });
});

describe("Screen", () => {
  test("write clamps to bounds and rowText flattens", () => {
    const s = new Screen(3, 10);
    s.write(1, 2, "hello");
    expect(s.rowText(1)).toBe("  hello   ");
    s.write(1, 2, "HI", { fg: 1 });
    expect(s.cell(1, 2)!.st.fg).toBe(1);
    s.write(0, 0, "way-too-long-string-overflow");
    expect(s.rowText(0).length).toBe(10);
  });

  test("render emits cursor show/hide and paints content (no full clear)", () => {
    const s = new Screen(2, 5);
    s.write(0, 0, "ab");
    s.write(1, 0, "cd", { fg: 2 });
    const b = new Buf();
    s.render(b, { row: 1, col: 1 });
    expect(b.s).toContain(HIDE_CURSOR);
    expect(b.s).not.toContain("\x1b[2J"); // diff renderer repaints rows, no clear
    expect(b.s).toContain(SHOW_CURSOR);
    expect(b.s).toContain("ab");
    expect(b.s).toContain("\x1b[32m"); // green "cd"
    expect(b.s).toContain(RESET);
  });
});

describe("decodeKey", () => {
  test("decodes arrows and function keys from CSI", () => {
    expect(decodeKey(new TextEncoder().encode("\x1b[A")).map((k) => k.type)).toEqual(["up"]);
    expect(decodeKey(new TextEncoder().encode("\x1b[B")).map((k) => k.type)).toEqual(["down"]);
    expect(decodeKey(new TextEncoder().encode("\x1b[C")).map((k) => k.type)).toEqual(["right"]);
    expect(decodeKey(new TextEncoder().encode("\x1b[D")).map((k) => k.type)).toEqual(["left"]);
    expect(decodeKey(new TextEncoder().encode("\x1b[H")).map((k) => k.type)).toEqual(["home"]);
    expect(decodeKey(new TextEncoder().encode("\x1b[F")).map((k) => k.type)).toEqual(["end"]);
    expect(decodeKey(new TextEncoder().encode("\x1b[3~")).map((k) => k.type)).toEqual(["delete"]);
  });
  test("decodes enter, tab, backspace, ctrl-c/d", () => {
    expect(decodeKey(new TextEncoder().encode("\r")).map((k) => k.type)).toEqual(["enter"]);
    expect(decodeKey(new TextEncoder().encode("\t")).map((k) => k.type)).toEqual(["tab"]);
    expect(decodeKey(new TextEncoder().encode("\x7f")).map((k) => k.type)).toEqual(["backspace"]);
    expect(decodeKey(new TextEncoder().encode("\x03")).map((k) => k.type)).toEqual(["ctrl-c"]);
    expect(decodeKey(new TextEncoder().encode("\x04")).map((k) => k.type)).toEqual(["ctrl-d"]);
  });
  test("decodes printable ASCII and multibyte UTF-8 as chars", () => {
    expect(decodeKey(new TextEncoder().encode("hi"))).toEqual([
      { type: "char", ch: "h" },
      { type: "char", ch: "i" },
    ]);
    const é = new TextEncoder().encode("é");
    expect(decodeKey(é)).toEqual([{ type: "char", ch: "é" }]);
  });
});

describe("LineEditor", () => {
  test("insert/backspace/submit round-trip", () => {
    const ed = new LineEditor();
    for (const c of "hello") ed.insert(c);
    expect(ed.text).toBe("hello");
    ed.backspace();
    expect(ed.text).toBe("hell");
    ed.insert("o");
    expect(ed.submit()).toBe("hello");
    expect(ed.text).toBe("");
  });
  test("cursor motion edits mid-line", () => {
    const ed = new LineEditor();
    for (const c of "ac") ed.insert(c);
    ed.left();
    ed.insert("b");
    expect(ed.text).toBe("abc");
    ed.home();
    ed.insert("z");
    expect(ed.text).toBe("zabc");
    ed.end();
    ed.ctrlK();
    expect(ed.text).toBe("zabc");
  });
});

describe("Screen diff rendering (#467)", () => {
  function rowMoves(s: string): string[] {
    // row-start moves look like \x1b[<r>;1H
    const out: string[] = [];
    for (const m of s.matchAll(/\x1b\[(\d+);1H/g)) out.push(m[1]!);
    return out;
  }

  test("an identical second render repaints no rows", () => {
    const scr = new Screen(5, 10);
    scr.write(1, 0, "hello");
    const b = new Buf();
    scr.render(b); // first paint
    b.s = "";
    scr.render(b); // identical — no diff (only cursor escapes, no row paints)
    expect(rowMoves(b.s)).toEqual([]);
  });

  test("changing one cell repaints only that row", () => {
    const scr = new Screen(5, 10);
    scr.write(0, 0, "abc");
    scr.write(3, 0, "xyz");
    const b = new Buf();
    scr.render(b);
    b.s = "";
    scr.write(3, 2, "Q"); // change row 3 (0-based) only
    scr.render(b);
    const moves = rowMoves(b.s);
    // row 3 (0-based → 4;1H) repainted, rows 0..2 untouched
    expect(moves).toEqual(["4"]);
  });

  test("style change on a cell triggers a repaint", () => {
    const scr = new Screen(3, 8);
    scr.write(0, 0, "hi");
    const b = new Buf();
    scr.render(b);
    b.s = "";
    scr.write(0, 0, "hi", { fg: 1 }); // same text, new style
    scr.render(b);
    expect(rowMoves(b.s)).toEqual(["1"]);
  });

  test("resize forces a full repaint of the new rows", () => {
    const scr = new Screen(3, 8);
    scr.write(1, 0, "x");
    const b = new Buf();
    scr.render(b);
    b.s = "";
    scr.resize(5, 8); // grew — repaint
    scr.render(b);
    // all 5 rows (1..5) are freshly painted
    expect(rowMoves(b.s).sort()).toEqual(["1", "2", "3", "4", "5"]);
  });
});
