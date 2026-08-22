import { describe, test, expect } from "bun:test";
import {
  CapabilityRegistry,
  createPluginApi,
  loadPlugin,
  type PluginApi,
  type PluginContract,
} from "../src/plugins/registry";

// ---- Compile-time exhaustiveness of the PluginApi surface ------------------
// PluginApi must expose ONLY the five narrow registration methods — an unknown
// method is impossible at compile time. These type-level checks are enforced
// by `tsc --noEmit`; if the interface ever grows a method, `_Exhaustive`
// resolves to `never` and the assignment fails to typecheck.
type PluginApiKeys = keyof PluginApi;
type ExpectedKeys =
  | "registerProvider"
  | "registerTool"
  | "registerHook"
  | "registerSkill"
  | "registerSandbox";
type _Exhaustive = [PluginApiKeys] extends [ExpectedKeys]
  ? [ExpectedKeys] extends [PluginApiKeys]
    ? true
    : never
  : never;
const _exhaustive: _Exhaustive = true;
void _exhaustive;

function makePlugin(
  id: string,
  register: PluginContract["register"],
  capabilities: PluginContract["capabilities"] = ["tool"],
): PluginContract {
  return { id, name: id, description: `plugin ${id}`, capabilities, register };
}

describe("B15-2 register/list/unload lifecycle per capability kind", () => {
  test("all capability kinds register, list and unload", () => {
    const reg = new CapabilityRegistry();
    const api = createPluginApi(reg, "p1");
    api.registerProvider("prov", {});
    api.registerTool("toolA", {});
    api.registerHook("hookA", {});
    api.registerSkill("skillA", {});
    api.registerSandbox("sandA", {});
    // session / storage have no PluginApi method — use the direct register.
    reg.register("session", "sessA", {}, { ownerPluginId: "p1" });
    reg.register("storage", "storeA", {}, { ownerPluginId: "p1" });

    expect(reg.size).toBe(7);
    expect(reg.list("tool").map((r) => r.name)).toEqual(["toolA"]);
    expect(reg.get("session", "sessA")?.impl).toBeDefined();
    expect(reg.listByOwner("p1").length).toBe(7);

    reg.unloadOwner("p1");
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
  });

  test("entries carry version and owner id", () => {
    const reg = new CapabilityRegistry();
    loadPlugin(
      reg,
      makePlugin("p", (api) => api.registerTool("t", {}, { version: "1.2.3" })),
    );
    const entry = reg.get("tool", "t");
    expect(entry?.ownerPluginId).toBe("p");
    expect(entry?.version).toBe("1.2.3");
  });
});

describe("B15-2 owner-scoped unload removes exactly that plugin's entries", () => {
  test("unloadOwner(plugin) leaves other plugins untouched", () => {
    const reg = new CapabilityRegistry();
    loadPlugin(reg, makePlugin("p1", (api) => api.registerTool("toolX", {})));
    loadPlugin(
      reg,
      makePlugin("p2", (api) => {
        api.registerTool("toolY", {});
        api.registerProvider("provZ", {});
      }),
    );
    expect(reg.size).toBe(3);

    reg.unloadOwner("p2");
    expect(reg.get("tool", "toolY")).toBeUndefined();
    expect(reg.get("provider", "provZ")).toBeUndefined();
    expect(reg.get("tool", "toolX")).toBeDefined(); // p1 untouched
    expect(reg.size).toBe(1);
  });
});

describe("B15-2 PluginApi surface is narrow and typed", () => {
  test("runtime surface exposes exactly the five registration methods", () => {
    const api = createPluginApi(new CapabilityRegistry(), "p");
    expect(Object.keys(api).sort()).toEqual([
      "registerHook",
      "registerProvider",
      "registerSandbox",
      "registerSkill",
      "registerTool",
    ]);
  });
});

describe("B15-2 throwing plugin is contained; host boots", () => {
  test("a throwing register() rolls back its partial entries and is contained", () => {
    const reg = new CapabilityRegistry();
    const bad = makePlugin("bad", (api) => {
      api.registerTool("partial", {}); // registered before the throw
      throw new Error("boom");
    });
    const res = loadPlugin(reg, bad);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("boom");
    // Partial entries rolled back; nothing left behind.
    expect(reg.size).toBe(0);

    // Host still boots: a good plugin loads fine afterwards.
    const good = makePlugin("good", (api) => api.registerTool("ok", {}));
    expect(loadPlugin(reg, good).ok).toBe(true);
    expect(reg.get("tool", "ok")).toBeDefined();
  });
});

describe("B15-2 double-registration is rejected cleanly", () => {
  test("same kind+name from any plugin is rejected; same name other kind is fine", () => {
    const reg = new CapabilityRegistry();
    const api1 = createPluginApi(reg, "p1");
    api1.registerTool("dup", {});
    // Same plugin re-registers same kind+name.
    expect(() => api1.registerTool("dup", {})).toThrow(/already registered/);
    // A different plugin cannot shadow it either.
    const api2 = createPluginApi(reg, "p2");
    expect(() => api2.registerTool("dup", {})).toThrow(/already registered/);
    // Same name under a different kind is allowed.
    expect(() => api1.registerHook("dup", {})).not.toThrow();
    // Unknown kind is rejected.
    expect(() => reg.register("nope" as any, "x", {}, { ownerPluginId: "p1" })).toThrow(
      /Unknown capability kind/,
    );
  });
});
