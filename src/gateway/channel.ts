import { ConfigError } from "../config/types";

export interface ChannelInbound {
  text: string;
  chatId: number;
  userId: number;
  username?: string;
}

export interface Channel {
  readonly name: string;
  onMessage(handler: (msg: ChannelInbound) => Promise<string | null>): void;
  send(text: string): Promise<void>;
  start(signal: AbortSignal): Promise<void>;
  stop(): void;
}

export type ChannelFactoryContext = Record<string, unknown>;

export type ChannelFactory = (deps: ChannelFactoryContext) => Channel;

const factories = new Map<string, ChannelFactory>();

export function registerChannel(kind: string, factory: ChannelFactory): void {
  factories.set(kind, factory);
}

export function channelFactory(kind: string): ChannelFactory | undefined {
  return factories.get(kind);
}

export function knownChannel(kind: string): boolean {
  return factories.has(kind);
}

registerChannel("telegram", () => {
  throw new ConfigError("telegram channel factory not wired");
});

registerChannel("slack", () => {
  throw new ConfigError("slack channel factory not wired");
});
