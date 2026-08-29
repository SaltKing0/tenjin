import type { ToolDef } from "./registry";
import type { HarnessConfig } from "../config/types";
import { VERSION } from "../version";
import { Redactor, isSensitiveKey } from "../security/redact";
import {
  buildChildEnvironment,
  type HostEnvironment,
} from "../security/child-env";

/**
 * MCP (Model Context Protocol) stdio skeleton — Roadmap §3 Phase 3 / WPs 3.1+3.2.
 *
 * A thin, dependency-free adapter that speaks newline-framed JSON-RPC 2.0 over a
 * child process's stdio (Bun.spawn) — NO official SDK, so no runtime deps.
 *
 * Default is OFF: an MCP server only runs when a config entry has
 * `enabled: true`. With an empty (or default) config, `createMcpTools` returns
 * [] and boot behavior is byte-identical to pre-MCP main.
 *
 * Per server (config `mcp.servers[]`):
 *   { name, command, args[], env{}, scope: local|project|user, enabled:false }
 *
 * Lifecycle: spawn child -> initialize handshake + capability exchange ->
 * tools/list -> register each remote tool as a ToolDef named
 * `mcp__<server>__<tool>` -> tools/call on use. Each call has a timeout that
 * kills and reaps the child on hang; a malformed JSON-RPC frame is rejected
 * cleanly instead of crashing the harness.
 */

export type McpScope = "local" | "project" | "user";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  /** Environment for the child, with ${VAR}/$VAR expanded from `env`. */
  env?: Record<string, string>;
  scope: McpScope;
  /** Default false — an MCP server only runs when explicitly enabled. */
  enabled: boolean;
  /**
   * #347 governance: risk grade. `true` → the server's tools register as
   * `group: "read"` (no approval). Default `false` → tools register as
   * `group: "write"`, so they REQUIRE approval (untrusted-by-default).
   */
  readOnly?: boolean;
}

export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema: {
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface Pending {
  resolve: (r: JsonRpcResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const ENV_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const MAX_MCP_FRAME_CHARS = 1_000_000;
const MAX_MCP_TOOLS = 128;
const MAX_MCP_PROPERTIES = 128;
const MAX_MCP_SCHEMA_DEPTH = 8;
const MAX_MCP_SCHEMA_NODES = 2_048;
const MAX_MCP_SCHEMA_STRING_CHARS = 4_096;
const MAX_MCP_NAME_CHARS = 64;
const MAX_MCP_PROPERTY_NAME_CHARS = 128;
const SAFE_TOOL_COMPONENT = /^[A-Za-z0-9_-]+$/;
const SAFE_PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SAFE_SCHEMA_KEY = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const INVALID_SCHEMA = Symbol("invalid MCP schema");

interface SchemaBudget {
  nodes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Names are never rewritten: invalid/secret-bearing names are skipped to avoid collisions. */
function isSafeName(
  value: unknown,
  redactor: Redactor,
  pattern: RegExp,
  maxChars: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    value === value.trim() &&
    pattern.test(value) &&
    !FORBIDDEN_OBJECT_KEYS.has(value) &&
    !Object.hasOwn(Object.prototype, value) &&
    redactor.redact(value) === value
  );
}

function sanitizeRequired(
  value: unknown,
  properties: Record<string, unknown>,
  redactor: Redactor,
): string[] | typeof INVALID_SCHEMA {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MCP_PROPERTIES) return INVALID_SCHEMA;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isSafeName(item, redactor, SAFE_PROPERTY_NAME, MAX_MCP_PROPERTY_NAME_CHARS)) {
      return INVALID_SCHEMA;
    }
    if (!Object.hasOwn(properties, item) || seen.has(item)) return INVALID_SCHEMA;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function sanitizeProperties(
  value: unknown,
  redactor: Redactor,
  budget: SchemaBudget,
  depth: number,
): Record<string, unknown> | typeof INVALID_SCHEMA {
  if (value === undefined) return {};
  if (!isRecord(value)) return INVALID_SCHEMA;
  const entries = Object.entries(value);
  if (entries.length > MAX_MCP_PROPERTIES) return INVALID_SCHEMA;
  const out: Record<string, unknown> = {};
  for (const [key, schema] of entries) {
    if (!isSafeName(key, redactor, SAFE_PROPERTY_NAME, MAX_MCP_PROPERTY_NAME_CHARS)) {
      return INVALID_SCHEMA;
    }
    // Boolean JSON Schemas are deliberately unsupported at this trust
    // boundary; every advertised argument must have an inspectable object spec.
    if (!isRecord(schema)) return INVALID_SCHEMA;
    const safe = sanitizeSchemaValue(schema, redactor, budget, depth + 1);
    if (safe === INVALID_SCHEMA) return INVALID_SCHEMA;
    out[key] = safe;
  }
  return out;
}

/** Bounded recursive copy of untrusted JSON-Schema metadata. */
function sanitizeSchemaValue(
  value: unknown,
  redactor: Redactor,
  budget: SchemaBudget,
  depth: number,
): unknown | typeof INVALID_SCHEMA {
  budget.nodes++;
  if (budget.nodes > MAX_MCP_SCHEMA_NODES || depth > MAX_MCP_SCHEMA_DEPTH) {
    return INVALID_SCHEMA;
  }
  if (typeof value === "string") {
    // Redact the complete value before checking/capping so a secret is never
    // split into a surviving fragment. Oversized constraints fail closed.
    const safe = redactor.redact(value);
    return safe.length <= MAX_MCP_SCHEMA_STRING_CHARS ? safe : INVALID_SCHEMA;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID_SCHEMA;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_MCP_PROPERTIES) return INVALID_SCHEMA;
    const out: unknown[] = [];
    for (const item of value) {
      const safe = sanitizeSchemaValue(item, redactor, budget, depth + 1);
      if (safe === INVALID_SCHEMA) return INVALID_SCHEMA;
      out.push(safe);
    }
    return out;
  }
  if (!isRecord(value)) return INVALID_SCHEMA;

  const entries = Object.entries(value);
  if (entries.length > MAX_MCP_PROPERTIES) return INVALID_SCHEMA;
  const out: Record<string, unknown> = {};
  let nestedProperties: Record<string, unknown> | undefined;
  for (const [key, item] of entries) {
    if (
      !isSafeName(key, redactor, SAFE_SCHEMA_KEY, MAX_MCP_PROPERTY_NAME_CHARS)
    ) {
      return INVALID_SCHEMA;
    }
    if (key === "required") continue;
    if (key === "properties") {
      const safe = sanitizeProperties(item, redactor, budget, depth + 1);
      if (safe === INVALID_SCHEMA) return INVALID_SCHEMA;
      nestedProperties = safe;
      out.properties = safe;
      continue;
    }
    const safe = sanitizeSchemaValue(item, redactor, budget, depth + 1);
    if (safe === INVALID_SCHEMA) return INVALID_SCHEMA;
    out[key] = safe;
  }
  if (Object.hasOwn(value, "required")) {
    const safe = sanitizeRequired(value.required, nestedProperties ?? {}, redactor);
    if (safe === INVALID_SCHEMA) return INVALID_SCHEMA;
    out.required = safe;
  }
  return out;
}

/** Convert one runtime tools/list entry into a bounded, provider-safe spec. */
function sanitizeMcpToolSpec(raw: unknown, redactor: Redactor): McpToolSpec | null {
  if (!isRecord(raw)) return null;
  if (!isSafeName(raw.name, redactor, SAFE_TOOL_COMPONENT, MAX_MCP_NAME_CHARS)) return null;
  if (raw.description !== undefined && typeof raw.description !== "string") return null;
  if (raw.inputSchema !== undefined && !isRecord(raw.inputSchema)) return null;
  const input = (raw.inputSchema ?? {}) as Record<string, unknown>;
  if (input.type !== undefined && input.type !== "object") return null;
  const budget: SchemaBudget = { nodes: 0 };
  const properties = sanitizeProperties(input.properties, redactor, budget, 0);
  if (properties === INVALID_SCHEMA) return null;
  const required = sanitizeRequired(input.required, properties, redactor);
  if (required === INVALID_SCHEMA) return null;
  return {
    name: raw.name,
    ...(raw.description !== undefined
      ? { description: truncate(redactor.redact(raw.description)) }
      : {}),
    inputSchema: {
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

/** Expand `${VAR}` / `$VAR` references from `env` (defaults to process.env). */
export function expandEnv(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(ENV_VAR, (whole, a?: string, b?: string) => {
    const key = a ?? b;
    const v = key ? env[key] : undefined;
    return v !== undefined ? v : whole;
  });
}

/** Normalize a raw `mcp.servers[]` value into typed server configs (enabled=false default). */
export function normalizeMcpServers(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const s = item as Record<string, unknown>;
    const name = typeof s.name === "string" ? s.name.trim() : "";
    if (!name || typeof s.command !== "string") continue;
    out.push({
      name,
      command: s.command,
      args: Array.isArray(s.args) ? s.args.map(String) : undefined,
      env: expandEnvMap(s.env, env),
      scope: s.scope === "project" || s.scope === "user" ? s.scope : "local",
      // Do not coerce configuration strings: Boolean("false") is true and
      // would both start a supposedly disabled process and, for readOnly,
      // downgrade write-capable remote tools past the approval boundary.
      // Exact true is the only opt-in; every other value fails closed.
      enabled: s.enabled === true,
      readOnly: s.readOnly === true,
    });
  }
  return out;
}

/** Safe ambient variables plus only the values explicitly granted to this server. */
export function buildMcpChildEnvironment(
  cfg: McpServerConfig,
  hostEnv: HostEnvironment = process.env,
): Record<string, string> {
  return buildChildEnvironment(hostEnv, { explicit: cfg.env });
}

/** Opaque values explicitly granted through secret-like env keys. */
function sensitiveEnvValues(cfg: McpServerConfig): string[] {
  return Object.entries(cfg.env ?? {})
    .filter(([key, value]) => isSensitiveKey(key) && value.length > 0)
    .map(([, value]) => value);
}

function expandEnvMap(
  raw: unknown,
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = expandEnv(String(v), env);
  }
  return out;
}

function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((b) => {
      if (b && typeof b === "object") {
        const block = b as { type?: string; text?: unknown };
        if (block.type === "text" && typeof block.text === "string") return block.text;
        return String(block.text ?? "");
      }
      return String(b);
    })
    .filter((s) => s !== "")
    .join("\n");
}

/** A single JSON-RPC client bound to one MCP child process. */
export class McpClient {
  private proc: ReturnType<typeof Bun.spawn>;
  private stdin: { write(data: Uint8Array | string): void; flush(): void } | undefined;
  private pumpPromise: Promise<void> | undefined;
  private stderrPromise: Promise<void> | undefined;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private failReason: string | null = null;
  private readonly redactor: Redactor;
  private readonly decoder = new TextDecoder();

  constructor(
    private cfg: McpServerConfig,
    private timeoutMs = 15_000,
    hostEnv: HostEnvironment = process.env,
    redactor: Redactor = new Redactor(),
  ) {
    this.redactor = redactor.withSecrets(sensitiveEnvValues(cfg));
    this.proc = Bun.spawn([cfg.command, ...(cfg.args ?? [])], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: buildMcpChildEnvironment(cfg, hostEnv),
    });
    // Bun's spawned stdin in "pipe" mode is a FileSink (write/flush), not a
    // web WritableStream — cast to the minimal shape we use.
    this.stdin = this.proc.stdin as unknown as McpClient["stdin"];
    this.pumpPromise = this.pump();
    // A chatty server must not deadlock when the OS stderr pipe fills. Stderr
    // is untrusted diagnostic data and is deliberately discarded.
    this.stderrPromise = this.discardStderr();
    liveClients.add(this);
  }

  private writeLine(frame: string): void {
    if (!this.stdin) return;
    this.stdin.write(new TextEncoder().encode(frame + "\n"));
    this.stdin.flush();
  }

  /** MCP initialize handshake + capability exchange, then tools/list. */
  async initialize(): Promise<void> {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tenjin", version: VERSION },
    });
    if (res.error) {
      throw new Error(this.redactor.redact(`MCP initialize failed: ${res.error.message ?? "unknown error"}`));
    }
    this.notify("notifications/initialized", {});
    const list = await this.request("tools/list", {});
    if (list.error) {
      throw new Error(this.redactor.redact(`MCP tools/list failed: ${list.error.message ?? "unknown error"}`));
    }
    const tools = (list.result as { tools?: unknown })?.tools;
    this.tools = Array.isArray(tools)
      ? tools
          .slice(0, MAX_MCP_TOOLS)
          .map((tool) => sanitizeMcpToolSpec(tool, this.redactor))
          .filter((tool): tool is McpToolSpec => tool !== null)
      : [];
  }

  /** Tools advertised by the server (populated after initialize()). */
  tools: McpToolSpec[] = [];

  async callTool(name: string, args: unknown): Promise<string> {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res.error) {
      throw new Error(this.redactor.redact(`MCP tools/call error: ${res.error.message ?? "unknown error"}`));
    }
    return this.redactor.redact(renderContent((res.result as { content?: unknown })?.content));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    liveClients.delete(this);
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    this.failAll(new Error("MCP client closed"));
  }

  /** @internal for tests — resolves when the child process is fully reaped. */
  get exited(): Promise<number | null> {
    return this.proc.exited;
  }

  private request(method: string, params: unknown): Promise<JsonRpcResponse> {
    if (this.closed) return Promise.reject(new Error(`MCP client closed (${method})`));
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failWith(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`));
        reject(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeLine(frame);
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.writeLine(frame);
  }

  private async pump(): Promise<void> {
    const stdout = this.proc.stdout as unknown as ReadableStream<Uint8Array> | undefined;
    const reader = stdout?.getReader();
    if (!reader) return;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // One streaming decoder preserves a multibyte UTF-8 code point split
        // across arbitrary pipe chunks; constructing a decoder per chunk can
        // replace both halves and corrupt otherwise-valid JSON-RPC.
        this.buf += this.decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          if (nl > MAX_MCP_FRAME_CHARS) {
            this.failWith(new Error("MCP server sent an oversized JSON-RPC frame"));
            return;
          }
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line) this.handleFrame(line);
          if (this.closed) return;
        }
        if (this.buf.length > MAX_MCP_FRAME_CHARS) {
          this.failWith(new Error("MCP server sent an oversized JSON-RPC frame"));
          return;
        }
      }
      // EOF: the child exited. If we weren't closed intentionally, fail pending.
      if (!this.closed) this.failWith(new Error("MCP server exited unexpectedly"));
    } catch {
      if (!this.closed) this.failWith(new Error("MCP stdout read failed"));
    }
  }

  private async discardStderr(): Promise<void> {
    const stderr = this.proc.stderr as unknown as ReadableStream<Uint8Array> | undefined;
    const reader = stderr?.getReader();
    if (!reader) return;
    try {
      while (!(await reader.read()).done) {
        // Drain only. Raw server diagnostics never cross a trust boundary.
      }
    } catch {
      // Process teardown can close the pipe while a read is pending.
    }
  }

  private handleFrame(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      // Never include a raw frame excerpt here: slicing first can retain a
      // partial token which no format-aware redactor can recognize later.
      this.failWith(new Error("MCP server sent a malformed JSON-RPC frame"));
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
    // Notifications (no id) are ignored.
  }

  private failWith(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    liveClients.delete(this);
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.failAll(e);
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}

function truncate(text: string, max = 500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

// Registry of live clients so tests (and a future shutdown hook) can reap the
// child processes instead of leaving orphans behind.
const liveClients = new Set<McpClient>();

/** Kill and reap every live MCP child process (e.g. on shutdown / test teardown). */
export function closeAllMcpClients(): void {
  for (const c of liveClients) c.close();
  liveClients.clear();
}

/**
 * Build ToolDefs for every enabled MCP server in `cfg`. Async because each
 * server's tools/list must be fetched during the handshake. Returns [] (and
 * spawns nothing) for an empty/default config — zero behavior change.
 */
export async function createMcpTools(
  cfg: HarnessConfig,
  opts: {
    timeoutMs?: number;
    warn?: (msg: string) => void;
    /** #347: redact MCP output before it re-enters context (secrets/PII). */
    redactor?: Redactor;
    /** #347: optional per-call budget gate; returning false halts the call. */
    budget?: { consume(units?: number): boolean };
    /** Injectable ambient environment for deterministic expansion/boundary tests. */
    hostEnv?: HostEnvironment;
  } = {},
): Promise<ToolDef[]> {
  const hostEnv = opts.hostEnv ?? process.env;
  const servers = normalizeMcpServers(cfg.mcp?.servers, hostEnv);
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const baseRedactor = opts.redactor ?? new Redactor();
  const tools: ToolDef[] = [];
  const registeredNames = new Set<string>();

  for (const server of servers) {
    if (!server.enabled) continue;
    const serverRedactor = baseRedactor.withSecrets(sensitiveEnvValues(server));
    if (!isSafeName(server.name, serverRedactor, SAFE_TOOL_COMPONENT, MAX_MCP_NAME_CHARS)) {
      warn("[mcp] skipped a server with an invalid name");
      continue;
    }
    let client: McpClient | undefined;
    try {
      client = new McpClient(server, opts.timeoutMs, hostEnv, serverRedactor);
      await client.initialize();
    } catch (e) {
      client?.close();
      const message = e instanceof Error ? e.message : "unknown error";
      warn(serverRedactor.redact(`[mcp] server "${server.name}" failed to initialize: ${message}`));
      continue;
    }
    // #347 governance: readOnly servers expose read tools (no approval);
    // everything else is write-grade and requires approval (untrusted default).
    const group = server.readOnly ? "read" : "write";
    let registeredForServer = 0;
    for (const t of client.tools) {
      const spec = t.inputSchema;
      const fullName = `mcp__${server.name}__${t.name}`;
      // Provider APIs impose conservative identifier limits. Never rewrite a
      // runtime name (which could collide or call a different remote tool):
      // malformed, oversized, duplicate, or secret-bearing names are skipped.
      if (
        !isSafeName(fullName, serverRedactor, SAFE_TOOL_COMPONENT, MAX_MCP_NAME_CHARS) ||
        registeredNames.has(fullName)
      ) {
        continue;
      }
      registeredNames.add(fullName);
      registeredForServer++;
      tools.push({
        name: fullName,
        group,
        description: truncate(
          serverRedactor.redact(t.description ?? `MCP tool "${t.name}" on server "${server.name}"`),
        ),
        inputSchema: {
          type: "object",
          properties: spec.properties,
          required: spec.required ?? [],
        },
        async handler(args, ctx) {
          // Guard deny-list for MCP tools (security.mcpDenyPatterns).
          if (ctx.guard) {
            const g = ctx.guard.checkMcpTool(fullName);
            if (g.blocked) {
              throw new Error(`MCP tool "${fullName}" is denied by security policy`);
            }
          }
          if (opts.budget && !opts.budget.consume(1)) {
            throw new Error("MCP call halted: budget exhausted");
          }
          const out = await client.callTool(t.name, args);
          return serverRedactor.redact(out);
        },
      });
    }
    if (registeredForServer === 0) client.close();
  }
  return tools;
}
