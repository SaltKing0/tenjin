import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings, applySettings, detectModels, testProvider, DetectTimeoutError } from "../src/gateway/settings";
import { loadConfig, providersFile } from "../src/config/loader";
import { ProviderRegistry } from "../src/provider/registry";
import type { HarnessConfig } from "../src/config/types";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-set-"));
  project = mkdtempSync(join(tmpdir(), "tj-set-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

function setup() {
  require("node:fs").writeFileSync(join(home, "config.yaml"), "model: claude-sonnet-4-5\n");
  const { config } = loadConfig(project, home, { skipModelCheck: true });
  const registry = new ProviderRegistry();
  const auditLines: string[] = [];
  const deps = {
    home,
    config,
    registry,
    audit: (detail: string) => auditLines.push(detail),
  };
  return { deps, config, registry, auditLines };
}

describe("getSettings", () => {
  test("reports env-sourced keys masked", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-abcdefghijklmnop";
    const { deps } = setup();
    const s = getSettings(deps);
    expect(s.anthropic.configured).toBe(true);
    expect(s.anthropic.source).toBe("env");
    expect(s.anthropic.masked).toContain("…");
    expect(s.anthropic.masked).not.toContain("abcdefghijklm");
  });

  test("unconfigured provider reports none", () => {
    const { deps } = setup();
    const s = getSettings(deps);
    expect(s.anthropic.configured).toBe(false);
    expect(s.anthropic.source).toBe("none");
    expect(s.openai.masked).toBeNull();
  });

  test("never leaks raw keys", () => {
    process.env.OPENAI_API_KEY = "sk-secret-value-123456";
    const { deps } = setup();
    expect(JSON.stringify(getSettings(deps))).not.toContain("sk-secret-value-123456");
  });
});

describe("applySettings", () => {
  test("saves anthropic key to providers.yaml and applies to registry", () => {
    const { deps, config, registry, auditLines } = setup();
    applySettings(deps, { anthropic: { apiKey: "sk-live-key-9876" } });

    const reloaded = loadConfig(project, home, { skipModelCheck: true }).config;
    expect(reloaded.providers?.anthropic?.apiKey).toBe("sk-live-key-9876");

    // registry now serves anthropic without env key
    process.env.ANTHROPIC_API_KEY = "";
    delete process.env.ANTHROPIC_API_KEY;
    expect(registry.get("anthropic").name).toBe("anthropic");
    expect(auditLines.some((l) => l.includes("providers updated"))).toBe(true);
    void config;
  });

  test("openai baseUrl + key stored together", () => {
    const { deps, config } = setup();
    applySettings(deps, {
      openai: { apiKey: "sk-oai", baseUrl: "https://api.deepseek.com/v1" },
    });
    expect(config.providers?.openai?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(config.providers?.openai?.apiKey).toBe("sk-oai");
  });

  test("models.default normalizes to provider:model and syncs legacy fields", () => {
    const { deps, config } = setup();
    applySettings(deps, { models: { default: "claude-sonnet-4-5" } });
    expect(config.models?.default).toBe("anthropic:claude-sonnet-4-5");
    expect(config.model).toBe("claude-sonnet-4-5");
    expect(config.provider).toBe("anthropic");
  });

  test("invalid model ref rejected without writing", () => {
    const { deps, config } = setup();
    expect(() =>
      applySettings(deps, { models: { default: "palm:x" } }),
    ).toThrow(/unknown provider/);
    expect(config.models?.default).toBeUndefined();
  });

  test("clearing cheap tier works", () => {
    const { deps, config } = setup();
    applySettings(deps, { models: { default: "anthropic:m", cheap: "openai:c" } });
    applySettings(deps, { models: { default: "anthropic:m", cheap: "" } });
    expect(config.models?.cheap).toBeUndefined();
  });

  test("preserves pricing.default across a console save", () => {
    const { deps, config } = setup();
    config.pricing = { default: { inputPerMTok: 4, outputPerMTok: 12 } };
    applySettings(deps, { anthropic: { apiKey: "sk-live-key-9876" } });
    const reloaded = loadConfig(project, home).config;
    expect(reloaded.pricing?.default).toEqual({ inputPerMTok: 4, outputPerMTok: 12 });
  });
});

describe("detectModels", () => {
  test("openai-compatible /models returns sorted ids", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname !== "/v1/models") return new Response("nf", { status: 404 });
        if (req.headers.get("authorization") !== "Bearer sk-detect") {
          return new Response("bad auth", { status: 401 });
        }
        return Response.json({
          data: [{ id: "z-model" }, { id: "a-model" }, { id: "m-model" }],
        });
      },
    });
    try {
      const models = await detectModels({
        provider: "openai",
        baseUrl: `http://localhost:${server.port}/v1`,
        apiKey: "sk-detect",
      });
      expect(models).toEqual(["a-model", "m-model", "z-model"]);
    } finally {
      server.stop(true);
    }
  });

  test("anthropic uses x-api-key header", async () => {
    let seenKey = "";
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seenKey = req.headers.get("x-api-key") ?? "";
        return Response.json({ data: [{ id: "claude-x" }] });
      },
    });
    try {
      const models = await detectModels({
        provider: "anthropic",
        baseUrl: `http://localhost:${server.port}/v1`,
        apiKey: "sk-ant-test",
      });
      expect(seenKey).toBe("sk-ant-test");
      expect(models).toEqual(["claude-x"]);
    } finally {
      server.stop(true);
    }
  });

  test("upstream error surfaces message", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("denied", { status: 401 }),
    });
    try {
      await expect(
        detectModels({ provider: "openai", baseUrl: `http://localhost:${server.port}/v1`, apiKey: "sk-test" }),
      ).rejects.toThrow(/401/);
    } finally {
      server.stop(true);
    }
  });

  test("hanging server times out after injected timeoutMs", async () => {
    // HTTP server that accepts connections but never responds
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Promise<Response>(() => {
          // never resolve
        }),
    });
    try {
      const t = 150; // quick timeout
      const started = Date.now();
      await expect(
        detectModels(
          { provider: "openai", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "sk-test" },
          t,
        ),
      ).rejects.toThrow(DetectTimeoutError);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(t - 50);
      expect(elapsed).toBeLessThan(t * 4); // generous upper bound
    } finally {
      server.stop(true);
    }
  });
});

describe("live-apply through gateway objects", () => {
  test("applied default model flows into botModelRef without restart", async () => {
    const { createBot, botModelRef, resolveBot } = await import("../src/bots/profile");
    createBot(home, "worker");
    const { deps, config, registry } = setup();
    const profile = resolveBot(home, "worker");

    const before = botModelRef(profile, config);
    expect(before.model).toBe("claude-sonnet-4-5");

    applySettings(deps, {
      openai: { apiKey: "sk-new", baseUrl: "https://custom.example/v1" },
      models: { default: "openai:new-model" },
    });

    const after = botModelRef(profile, config);
    expect(after).toEqual({ provider: "openai", model: "new-model" });

    // registry serves openai with the new key — no env, no restart
    delete process.env.OPENAI_API_KEY;
    expect(registry.get("openai").name).toBe("openai");
  });

  test("console api POST /api/settings applies to shared config object", async () => {
    const { startHttpServer } = await import("../src/gateway/http");
    const { createConsoleApi } = await import("../src/gateway/console-api");
    const { AuditLog } = await import("../src/audit/log");

    const { deps, config, registry } = setup();
    let server: any = null;
    try {
      server = startHttpServer({
        config: { port: 0, host: "127.0.0.1", token: "t" },
        handleMessage: async () => null,
        status: () => ({}),
        api: createConsoleApi({
          home,
          cwd: home,
          config,
          registry,
          audit: new AuditLog(join(home, "audit.jsonl")),
        }),
      });
      const res = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({
          anthropic: { apiKey: "sk-via-console" },
          models: { default: "anthropic:console-model" },
        }),
      });
      expect(res.status).toBe(200);

      // same config object the gateway uses is mutated
      expect(config.providers?.anthropic?.apiKey).toBe("sk-via-console");
      expect(config.model).toBe("console-model");
      expect(registry.get("anthropic").name).toBe("anthropic");

      // persisted for next boot
      const reloaded = loadConfig(project, home, { skipModelCheck: true }).config;
      expect(reloaded.model).toBe("console-model");
    } finally {
      server?.stop();
    }
  });

  test("api accepts a manual model id typed outside the detected list", async () => {
    // The settings panel lets the user type a model id that /models did not
    // return (e.g. deepseek-chat). The panel prefixes it with the provider
    // card (openai:), so the server should accept and apply that prefixed ref.
    const { startHttpServer } = await import("../src/gateway/http");
    const { createConsoleApi } = await import("../src/gateway/console-api");
    const { AuditLog } = await import("../src/audit/log");

    const { deps, config, registry } = setup();
    let server: any = null;
    try {
      server = startHttpServer({
        config: { port: 0, host: "127.0.0.1", token: "t" },
        handleMessage: async () => null,
        status: () => ({}),
        api: createConsoleApi({
          home,
          cwd: home,
          config,
          registry,
          audit: new AuditLog(join(home, "audit.jsonl")),
        }),
      });
      const res = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({
          models: { default: "openai:deepseek-chat" },
        }),
      });
      expect(res.status).toBe(200);

      // normalized and applied live to the shared config object
      expect(config.models?.default).toBe("openai:deepseek-chat");
      expect(config.model).toBe("deepseek-chat");
      expect(config.provider).toBe("openai");

      const reloaded = loadConfig(project, home, { skipModelCheck: true }).config;
      expect(reloaded.model).toBe("deepseek-chat");
    } finally {
      server?.stop();
    }
  });

  test("api rejects an invalid manual model ref with 400 and leaves config unchanged", async () => {
    // A typo such as "palm:x" must surface a server error instead of silently
    // landing in the config.
    const { startHttpServer } = await import("../src/gateway/http");
    const { createConsoleApi } = await import("../src/gateway/console-api");
    const { AuditLog } = await import("../src/audit/log");

    const { deps, config, registry } = setup();
    let server: any = null;
    try {
      server = startHttpServer({
        config: { port: 0, host: "127.0.0.1", token: "t" },
        handleMessage: async () => null,
        status: () => ({}),
        api: createConsoleApi({
          home,
          cwd: home,
          config,
          registry,
          audit: new AuditLog(join(home, "audit.jsonl")),
        }),
      });
      const res = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({
          models: { default: "palm:x" },
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain("unknown provider");

      // nothing changed on the shared config
      expect(config.models?.default).toBeUndefined();
      expect(config.model).toBe("claude-sonnet-4-5");
    } finally {
      server?.stop();
    }
  });

  test("detect endpoint returns 504 with provider hint on timeout", async () => {
    const { startHttpServer } = await import("../src/gateway/http");
    const { createConsoleApi } = await import("../src/gateway/console-api");
    const { AuditLog } = await import("../src/audit/log");

    const { deps, registry } = setup();
    // upstream that never responds
    const upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Promise<Response>(() => {
          // never resolve
        }),
    });
    let server: any = null;
    try {
      server = startHttpServer({
        config: { port: 0, host: "127.0.0.1", token: "t" },
        handleMessage: async () => null,
        status: () => ({}),
        api: createConsoleApi({
          home,
          cwd: home,
          config: deps.config,
          registry,
          audit: new AuditLog(join(home, "audit.jsonl")),
        }),
      });
      const res = await fetch(`http://127.0.0.1:${server.port}/api/settings/detect`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "sk-test",
          timeoutMs: 150,
        }),
      });
      expect(res.status).toBe(504);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain("openai /models");
      expect(body.error).toContain("timed out");
    } finally {
      server?.stop();
      upstream.stop(true);
    }
  });
});

describe("testProvider", () => {
  test("valid openai key reports ok with status", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (req.headers.get("authorization") !== "Bearer sk-ok") {
          return new Response("bad auth", { status: 401 });
        }
        return new Response("", { status: 200 });
      },
    });
    try {
      const r = await testProvider({
        provider: "openai",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-ok",
      });
      expect(r.ok).toBe(true);
      expect(r.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("invalid key reports status and provider hint, does not throw", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("invalid x-api-key", { status: 401 }),
    });
    try {
      const r = await testProvider({
        provider: "anthropic",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "bad",
      });
      expect(r.ok).toBe(false);
      expect(r.status).toBe(401);
      expect(r.error).toContain("/models 401");
    } finally {
      server.stop(true);
    }
  });

  test("unknown provider returns ok:false instead of throwing", async () => {
    const r = await testProvider({ provider: "bogus" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unknown provider");
  });

  test("unreachable endpoint surfaces a message", async () => {
    const r = await testProvider(
      { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-x" },
      300,
    );
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error!.length).toBeGreaterThan(0);
  });
});
