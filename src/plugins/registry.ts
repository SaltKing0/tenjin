// ===========================================================================
// B15-2 Typed capability registry + PluginApi register(api) contract (#414)
// ---------------------------------------------------------------------------
// Plugins are UNTRUSTED plain modules. register(api) is the ONLY privileged
// surface. Capability kinds: provider | tool | skill | session | sandbox |
// storage | hook. The registry tracks every entry with {version,
// owner_plugin_id} so an owner's entries can be unloaded/rolled back exactly.
// A throwing plugin's register() is CONTAINED — it cannot break host boot.
// ===========================================================================

export type CapabilityKind =
  | "provider"
  | "tool"
  | "skill"
  | "session"
  | "sandbox"
  | "storage"
  | "hook";

export const CAPABILITY_KINDS: readonly CapabilityKind[] = [
  "provider",
  "tool",
  "skill",
  "session",
  "sandbox",
  "storage",
  "hook",
];

/** A registered capability entry, always carrying its owner + version. */
export interface Registration {
  kind: CapabilityKind;
  name: string;
  /** Implementation handle; typed per kind by the caller, opaque here. */
  impl: unknown;
  version: string;
  ownerPluginId: string;
}

/**
 * Plugin contract: one plain module export. No DI, no meta-framework. The
 * plugin declares what it provides and does all of its registration inside
 * register(api) — which may throw; the loader contains the failure.
 */
export interface PluginContract {
  id: string;
  name: string;
  description: string;
  capabilities: CapabilityKind[];
  register(api: PluginApi): void;
}

/**
 * The narrow, exhaustively-typed surface injected into a plugin's
 * register(api). Exposes ONLY these five registration methods — a plugin
 * cannot reach the rest of the harness through it. Unknown methods are a
 * compile-time error (no extra members).
 */
export interface PluginApi {
  registerProvider(name: string, impl: unknown, opts?: { version?: string }): void;
  registerTool(name: string, impl: unknown, opts?: { version?: string }): void;
  registerHook(name: string, impl: unknown, opts?: { version?: string }): void;
  registerSkill(name: string, impl: unknown, opts?: { version?: string }): void;
  registerSandbox(name: string, impl: unknown, opts?: { version?: string }): void;
}

const DEFAULT_VERSION = "0.0.0";

export class CapabilityRegistry {
  private entries: Registration[] = [];

  /** Register a capability. Double-registration of the same kind+name is
   *  rejected cleanly (a plugin cannot silently shadow another's entry). */
  register(
    kind: CapabilityKind,
    name: string,
    impl: unknown,
    meta: { version?: string; ownerPluginId: string },
  ): void {
    if (!CAPABILITY_KINDS.includes(kind)) {
      throw new Error(`Unknown capability kind "${kind}". Valid: ${CAPABILITY_KINDS.join(", ")}.`);
    }
    if (this.entries.some((e) => e.kind === kind && e.name === name)) {
      throw new Error(
        `Capability "${name}" of kind "${kind}" is already registered (by plugin "${this.findOwner(kind, name)}").`,
      );
    }
    this.entries.push({
      kind,
      name,
      impl,
      version: meta.version ?? DEFAULT_VERSION,
      ownerPluginId: meta.ownerPluginId,
    });
  }

  private findOwner(kind: CapabilityKind, name: string): string {
    return this.entries.find((e) => e.kind === kind && e.name === name)?.ownerPluginId ?? "?";
  }

  /** Look up one registration (undefined when absent). */
  get(kind: CapabilityKind, name: string): Registration | undefined {
    return this.entries.find((e) => e.kind === kind && e.name === name);
  }

  /** List all registrations, optionally filtered by kind. */
  list(kind?: CapabilityKind): Registration[] {
    return kind ? this.entries.filter((e) => e.kind === kind) : [...this.entries];
  }

  /** Everything a single plugin owns (used for scoped unload/rollback). */
  listByOwner(pluginId: string): Registration[] {
    return this.entries.filter((e) => e.ownerPluginId === pluginId);
  }

  /** Remove exactly the entries owned by `pluginId` (owner-scoped unload). */
  unloadOwner(pluginId: string): void {
    this.entries = this.entries.filter((e) => e.ownerPluginId !== pluginId);
  }

  get size(): number {
    return this.entries.length;
  }
}

/** Build a plugin-scoped api: every register() call is bound to the owner id
 *  so unload/rollback can later remove exactly this plugin's entries. */
export function createPluginApi(
  registry: CapabilityRegistry,
  ownerPluginId: string,
): PluginApi {
  const reg = (
    kind: CapabilityKind,
    name: string,
    impl: unknown,
    opts?: { version?: string },
  ) => registry.register(kind, name, impl, { version: opts?.version, ownerPluginId });
  return {
    registerProvider: (n, i, o) => reg("provider", n, i, o),
    registerTool: (n, i, o) => reg("tool", n, i, o),
    registerHook: (n, i, o) => reg("hook", n, i, o),
    registerSkill: (n, i, o) => reg("skill", n, i, o),
    registerSandbox: (n, i, o) => reg("sandbox", n, i, o),
  };
}

export interface LoadResult {
  ok: boolean;
  error?: string;
}

/** Load one plugin. A throwing register() is CONTAINED: the plugin's partial
 *  entries are rolled back and the host continues to boot. */
export function loadPlugin(
  registry: CapabilityRegistry,
  plugin: PluginContract,
): LoadResult {
  try {
    plugin.register(createPluginApi(registry, plugin.id));
    return { ok: true };
  } catch (e) {
    // Roll back anything the plugin registered before it threw.
    registry.unloadOwner(plugin.id);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
