import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { BridgeClient } from "../src/server/bridge";

type Srv = ReturnType<typeof Bun.listen>;

function listen(path: string, onLine: (line: string, s: { write(d: string): number; end(): void }) => void, onOpen?: (s: { end(): void }) => void): Srv {
  rmSync(path, { force: true });
  return Bun.listen({
    unix: path,
    socket: {
      open: (s) => {
        (s as any).buf = "";
        (s as any).dec = new TextDecoder();
        onOpen?.(s);
      },
      data: (s, chunk) => {
        const st = s as any;
        st.buf += st.dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = st.buf.indexOf("\n")) >= 0) {
          const line = st.buf.slice(0, i);
          st.buf = st.buf.slice(i + 1);
          onLine(line, s);
        }
      },
    },
  });
}

const until = async (f: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await Bun.sleep(20);
  }
};

describe("BridgeClient", () => {
  test("数 MB の1行が欠けずに bridge に届く", async () => {
    const path = `/tmp/bridge-test-${process.pid}-a.sock`;
    const big = "あ".repeat(2_000_000);
    let got = 0;
    const srv = listen(path, (line, s) => {
      const m = JSON.parse(line);
      got = m.data.length;
      s.write(JSON.stringify({ type: "result", id: m.id, ok: true }) + "\n");
    });
    const c = new BridgeClient(path);
    c.start();
    await until(() => c.connected);
    const r = await c.request({ type: "send", data: big }, 10_000);
    expect(r.ok).toBe(true);
    expect(got).toBe(big.length);
    c.stop();
    srv.stop(true);
  });

  test("bridge が切れても再接続する", async () => {
    const path = `/tmp/bridge-test-${process.pid}-b.sock`;
    let srv = listen(path, () => {}, (s) => setTimeout(() => s.end(), 50));
    const c = new BridgeClient(path);
    c.start();
    await until(() => c.connected);
    await until(() => !c.connected);
    srv.stop(true);
    srv = listen(path, () => {});
    await until(() => c.connected, 8000);
    c.stop();
    srv.stop(true);
  });
});
