import { ConfigError } from "../config/types";

export interface TelegramOptions {
  token: string;
  apiBase?: string;
  defaultBot: string;
  allowedUsers: number[];
  pollTimeoutSec?: number;
  onReject?: (userId: number) => void;
}

export interface TgUser {
  id: number;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface InboundMessage {
  chatId: number;
  userId: number;
  username?: string;
  text: string;
}

const DEFAULT_API_BASE = "https://api.telegram.org";

export function routeText(
  text: string,
  defaultBot: string,
  availableBots: string[],
): { bot: string; rest: string } {
  const trimmed = text.trim();
  const mention = /^@([a-z0-9-]+)\s+([\s\S]+)$/i.exec(trimmed);
  if (mention && mention[1] && mention[2] !== undefined) {
    const name = mention[1].toLowerCase();
    if (availableBots.includes(name)) {
      return { bot: name, rest: mention[2].trim() };
    }
  }
  return { bot: defaultBot, rest: trimmed };
}

export class TelegramChannel {
  private offset = 0;

  constructor(
    private opts: TelegramOptions,
    private onMessage: (msg: InboundMessage) => Promise<string | null>,
    private log: (line: string) => void,
  ) {
    if (!opts.token) throw new ConfigError("telegram token is empty");
    if (!opts.defaultBot) throw new ConfigError("telegram defaultBot is not set");
  }

  private url(method: string): string {
    const base = (this.opts.apiBase || DEFAULT_API_BASE).replace(/\/$/, "");
    return `${base}/bot${this.opts.token}/${method}`;
  }

  async send(chatId: number, text: string): Promise<void> {
    const res = await fetch(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      throw new Error(`telegram sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  async getUpdates(timeoutSec: number): Promise<TgUpdate[]> {
    const res = await fetch(
      this.url(`getUpdates?offset=${this.offset}&timeout=${timeoutSec}`),
    );
    if (!res.ok) {
      throw new Error(`telegram getUpdates ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as { result?: TgUpdate[] };
    return data.result ?? [];
  }

  async pollOnce(): Promise<number> {
    const updates = await this.getUpdates(this.opts.pollTimeoutSec ?? 25);
    let handled = 0;
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      const msg = update.message;
      if (!msg?.text || !msg.from) continue;
      if (!this.opts.allowedUsers.includes(msg.from.id)) {
        this.log(`telegram: ignored unauthorized user ${msg.from.id}`);
        this.opts.onReject?.(msg.from.id);
        continue;
      }
      handled++;
      try {
        const reply = await this.onMessage({
          chatId: msg.chat.id,
          userId: msg.from.id,
          username: msg.from.username,
          text: msg.text,
        });
        if (reply) await this.send(msg.chat.id, reply);
      } catch (e) {
        this.log(`telegram: handler error: ${(e as Error).message}`);
        await this.send(msg.chat.id, `error: something went wrong handling that.`).catch(() => {});
      }
    }
    return handled;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.log("telegram: polling started");
    while (!signal.aborted) {
      try {
        await this.pollOnce();
      } catch (e) {
        this.log(`telegram: poll error: ${(e as Error).message}`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    }
    this.log("telegram: polling stopped");
  }
}
