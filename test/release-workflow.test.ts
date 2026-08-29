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
    expect(raw).toContain('test "$(node -p process.arch)" = "${{ matrix.native_arch }}"');
    expect(raw).toContain("scripts/release-blackbox.ts --artifact");
  });

  test("refuses mismatched tags and marks prerelease versions explicitly", () => {
    expect(raw).toContain('test "v${PACKAGE_VERSION}" = "${GITHUB_REF_NAME}"');
    expect(raw).toContain('if [[ "$GITHUB_REF_NAME" == *-* ]]');
    expect(raw).toContain("--prerelease");
    expect(raw).toContain("--generate-notes");
  });

  test("publishes flat artifact names with a matching checksum manifest", () => {
    expect(raw).toContain("cp {} release/");
    expect(raw).toContain("sha256sum tenjin-* > SHA256SUMS");
    expect(raw).toContain('gh release create "$GITHUB_REF_NAME" release/*');
    expect(raw).not.toContain("files: dist/**");
  });

  test("uses Node 24-native official GitHub actions only", () => {
    expect(raw).toContain("actions/checkout@v7");
    expect(raw).toContain("actions/upload-artifact@v7");
    expect(raw).toContain("actions/download-artifact@v8");
    expect(raw).not.toContain("softprops/action-gh-release");
    expect(raw).not.toMatch(/actions\/(?:checkout|upload-artifact|download-artifact)@v[1-4]\b/);
  });
});
