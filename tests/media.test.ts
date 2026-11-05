import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { BridgeClient } from "../src/server/bridge";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { mediaKind, mediaResponse, MediaService } from "../src/server/media";
import { extractMedia, HermesApi, SessionService } from "../src/server/sessions";
import { Store } from "../src/server/store";

const FIXTURE = join(import.meta.dir, "../fixtures/board.json");

class FakeBridge extends BridgeClient {
  reqs: Record<string, unknown>[] = [];
  constructor(private reply: (o: Record<string, unknown>) => Record<string, unknown>) {
    super("/nonexistent");
    this.connected = true;
  }
  override request(obj: Record<string, unknown>) {
    this.reqs.push(obj);
    try {
      return Promise.resolve(this.reply(obj));
    } catch (e) {
      return Promise.reject(e);
    }
  }
}

describe("Hermes の返事から写真・ファイルを取り出す", () => {
  test("MEDIA: の行・文中・自分が添付したときの [添付ファイル]", () => {
    expect(extractMedia("グラフを作りました\nMEDIA:/home/hermes/.hermes/cache/chart.png\n以上")).toEqual({
      text: "グラフを作りました\n\n以上",
      paths: ["/home/hermes/.hermes/cache/chart.png"],
    });
    expect(extractMedia("見て MEDIA:/tmp/a.png と MEDIA:/tmp/a.png").paths).toEqual(["/tmp/a.png"]);
    expect(extractMedia("MEDIA: `/home/hermes/.hermes/out/月次 報告.pdf`").paths).toEqual(["/home/hermes/.hermes/out/月次 報告.pdf"]);
    expect(extractMedia("これ読んで\n\n[添付ファイル]\n/home/hermes/.hermes/plasmod-inbox/1-a.pdf\n/home/hermes/.hermes/plasmod-inbox/2-b.png")).toEqual({
      text: "これ読んで",
      paths: ["/home/hermes/.hermes/plasmod-inbox/1-a.pdf", "/home/hermes/.hermes/plasmod-inbox/2-b.png"],
    });
    expect(extractMedia("相対パス MEDIA:foo.png は拾わない").paths).toEqual([]);
  });

  test("履歴の API の添付の欄（attachments の path）も拾う。メディアだけの返事も残る", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ messages: [
        { role: "assistant", content: "MEDIA:/home/hermes/.hermes/cache/x.png" },
        { role: "assistant", content: "添付つき", attachments: [{ path: "/home/hermes/.hermes/out/r.pdf", name: "r.pdf" }, "relative.txt"] },
      ] }),
    });
    try {
      const api = new HermesApi("default", { url: `http://127.0.0.1:${server.port}`, key: "k" });
      const m = await api.messages("s1");
      expect(m[0]).toMatchObject({ text: "", media: [{ name: "x.png", kind: "image", url: "/api/media/hermes?path=%2Fhome%2Fhermes%2F.hermes%2Fcache%2Fx.png" }] });
      expect(m[1].media?.map((x) => [x.name, x.kind])).toEqual([["r.pdf", "pdf"]]);
    } finally {
      server.stop(true);
    }
  });
});

describe("開発くんの会話のファイル", () => {
  test("bridge の記録の media が、取り出しの URL つきでチャットに載る（パスは載らない）", async () => {
    const bridge = new FakeBridge((o) =>
      o.type === "history"
        ? { messages: [{ id: "m1", author: "dev", content: "図です", attachments: ["chart.png"], media: [{ name: "chart.png", size: 10 }], at: 1_792_000_000 }] }
        : { text: "", alive: true, working: false },
    );
    const view = await new SessionService(bridge, new Map()).view("dev", "42");
    expect(view.kind === "terminal" && view.messages?.[0].media).toEqual([{ name: "chart.png", size: 10, kind: "image", url: "/api/media/dev/42/m1/0" }]);
  });
});

describe("取り出しの窓口", () => {
  test("種類と返し方: 画像と本物の PDF だけ画面で開く。SVG・HTML・偽の PDF はダウンロード", async () => {
    expect(mediaKind("a.PNG")).toBe("image");
    expect(mediaKind("a.svg")).toBe("file");
    const png = mediaResponse("a.png", new Uint8Array([1]));
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(png.headers.get("Content-Disposition")).toStartWith("inline");
    expect(png.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const pdf = mediaResponse("a.pdf", new TextEncoder().encode("%PDF-1.7"));
    expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
    expect(mediaResponse("a.pdf", new TextEncoder().encode("<html>")).headers.get("Content-Type")).toBe("application/octet-stream");
    for (const n of ["a.svg", "a.html", "a.js"]) {
      const r = mediaResponse(n, new Uint8Array([1]));
      expect(r.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(r.headers.get("Content-Disposition")).toStartWith("attachment");
      expect(r.headers.get("Content-Security-Policy")).toContain("sandbox");
    }
    expect(mediaResponse("a.png", new Uint8Array([1]), true).headers.get("Content-Disposition")).toStartWith("attachment");
  });

  async function appWith(media: MediaService) {
    const store = new Store(":memory:");
    const hub = new Hub(config, new FixtureSource(FIXTURE), store, null, null);
    await hub.refresh();
    return createApp({ ...config, devNoAuth: true }, hub, store, mkdtempSync(join(tmpdir(), "gh-web-")), { media });
  }

  test("開発くん: bridge の file 操作の結果を返す。不正な指定は bridge に聞く前に断る。bridge の拒否は 403", async () => {
    const bridge = new FakeBridge((o) => {
      if (o.msg === "deny") throw new Error("見せない場所: site/.env");
      return { name: "chart.png", size: 3, data: Buffer.from([137, 80, 78]).toString("base64") };
    });
    const app = await appWith(new MediaService({ bridge, hermesRead: null }));
    const ok = await app.request("/api/media/dev/42/m1/0");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("image/png");
    expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([137, 80, 78]);
    expect(bridge.reqs).toEqual([{ type: "file", thread: "42", msg: "m1", i: 0 }]);
    expect((await app.request("/api/media/dev/abc/m1/0")).status).toBe(403);
    expect((await app.request("/api/media/dev/42/m1/-1")).status).toBe(403);
    expect((await app.request("/api/media/dev/42/..%2Fx/0")).status).toBe(403);
    expect(bridge.reqs.length).toBe(1);
    expect((await app.request("/api/media/dev/42/deny/0")).status).toBe(403);
  });

  test("Hermes: 仲介の media-read の結果を返す。相対パスや NUL は断る。仲介が無ければ 403 以外のエラー", async () => {
    const seen: string[] = [];
    const app = await appWith(new MediaService({ bridge: null, hermesRead: async (p) => (seen.push(p), new TextEncoder().encode("%PDF-1")) }));
    const r = await app.request(`/api/media/hermes?path=${encodeURIComponent("/home/hermes/.hermes/out/月次.pdf")}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("application/pdf");
    expect(seen).toEqual(["/home/hermes/.hermes/out/月次.pdf"]);
    expect((await app.request("/api/media/hermes?path=relative.png")).status).toBe(403);
    expect((await app.request("/api/media/hermes")).status).toBe(403);
    expect(seen.length).toBe(1);
    const none = await appWith(new MediaService({ bridge: null, hermesRead: null }));
    expect((await none.request("/api/media/hermes?path=/x/a.png")).status).toBe(500);
  });
});
