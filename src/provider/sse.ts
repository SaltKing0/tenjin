export interface SseFrame {
  event?: string;
  data: string;
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let aborted = false;
  // B13-2 (#384): on abort, cancel the reader so no orphaned HTTP stream is
  // left polling — the pending read() resolves as done and we throw below.
  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw toAbortError(signal);
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
    }
    if (buf.trim()) {
      const parsed = parseFrame(buf);
      if (parsed) yield parsed;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (signal && (aborted || signal.aborted)) throw toAbortError(signal);
}

function toAbortError(signal: AbortSignal): Error {
  const r = signal.reason;
  if (r instanceof Error) return r;
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function parseFrame(frame: string): SseFrame | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
