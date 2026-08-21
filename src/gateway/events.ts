export interface GatewayEvent {
  id: number;
  type: string;
  ts: number;
  payload: unknown;
}

type Listener = (e: GatewayEvent) => void;

const listeners = new Set<Listener>();
const history: GatewayEvent[] = [];
const HISTORY_MAX = 500;
let nextId = 1;

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(fn);
  };
}

export function emit(type: string, payload: unknown): GatewayEvent {
  const ev: GatewayEvent = { id: nextId++, type, ts: Date.now(), payload };
  history.push(ev);
  if (history.length > HISTORY_MAX) history.shift();
  for (const fn of [...listeners]) fn(ev);
  return ev;
}

export function historySince(afterId: number): GatewayEvent[] {
  const out: GatewayEvent[] = [];
  for (const e of history) if (e.id > afterId) out.push(e);
  return out;
}

export function formatEvent(e: GatewayEvent): string {
  return `id: ${e.id}\ndata: ${JSON.stringify({ type: e.type, payload: e.payload })}\n\n`;
}
