import { describe, test, expect } from "bun:test";
import { dispatch, schemas, validateToolArgs } from "../src/tools/registry";
import type { ToolDef } from "../src/tools/registry";

// A minimal typed tool whose handler records whether it was invoked, so we can
// prove a malformed call NEVER reaches the handler.
function makeCalcTool(): { def: ToolDef; calls: () => number } {
  let calls = 0;
  const def: ToolDef = {
    name: "calc",
    group: "write",
    description: "compute",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "sub", "mul"] },
        a: { type: "number" },
        b: { type: "number" },
        verbose: { type: "boolean" },
      },
      required: ["op", "a"],
    },
    async handler(args) {
      calls++;
      return `ok:${JSON.stringify(args)}`;
    },
  };
  return { def, calls: () => calls };
}

const cwd = "/tmp";

describe("dispatch schema validation (B7-6)", () => {
  test("valid call executes and receives coerced args", async () => {
    const { def: calc, calls } = makeCalcTool();
    const r = await dispatch([calc], "calc", { op: "add", a: "2", b: "3", verbose: "true" }, { cwd });
    expect(r.ok).toBe(true);
    expect(calls()).toBe(1);
    // string "2" coerced to number, "true" coerced to boolean.
    expect(r.output).toBe('ok:{"op":"add","a":2,"b":3,"verbose":true}');
  });

  test("wrong-type arg rejected pre-handler; handler spy never fires", async () => {
    const { def: calc, calls } = makeCalcTool();
    const r = await dispatch([calc], "calc", { op: "add", a: "not-a-number" }, { cwd });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('Argument "a" must be a number');
    expect(calls()).toBe(0); // handler never ran
  });

  test("object passed where a string is required is rejected pre-handler", async () => {
    const { def: calc, calls } = makeCalcTool();
    const r = await dispatch([calc], "calc", { op: { bad: true }, a: 1 }, { cwd });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('Argument "op" must be a string');
    expect(calls()).toBe(0);
  });

  test("enum violation rejected with a corrective note listing allowed values", async () => {
    const { def: calc, calls } = makeCalcTool();
    const r = await dispatch([calc], "calc", { op: "pow", a: 1 }, { cwd });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('Argument "op" must be one of: "add", "sub", "mul"');
    expect(r.output).toContain('got "pow"');
    expect(calls()).toBe(0);
  });

  test("missing required rejected pre-handler", async () => {
    const { def: calc, calls } = makeCalcTool();
    const r = await dispatch([calc], "calc", { op: "add" }, { cwd });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("Missing required argument(s): a");
    expect(calls()).toBe(0);
  });

  test("undeclared extra args pass through untouched", async () => {
    const { def: calc } = makeCalcTool();
    const r = await dispatch([calc], "calc", { op: "add", a: 1, extra: "x" }, { cwd });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('"extra":"x"');
  });
});

describe("dispatch unknown tool corrective message", () => {
  test("hallucinated tool name lists available tools, no execution", async () => {
    const { def: calc, calls } = makeCalcTool();
    const r = await dispatch([calc], "read_flie", { path: "x" }, { cwd });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("Unknown tool: read_flie");
    expect(r.output).toContain("Available tools: calc");
    expect(calls()).toBe(0);
  });

  test("offers a nearest-match suggestion for a close typo", async () => {
    const { def: calc } = makeCalcTool();
    const r = await dispatch([calc], "calx", { op: "add", a: 1 }, { cwd });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('Did you mean "calc"?');
  });
});

describe("validateToolArgs unit", () => {
  test("returns ok:false with message for an incoercible number", () => {
    const { def: calc } = makeCalcTool();
    const res = validateToolArgs(calc, { op: "add", a: "abc" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.output).toContain("must be a number");
  });
});

describe("minimal-surface schemas()", () => {
  const three: ToolDef[] = [
    makeCalcTool().def,
    {
      name: "read_file",
      group: "read",
      description: "read",
      inputSchema: { type: "object", properties: {}, required: ["path"] },
      async handler() {
        return "r";
      },
    },
    {
      name: "bash",
      group: "write",
      description: "bash",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        return "b";
      },
    },
  ];

  test("include hides out-of-scope tools from schemas()", () => {
    const s = schemas(three, { include: ["read_file"] });
    expect(s.map((t) => t.name)).toEqual(["read_file"]);
  });

  test("exclude drops denied tools from schemas()", () => {
    const s = schemas(three, { exclude: ["bash"] });
    expect(s.map((t) => t.name).sort()).toEqual(["calc", "read_file"]);
  });

  test("no opts returns every tool (backward compatible)", () => {
    expect(schemas(three).map((t) => t.name).sort()).toEqual(["bash", "calc", "read_file"]);
  });
});
