import { describe, test, expect } from "bun:test";
import { ROLE_TEMPLATES, roleTemplate, templateSoul } from "../src/bots/templates";

describe("role templates (#253)", () => {
  test("exposes the documented set of roles", () => {
    const ids = ROLE_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(["researcher", "coder", "writer", "social", "custom"]);
    for (const t of ROLE_TEMPLATES) {
      expect(t.label).toBeTruthy();
      expect(t.desc).toBeTruthy();
    }
  });

  test("templateSoul prefixes the bot name and sets the role", () => {
    const soul = templateSoul("researcher", "mini");
    expect(soul).toContain("# SOUL — mini");
    expect(soul).toContain("You are **mini**");
    expect(soul).toContain("investigation specialist");
    // tone/behaviour lines present
    expect(soul).toContain("Cite file paths and line numbers");
  });

  test("custom role starts with a minimal editable draft", () => {
    const soul = templateSoul("custom", "helper");
    expect(soul).toContain("# SOUL — helper");
    expect(soul).toContain("<!-- Replace this draft");
  });

  test("unknown role throws with the available list", () => {
    expect(() => templateSoul("undefined-role", "x")).toThrow(/unknown role/);
  });

  test("roleTemplate returns null for unknown id", () => {
    expect(roleTemplate("nope")).toBeNull();
    expect(roleTemplate("writer")?.id).toBe("writer");
  });
});
