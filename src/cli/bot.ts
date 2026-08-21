import { stdout, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { tenjinHome, ConfigError } from "../config/loader";
import { createBot, listBots, EXAMPLE_BOTS } from "../bots/profile";
import { exportBot, importBot } from "../bots/package";
import {
  installCatalogPackage,
  parseCatalogRef,
  PKG_DIR,
  previewCatalogInstall,
  publishBotToCatalog,
  searchCatalog,
} from "../bots/catalog";

export async function botCommand(args: string[]): Promise<number> {
  const [sub, name] = args;
  const home = tenjinHome();
  try {
    switch (sub) {
      case "new": {
        if (!name) {
          stdout.write("usage: tenjin bot new <name>\n");
          return 2;
        }
        const dir = createBot(home, name);
        stdout.write(`created bot at ${dir} — edit SOUL.md to give it a role\n`);
        return 0;
      }
      case "list": {
        const bots = listBots(home);
        if (bots.length === 0) {
          stdout.write("no bots yet — tenjin bot init-examples or tenjin bot new <name>\n");
          return 0;
        }
        for (const b of bots) stdout.write(`${b}\n`);
        return 0;
      }
      case "export": {
        if (!name) {
          stdout.write("usage: tenjin bot export <name>\n");
          return 2;
        }
        const res = exportBot(home, name, { cwd: process.cwd() });
        stdout.write(`exported ${res.name} → ${res.file}\n`);
        stdout.write(`  included (${res.manifest.length}): ${res.manifest.join(", ") || "(nothing)"}\n`);
        stdout.write(
          "  note: sessions, memory and inbox are never packaged; providers.yaml keys stay on this machine\n",
        );
        return 0;
      }
      case "import": {
        if (!name) {
          stdout.write("usage: tenjin bot import <file.tar.gz>\n");
          return 2;
        }
        const res = importBot(home, name);
        stdout.write(`imported bot as "${res.name}" → ${res.dir}\n`);
        stdout.write(`  will create (${res.files.length}): ${res.files.join(", ") || "(nothing)"}\n`);
        if (res.securityNote) {
          stdout.write(`  WARNING: ${res.securityNote}\n`);
        }
        return 0;
      }
      case "search": {
        // tenjin bot search [repo] [query]
        const repo = args[1];
        const query = args[2];
        if (!repo) {
          stdout.write("usage: tenjin bot search <repo> [query]\n");
          return 2;
        }
        const hits = searchCatalog(repo, query);
        if (hits.length === 0) {
          stdout.write(`no packages in ${repo}${query ? ` matching "${query}"` : ""}\n`);
          return 0;
        }
        for (const h of hits) {
          stdout.write(`${h.name}\t${h.description}\n`);
        }
        return 0;
      }
      case "publish": {
        // tenjin bot publish <name> --to <repo> [--push]
        let repo: string | undefined;
        let push = false;
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--to") repo = args[++i];
          else if (args[i] === "--push") push = true;
        }
        if (!name || !repo) {
          stdout.write("usage: tenjin bot publish <name> --to <repo> [--push]\n");
          return 2;
        }
        const res = publishBotToCatalog(home, name, repo, { push });
        stdout.write(`published "${res.name}" → ${repo} (${res.files.length} files, ${res.commit}) in ${PKG_DIR}/${res.name}/\n`);
        stdout.write("  note: sessions, memory and inbox are never packaged; providers.yaml keys stay on this machine\n");
        return 0;
      }
      case "install": {
        // tenjin bot install <repo>/<name> [--yes]
        let yes = false;
        for (let i = 1; i < args.length; i++) if (args[i] === "--yes") yes = true;
        const refArg = args[1];
        if (!refArg) {
          stdout.write("usage: tenjin bot install <repo>/<name> [--yes]\n");
          return 2;
        }
        const ref = parseCatalogRef(refArg);
        const { preview, cleanup, repoDir } = previewCatalogInstall(home, ref);
        try {
          stdout.write(`installing "${preview.name}" from ${ref.repo}\n`);
          stdout.write(`  will create (${preview.files.length}): ${preview.files.join(", ") || "(nothing)"}\n`);
          if (!yes) {
            const rl = createInterface({ input: stdin, output: stdout });
            const answer = await rl.question(`install this bot? [y/N] `);
            rl.close();
            if (answer.trim().toLowerCase() !== "y") {
              stdout.write("aborted\n");
              return 0;
            }
          }
          const res = installCatalogPackage(home, repoDir, ref.name, cleanup);
          stdout.write(`installed bot as "${res.name}" → ${res.dir}\n`);
          if (res.securityNote) {
            stdout.write(`  WARNING: ${res.securityNote}\n`);
          }
          return 0;
        } catch (e) {
          cleanup();
          throw e;
        }
      }
      case "init-examples": {
        let created = 0;
        for (const ex of EXAMPLE_BOTS) {
          try {
            createBot(home, ex.name, { soul: ex.soul });
            created++;
          } catch {
            // already exists
          }
        }
        stdout.write(
          created > 0
            ? `created ${created} example bot(s): ${EXAMPLE_BOTS.map((b) => b.name).join(", ")}\n`
            : "example bots already exist\n",
        );
        return 0;
      }
      default:
        stdout.write(
          "usage: tenjin bot new|list|export|import|init-examples\n" +
            "       tenjin bot export <name>               create a portable <name>.tar.gz\n" +
            "       tenjin bot import <file.tar.gz>        restore a bot from a package\n" +
            "       tenjin bot search <repo> [query]       list packages in a git catalog\n" +
            "       tenjin bot install <repo>/<name> [--yes]   install a bot from a git catalog\n" +
            "       tenjin bot publish <name> --to <repo> [--push]   export a bot into a catalog\n",
        );
        return 2;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      stdout.write(`config error: ${e.message}\n`);
      return 2;
    }
    stdout.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

