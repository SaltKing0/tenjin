import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

const path = join(import.meta.dir, "..", ".github", "workflows", "release.yml");
const raw = readFileSync(path, "utf8");

describe("release workflow", () => {
  test("is valid YAML and builds through the version-injecting release script", () => {
    expect(() => YAML.parse(raw)).not.toThrow();
    expect(raw).toContain("scripts/build-release.ts");
    expect(raw).not.toContain("bun build --compile --target");
  });

  test("runs the full blackbox against each native artifact", () => {
    expect(raw).toContain("scripts/release-blackbox.ts --artifact");
  });

  test("publishes flat artifact names with a matching checksum manifest", () => {
    expect(raw).toContain("cp {} release/");
    expect(raw).toContain("sha256sum tenjin-* > SHA256SUMS");
    expect(raw).toContain("files: release/*");
    expect(raw).not.toContain("files: dist/**");
  });
});
