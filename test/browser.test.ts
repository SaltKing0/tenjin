import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readActivePort,
  isBrowserAvailable,
  HeadlessBrowser,
  browserTool,
} from "../src/tools/browser";

let dir: string;
function tmp(): string {
  dir = mkdtempSync(join(tmpdir(), "tj-browser-"));
  return dir;
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("readActivePort (DevToolsActivePort parsing)", () => {
  test("parses the port from Chrome's active-port file", () => {
    const d = tmp();
    writeFileSync(join(d, "DevToolsActivePort"), "9222\n/devtools/browser/abc\n");
    expect(readActivePort(d)).toEqual({ port: 9222 });
  });

  test("null when the file is absent", () => {
    const d = tmp();
    expect(readActivePort(d)).toBeNull();
  });

  test("null when the port is not a positive integer", () => {
    const d = tmp();
    writeFileSync(join(d, "DevToolsActivePort"), "not-a-port\n/devtools\n");
    expect(readActivePort(d)).toBeNull();
  });
});

describe("browser tool", () => {
  test("schema exposes action+url", () => {
    expect(browserTool.name).toBe("browser");
    expect(browserTool.group).toBe("read");
    const props = browserTool.inputSchema.properties as Record<string, unknown>;
    expect(props.action).toBeTruthy();
    expect(props.url).toBeTruthy();
  });
});

test.skipIf(!isBrowserAvailable())(
  "integration: headless Chrome launches, navigates and extracts (gated)",
  async () => {
    const b = await HeadlessBrowser.launch();
    try {
      await b.navigate("https://example.com");
      const ex = await b.extract();
      expect(ex.title).toContain("Example");
      expect(ex.url).toContain("example.com");
      expect(ex.text.length).toBeGreaterThan(0);
    } finally {
      b.close();
    }
  },
  30_000,
);
