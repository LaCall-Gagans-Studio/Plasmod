// root 作業の承認（plasmod-rootd）への中継。
// ここ（plasmod）はパスワードを保存もログもしない。ブラウザから来たものをそのまま plasmod-rootd の
// app.sock に渡すだけで、照合は root の plasmod-rootd がする。リクエストの本文は一切ログに出さない。
import { connect } from "node:net";

export interface RootReply {
  ok: boolean;
  error?: string;
  code?: string;
  [k: string]: unknown;
}

export class RootClient {
  constructor(
    private sock: string,
    private timeoutMs = 20_000,
  ) {}

  call(req: Record<string, unknown>): Promise<RootReply> {
    return new Promise((resolve, reject) => {
      const s = connect({ path: this.sock });
      let buf = "";
      let done = false;
      const finish = (f: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        s.destroy();
        f();
      };
      const timer = setTimeout(() => finish(() => reject(new Error("plasmod-rootd の返事がない"))), this.timeoutMs);
      s.setEncoding("utf8");
      s.on("connect", () => s.write(JSON.stringify(req) + "\n"));
      s.on("data", (d: string) => {
        buf += d;
        const i = buf.indexOf("\n");
        if (i < 0) return;
        try {
          const r = JSON.parse(buf.slice(0, i)) as RootReply;
          finish(() => resolve(r));
        } catch {
          finish(() => reject(new Error("plasmod-rootd の返事が読めない")));
        }
      });
      // 接続の失敗メッセージにはソケットのパスしか入らない（リクエストの中身は入らない）
      s.on("error", (e) => finish(() => reject(new Error(`plasmod-rootd に繋げない: ${(e as NodeJS.ErrnoException).code ?? "error"}`))));
      s.on("close", () => finish(() => reject(new Error("plasmod-rootd が途中で切った"))));
    });
  }
}

const ID_RE = /^[0-9]{14}-[0-9a-f]{6}$/;
export const validRootId = (id: string) => ID_RE.test(id);
