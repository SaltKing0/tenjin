import { ConfigError } from "../config/loader";
import { VERSION, PRODUCT } from "../version";

export const HELP = `${PRODUCT} v${VERSION} — personal agent harness

Usage:
  tenjin                     interactive REPL in current directory
  tenjin -p "<prompt>"       one-shot: answer and exit
  tenjin --model <id>        override configured model
  tenjin --provider <name>   anthropic | openai
  tenjin --budget <usd>      session spend cap
  tenjin --resume <id>       continue a previous session
  tenjin --fork <id> [n]     branch a copy at event n (default: end)
  tenjin --bot <name>        run as a specific bot
  tenjin bot new|list|init-examples   manage bots
  tenjin tell <bot> <text>   leave a user message in a bot's inbox
  tenjin gateway [--dry-run] always-on gateway (channels, jobs, heartbeats)
                             serves the web console at gateway.listen — no TUI:
                             Tenjin lives in your messaging and your browser.
  tenjin audit [--tail n] [--bot x] [--kind k]   security event trail
  tenjin spend [--days n] [--bot x]              spend across all sessions

Options:
  -h, --help                 show this help
`;

export interface ForkSpec {
  id: string;
  uptoEvent?: number;
}

export interface CliArgs {
  help: boolean;
  print?: string;
  model?: string;
  provider?: string;
  budget?: number;
  resume?: string;
  fork?: ForkSpec;
  bot?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-p":
      case "--print": {
        const rest = argv.slice(i + 1).join(" ").trim();
        if (!rest) throw new ConfigError(`-p requires a prompt string`);
        args.print = rest;
        return args;
      }
      case "--model":
        args.model = argv[++i];
        break;
      case "--provider":
        args.provider = argv[++i];
        break;
      case "--budget":
        args.budget = Number(argv[++i]);
        break;
      case "--resume":
        args.resume = argv[++i];
        break;
      case "--bot":
        args.bot = argv[++i];
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
