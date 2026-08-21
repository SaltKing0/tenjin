import { describe, test, expect } from "bun:test";
import { resolveMemoryScope } from "../src/gateway/console/memory-scope.js";

describe("console memory scope resolution (#274)", () => {
  const bots = [{ name: "researcher" }, { name: "editor" }];

  test("keeps currentBot when it is a real bot", () => {
    expect(resolveMemoryScope("editor", bots)).toBe("editor");
  });

  test("falls back to the first bot when currentBot is solo (chat fallback, not a memory scope)", () => {
    expect(resolveMemoryScope("solo", bots)).toBe("researcher");
  });

  test("falls back to the first bot when currentBot is unknown/empty", () => {
    expect(resolveMemoryScope("", bots)).toBe("researcher");
    expect(resolveMemoryScope("nope", bots)).toBe("researcher");
    expect(resolveMemoryScope(undefined, bots)).toBe("researcher");
  });

  test("returns null when there are no bots (caller shows create-a-bot empty state)", () => {
    expect(resolveMemoryScope("solo", [])).toBeNull();
    expect(resolveMemoryScope("solo", undefined)).toBeNull();
  });

  test("handles bots list without a name field defensively", () => {
    expect(resolveMemoryScope("solo", [{}])).toBeNull();
  });
});
