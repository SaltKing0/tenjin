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

Options:
  -h, --help                 show this help
`;

export interface CliArgs {
  help: boolean;
  print?: string;
  model?: string;
  provider?: string;
  budget?: number;
  resume?: string;
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
      default:
        throw new ConfigError(`Unknown argument: ${a}\n\n${HELP}`);
    }
  }
  return args;
}
