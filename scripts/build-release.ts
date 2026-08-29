#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

export interface ReleaseBuildOptions {
  target?: string;
  outfile: string;
  version?: string;
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error("package.json has no valid version");
  }
  return pkg.version.trim();
}

export async function buildRelease(options: ReleaseBuildOptions): Promise<string> {
  const version = options.version?.trim() || packageVersion();
  const outfile = isAbsolute(options.outfile)
    ? options.outfile
    : resolve(ROOT, options.outfile);
  const buildDir = dirname(outfile);
  mkdirSync(buildDir, { recursive: true });
  const priorTemporaryOutputs = new Set(
    readdirSync(buildDir).filter((name) => name.endsWith(".bun-build")),
  );

  const command = [
    process.execPath,
    "build",
    "--compile",
    ...(options.target ? ["--target", options.target] : []),
    "--define",
    `__TENJIN_VERSION__=${JSON.stringify(version)}`,
    join(ROOT, "src", "index.ts"),
    "--outfile",
    outfile,
  ];
  const child = Bun.spawn(command, {
    // Bun may materialize an executable-sized `.bun-build` staging file in
    // its cwd. Keep it next to the requested artifact, never in the source
    // tree, and remove only files created by this invocation.
    cwd: buildDir,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  for (const name of readdirSync(buildDir)) {
    if (!name.endsWith(".bun-build") || priorTemporaryOutputs.has(name)) continue;
    unlinkSync(join(buildDir, name));
  }
  if (code !== 0 || !existsSync(outfile)) {
    throw new Error(`release build failed with exit code ${code}`);
  }
  process.stdout.write(`release binary: ${outfile} (v${version})\n`);
  return outfile;
}

function parseArgs(argv: string[]): ReleaseBuildOptions {
  let target: string | undefined;
  let outfile: string | undefined;
  let version: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") target = argv[++i];
    else if (arg === "--outfile") outfile = argv[++i];
    else if (arg === "--version") version = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!outfile) throw new Error("usage: build-release.ts --outfile <path> [--target <bun-target>] [--version <version>]");
  return { target, outfile, version };
}

if (import.meta.main) {
  await buildRelease(parseArgs(process.argv.slice(2)));
}
