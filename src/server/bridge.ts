// plasmod-bridge のアプリ用の窓口（unix socket・JSON 行）につなぐ。
//   ← bridge: hello / permission_request / permission_resolved
//   → bridge: verdict / list_sessions・pane・send・stop（id 付き。result で返る）
import type { PermissionRequest } from "../shared/types";

type Listener = () => void;

export class BridgeClient {
  private pending = new Map<string, PermissionRequest>();
  private sock: { write(data: string | Uint8Array): number; end(): void } | null = null;
  // write が一部しか書けなかったときの書き残し（drain で続きを書く）
  private outq: Uint8Array | null = null;
  private listeners: Listener[] = [];
  private chatListeners: ((thread: string, m: Record<string, unknown>) => void)[] = [];
  private waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private stopped = false;
  connected = false;

  constructor(private path: string) {}

  /** スレッドの新しい発言（app-chat.patch 以降の bridge が流す） */
  onChat(fn: (thread: string, m: Record<string, unknown>) => void) {
    this.chatListeners.push(fn);
  }

  onChange(fn: Listener) {
    this.listeners.push(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  requests(): PermissionRequest[] {
    return [...this.pending.values()];
  }

  start() {
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.sock?.end();
  }

  /** 全部書けるまで確実に送る。Bun の write は一部だけ書いて返すことがある */
  private send(line: string) {
    const data = new TextEncoder().encode(line);
    if (this.outq) {
      const q = new Uint8Array(this.outq.length + data.length);
      q.set(this.outq);
      q.set(data, this.outq.length);
      this.outq = q;
      return;
    }
    const n = this.sock!.write(data);
    if (n < data.length) this.outq = data.subarray(Math.max(n, 0));
  }

  private flush() {
    if (!this.outq || !this.sock) return;
    const n = this.sock.write(this.outq);
    this.outq = n < this.outq.length ? this.outq.subarray(Math.max(n, 0)) : null;
  }

  private async loop() {
    while (!this.stopped) {
      this.outq = null;
      await new Promise<void>((resolve) => {
        let buf = "";
        const dec = new TextDecoder();
        Bun.connect({
          unix: this.path,
          socket: {
            open: (s) => {
              this.sock = s;
              this.connected = true;
              this.emit();
            },
            data: (_s, chunk) => {
              buf += dec.decode(chunk, { stream: true });
              let i: number;
              while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (line) this.handle(line);
              }
            },
            drain: () => this.flush(),
            close: () => resolve(),
            end: (s) => {
              s.end();
              resolve();
            },
            error: () => resolve(),
          },
        }).catch(() => resolve());
      });
      const was = this.connected;
      this.sock = null;
      this.connected = false;
      for (const [, w] of this.waiting) {
        clearTimeout(w.timer);
        w.reject(new Error("plasmod-bridge との接続が切れた"));
      }
      this.waiting.clear();
      // つながっていない間に解決したかもしれないので、保留中の依頼は捨てる（再接続時に bridge が送り直す）
      this.pending.clear();
      if (was) this.emit();
      await Bun.sleep(3000);
    }
  }

  handle(line: string) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.type === "result") {
      const w = this.waiting.get(Number(m.id));
      if (!w) return;
      this.waiting.delete(Number(m.id));
      clearTimeout(w.timer);
      if (m.ok) w.resolve(m);
      else w.reject(new Error(String(m.error ?? "plasmod-bridge がエラーを返した")));
      return;
    }
    if (m.type === "chat") {
      for (const fn of this.chatListeners) fn(String(m.thread), (m.message ?? {}) as Record<string, unknown>);
      return;
    }
    const key = `${m.thread}:${m.request_id}`;
    if (m.type === "permission_request") {
      this.pending.set(key, {
        thread: String(m.thread),
        request_id: String(m.request_id),
        tool_name: String(m.tool_name ?? ""),
        description: String(m.description ?? ""),
        input_preview: String(m.input_preview ?? ""),
        thread_title: m.thread_title ? String(m.thread_title) : null,
        created_at: typeof m.created_at === "number" ? m.created_at * 1000 : Date.now(),
      });
      this.emit();
    } else if (m.type === "permission_resolved") {
      if (this.pending.delete(key)) this.emit();
    }
  }

  /** セッションの操作。bridge の result を待って返す */
  request(obj: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    if (!this.sock) return Promise.reject(new Error("plasmod-bridge につながっていない"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("plasmod-bridge から返事がない"));
        // 応答が無いのは接続が壊れている可能性が高い。切って張り直す
        this.sock?.end();
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.send(JSON.stringify({ ...obj, id }) + "\n");
    });
  }

  verdict(thread: string, requestId: string, behavior: "allow" | "deny") {
    if (!this.sock) throw new Error("plasmod-bridge につながっていない");
    this.send(JSON.stringify({ type: "verdict", thread, request_id: requestId, behavior }) + "\n");
    this.pending.delete(`${thread}:${requestId}`);
    this.emit();
  }
}
