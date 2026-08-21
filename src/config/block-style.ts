/**
 * Block-style YAML serializer (zero dependency, Bun).
 *
 * Bun's `YAML.stringify` emits *flow* style — a whole nested mapping comes back
 * as a single line. For config files that a console/CLI rewrites (jobs,
 * providers), we want readable multi-line block style, so we hand-roll a small
 * recursive serializer. Values are emitted as plain scalars when that is
 * unambiguous (`/^[A-Za-z0-9_./-]+$/`) and double-quoted otherwise, so cron
 * expressions (`"0 9 * * *"`) and multi-word strings round-trip safely.
 *
 * Shared by `gateway` job config edits (src/cli/jobs.ts) and the console's
 * `providers.yaml` writer (src/config/loader.ts).
 */

const PLAIN_SAFE = /^[A-Za-z0-9_./-]+$/;

function blockScalar(v: unknown): string {
  if (typeof v === "string") return PLAIN_SAFE.test(v) ? v : JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (v === null || v === undefined) return "null";
  return JSON.stringify(String(v));
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function emitBlock(v: unknown, indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  if (isMapping(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (isMapping(val) || Array.isArray(val)) {
        out.push(`${pad}${k}:\n`);
        emitBlock(val, indent + 2, out);
      } else {
        out.push(`${pad}${k}: ${blockScalar(val)}\n`);
      }
    }
  } else if (Array.isArray(v)) {
    for (const item of v) {
      if (isMapping(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) {
          out.push(`${pad}- {}\n`); // guard empty mappings
          continue;
        }
        const [k0, v0] = entries[0]!;
        if (isMapping(v0) || Array.isArray(v0)) {
          out.push(`${pad}- ${k0}:\n`);
          emitBlock(v0, indent + 4, out);
        } else {
          out.push(`${pad}- ${k0}: ${blockScalar(v0)}\n`);
        }
        for (const [k, val] of entries.slice(1)) {
          if (isMapping(val) || Array.isArray(val)) {
            out.push(`${pad}  ${k}:\n`);
            emitBlock(val, indent + 4, out);
          } else {
            out.push(`${pad}  ${k}: ${blockScalar(val)}\n`);
          }
        }
      } else {
        out.push(`${pad}- ${blockScalar(item)}\n`);
      }
    }
  } else {
    out.push(`${pad}${blockScalar(v)}\n`);
  }
}

/** Serialize `doc` as multi-line block-style YAML (mappings, lists, scalars). */
export function stringifyBlockStyle(doc: Record<string, unknown>): string {
  const out: string[] = [];
  emitBlock(doc, 0, out);
  return out.join("");
}
