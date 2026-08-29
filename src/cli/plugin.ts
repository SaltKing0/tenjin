import { stdout } from "node:process";
import { tenjinHome, ConfigError } from "../config/loader";
import {
  addMarketplace,
  installPlugin,
  updatePlugin,
  listInstalled,
  listMarketplaces,
} from "../plugins/marketplace";

/**
 * `tenjin plugin` — Git-first marketplace (B15-4, #425).
 *
 *   tenjin plugin marketplace add <url>   add a marketplace (any git repo with
 *                                         a marketplace.json at its root)
 *   tenjin plugin marketplace list        list added marketplaces
 *   tenjin plugin install <name>          install an @org/plugin by name
 *   tenjin plugin update <name> [--yes]   update to the newest published version
 *   tenjin plugin list                    list installed plugins
 *
 * Installs are manifest-first validated and remain inactive/experimental.
 * Plugin modules and install-scripts are NEVER executed by this command;
 * tarball sources are sha256 digest-verified before anything is written.
 */
export async function pluginCommand(args: string[]): Promise<number> {
  const home = tenjinHome();
  const [sub, arg1] = args;
  try {
    switch (sub) {
      case "marketplace": {
        if (arg1 === "add") {
          const url = args[2];
          if (!url) {
            stdout.write("usage: tenjin plugin marketplace add <url>\n");
            return 2;
          }
          const res = addMarketplace(home, url);
          stdout.write(`added marketplace "${res.name}" (${res.version}) from ${url}\n`);
          stdout.write(`  plugins (${res.plugins.length}): ${res.plugins.join(", ")}\n`);
          return 0;
        }
        if (arg1 === "list") {
          const list = listMarketplaces(home);
          if (list.length === 0) {
            stdout.write("no marketplaces added — tenjin plugin marketplace add <url>\n");
            return 0;
          }
          for (const m of list) stdout.write(`${m.name}\t${m.version}\t${m.url}\n`);
          return 0;
        }
        stdout.write("usage: tenjin plugin marketplace add <url> | list\n");
        return 2;
      }
      case "install": {
        const name = arg1;
        if (!name) {
          stdout.write("usage: tenjin plugin install <name>\n");
          return 2;
        }
        const res = await installPlugin(home, name);
        stdout.write(`installed "${res.name}" v${res.version} → ${res.dir}\n`);
        stdout.write(`  entry file: ${res.entryFile}\n`);
        stdout.write("  status: inactive (experimental; plugin code was not executed)\n");
        if (res.installScriptIgnored !== undefined) {
          stdout.write("  note: declared install-script was NOT executed (supply-chain law)\n");
        }
        return 0;
      }
      case "update": {
        const name = arg1;
        if (!name) {
          stdout.write("usage: tenjin plugin update <name> [--yes]\n");
          return 2;
        }
        const force = args.includes("--yes") || args.includes("-y");
        const res = await updatePlugin(home, name, { force });
        stdout.write(
          `updated "${res.name}" ${res.from} -> ${res.to} (${res.breaking ? "BREAKING" : "minor/patch"}) → ${res.dir}\n`,
        );
        stdout.write("  status: inactive (experimental; plugin code was not executed)\n");
        return 0;
      }
      case "list": {
        const list = listInstalled(home);
        if (list.length === 0) {
          stdout.write("no plugins installed — tenjin plugin install <name>\n");
          return 0;
        }
        for (const p of list)
          stdout.write(`${p.name}\tv${p.version}\t${p.status ?? "inactive"}\t(${p.marketplace})\n`);
        return 0;
      }
      default:
        stdout.write(
          "usage: tenjin plugin marketplace add <url> | marketplace list | install <name> | update <name> [--yes] | list\n",
        );
        return 2;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      stdout.write(`config error: ${e.message}\n`);
      return 2;
    }
    stdout.write(`error: ${(e as Error)?.message ?? e}\n`);
    return 1;
  }
}
