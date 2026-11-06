import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { safeName, SHARE_LIMITS, ShareStore } from "../src/server/share";
import { Store } from "../src/server/store";

const FIXTURE = join(import.meta.dir, "../fixtures/board.json");

async function setup() {
  const store = new Store(":memory:");
  const source = new FixtureSource(FIXTURE);
  const hub = new Hub(config, source, store, null, null);
  await hub.refresh();
  const shares = new ShareStore(mkdtempSync(join(tmpdir(), "gh-share-")));
  const sent: { agent: string; id: string | null; text: string; files: string[] }[] = [];
  const sessions = {
    agents: () => [],
    send: async (agent: string, id: string | null, text: string, files: { name: string }[] = []) => {
      sent.push({ agent, id, text, files: files.map((f) => f.name) });
      return id ?? "777";
    },
  };
  const app = createApp({ ...config, devNoAuth: true }, hub, store, ".", { sessions: sessions as never, shares });
  return { app, hub, source, shares, sent };
}

const form = (fields: Record<string, string>, files: [string, string, string][] = []) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [name, type, body] of files) fd.append("files", new File([body], name, { type }));
  return fd;
};

describe("共有メニューとチャットの添付", () => {
  test("ファイル名を安全にする", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName(".env")).toBe("env");
    expect(safeName("C:\\Users\\a\\予約.pdf")).toBe("予約.pdf");
    expect(safeName("", "file-1")).toBe("file-1");
  });

  test("上限を超えるものは置かない", () => {
    const s = new ShareStore(mkdtempSync(join(tmpdir(), "gh-share-")));
    const big = { name: "x", type: "", data: new Uint8Array(SHARE_LIMITS.fileBytes + 1) };
    expect(() => s.save({}, [big])).toThrow("25MB");
    expect(() => s.save({}, Array.from({ length: 11 }, () => ({ name: "a", type: "", data: new Uint8Array(1) })))).toThrow("10 個");
    expect(s.get("../../etc")).toBeNull();
    expect(() => s.remove("../../etc")).toThrow("不正な ID");
  });

  test("共有メニュー → 受け取り → 取り込み後に消える（宛先は選ばない）", async () => {
    const { app, shares } = await setup();
    const r = await app.request("/share", { method: "POST", body: form({ title: "予約", text: "トルファン北駅", url: "" }, [["切符.png", "image/png", "PNG"], ["メモ.html", "text/html", "<script>x</script>"]]) });
    expect(r.status).toBe(303);
    const id = r.headers.get("Location")!.match(/#\/share\/([0-9a-f]{24})$/)![1];
    const info = (await (await app.request(`/api/shares/${id}`)).json()) as { files: { name: string }[] };
    expect(info.files.map((f) => f.name)).toEqual(["切符.png", "メモ.html"]);
    // 画像はプレビュー、それ以外はダウンロード扱い（ブラウザに HTML として解釈させない）
    const img = await app.request(`/api/shares/${id}/files/0`);
    expect(img.headers.get("Content-Type")).toBe("image/png");
    const html = await app.request(`/api/shares/${id}/files/1`);
    expect(html.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(html.headers.get("Content-Disposition")).toStartWith("attachment");
    expect((await app.request(`/api/shares/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(shares.get(id)).toBeNull();
    expect((await app.request(`/api/shares/${id}`)).status).toBe(404);
    expect((await app.request("/api/shares/..%2Fetc", { method: "DELETE" })).status).toBe(400);
    // 旧「投げ込み」の送信口は無い
    expect((await app.request(`/api/shares/${id}/send`, { method: "POST", body: "{}" })).status).not.toBe(200);
  });

  test("チャットの送信: JSON（文字だけ）も multipart（添付つき）も、同じ口で受ける", async () => {
    const { app, sent } = await setup();
    const j = await app.request("/api/sessions/dev/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "42", text: "こんにちは" }) });
    expect(((await j.json()) as { id: string }).id).toBe("42");
    const m = await app.request("/api/sessions/default/send", { method: "POST", body: form({ text: "これ見て", id: "s9" }, [["a.png", "image/png", "x"], ["b.pdf", "application/pdf", "%PDF"]]) });
    expect(((await m.json()) as { id: string }).id).toBe("s9");
    const n = await app.request("/api/sessions/acct/send", { method: "POST", body: form({ text: "" }, [["c.pdf", "application/pdf", "%PDF"]]) });
    expect(((await n.json()) as { id: string }).id).toBe("777");
    expect(sent).toEqual([
      { agent: "dev", id: "42", text: "こんにちは", files: [] },
      { agent: "default", id: "s9", text: "これ見て", files: ["a.png", "b.pdf"] },
      { agent: "acct", id: null, text: "", files: ["c.pdf"] },
    ]);
  });

  test("添付が多すぎる・大きすぎるときは送らずに断る", async () => {
    const { app, sent } = await setup();
    const many = Array.from({ length: 11 }, (_, i) => [`f${i}.txt`, "text/plain", "x"] as [string, string, string]);
    const r = await app.request("/api/sessions/dev/send", { method: "POST", body: form({ text: "x" }, many) });
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: string }).error).toContain("10 個");
    expect(sent).toEqual([]);
  });

  test("レビュー待ちの差し戻しは request-changes になる", async () => {
    const { hub, source } = await setup();
    await hub.act("task:t_91c0", "changes", "金額をもう一度確認して", "app");
    expect(source.log).toEqual(["request-changes t_91c0 オーナーさん（Plasmod）: 金額をもう一度確認して"]);
  });

  test("放っておかれたものは片付ける", () => {
    const s = new ShareStore(mkdtempSync(join(tmpdir(), "gh-share-")));
    const id = s.save({ text: "x" }, []);
    s.sweep(Date.now() + SHARE_LIMITS.ttlMs + 1000);
    expect(s.get(id)).toBeNull();
  });
});
