import { ConfigError } from "../config/loader";
import { isEffortLevel, type EffortLevel } from "../agent/effort";
import { VERSION, PRODUCT } from "../version";

export const HELP = `${PRODUCT} v${VERSION} — personal agent harness

Usage:
  tenjin                     interactive REPL in current directory
  tenjin -p "<prompt>"       one-shot: answer and exit
  tenjin --json -p "<prompt>"  one-shot as newline-delimited JSON (events + final stats block)
  tenjin --model <id>        override configured model
  tenjin --provider <name>   anthropic | openai
  tenjin --budget <usd>      session spend cap
  tenjin --effort <level>    low|medium|high|max effort dial for a one-shot run
  tenjin --resume <id>       continue a previous session
  tenjin --fork <id> [n]     branch a copy at event n (default: end)
  tenjin --bot <name>        run as a specific bot
  tenjin bot new|list|export|import|init-examples   manage & package bots
  tenjin bot search <repo> [query]   list bot packages in a git catalog repo
  tenjin bot install <repo>/<name> [--yes]   install a bot from a git catalog
  tenjin bot publish <name> --to <repo> [--push]   export a bot into a catalog
  tenjin tell <bot> <text>   leave a user message in a bot's inbox
  tenjin arena "<prompt>" --models <ref,ref,...>   race one prompt through
                            several models in parallel. refs use provider:model
                            (e.g. anthropic:claude-opus-4,openai:gpt-4o).
                            Options: --budget <usd> cap the summed spend,
                            --winner <n> mark the winning entry (1-based).
  tenjin gateway [--dry-run] always-on gateway (channels, jobs, heartbeats)
                             serves the web console at gateway.listen — no TUI:
                             Tenjin lives in your messaging and your browser.
  tenjin audit [--tail n] [--bot x] [--kind k]   security event trail
  tenjin spend [--days n] [--bot x]              spend across all sessions
  tenjin job list|add|rm|run                     manage scheduled gateway jobs
                             job list            list jobs with nextDue/lastRun
                             job add <bot> "<cron>" "<prompt>"   add a job
                             job rm <id>         remove a job
                             job run <id>        run a job immediately
                             (gateway picks up changes via SIGHUP or restart)

Options:
  -h, --help                 show this help
  -v, --version              print the version and exit
`;

export interface ForkSpec {
  id: string;
  uptoEvent?: number;
}

export interface CliArgs {
  help: boolean;
  version: boolean;
  print?: string;
  /** B13-7: emit the one-shot run as newline-delimited JSON (must precede -p). */
  json?: boolean;
  model?: string;
  provider?: string;
  budget?: number;
  effort?: EffortLevel;
  resume?: string;
  fork?: ForkSpec;
  bot?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, version: false };
  let i = 0;
  /** Read the next argv token as a required value; throw when it is missing. */
  const needValue = (flag: string): string => {
    const v = argv[++i];
    if (!v) throw new ConfigError(`${flag} requires a value`);
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      case "-p":
      case "--print": {
        const rest = argv.slice(i + 1).join(" ").trim();
        if (!rest) throw new ConfigError(`-p requires a prompt string`);
        args.print = rest;
        return args;
      }
      case "--model":
        args.model = needValue("--model");
        break;
      case "--json":
      case "--ndjson":
        args.json = true;
        break;
      case "--provider":
        args.provider = needValue("--provider");
        break;
      case "--budget": {
        const raw = needValue("--budget");
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          throw new ConfigError(`--budget must be a number, got "${raw}"`);
        }
        args.budget = n;
        break;
      }
      case "--effort": {
        const v = argv[++i];
        if (!isEffortLevel(v)) {
          throw new ConfigError(`--effort must be one of: low, medium, high, max`);
        }
        args.effort = v;
        break;
      }
      case "--resume":
        args.resume = needValue("--resume");
        break;
      case "--bot":
        args.bot = needValue("--bot");
        break;
      case "--fork": {
        const id = argv[++i];
        if (!id) throw new ConfigError(`--fork requires a session id`);
        let uptoEvent: number | undefined;
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          uptoEvent = Number(next);
          i++;
        }
        args.fork = { id, uptoEvent };
        break;
      }
      default:
        throw new ConfigError(`Unknown argument: ${a}\n\n${HELP}`);
    }
  }
  return args;
}
