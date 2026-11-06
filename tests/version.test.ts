import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { Store } from "../src/server/store";

describe("古い版のまま開かない", () => {
  test("版は index.html の中身で変わる。index.html は毎回確かめ、/assets/ はずっとキャッシュ", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-web-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<script src=/assets/a1.js></script>");
    writeFileSync(join(dir, "assets", "a1.js"), "1");
    const store = new Store(":memory:");
    const hub = new Hub({ ...config, devNoAuth: true }, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, null, null);
    const app = createApp({ ...config, devNoAuth: true }, hub, store, relative(process.cwd(), dir));
    const v1 = (await (await app.request("/api/version")).json()).id;
    expect((await app.request("/")).headers.get("cache-control")).toBe("no-cache");
    expect((await app.request("/assets/a1.js")).headers.get("cache-control")).toContain("immutable");
    expect((await app.request("/api/version")).headers.get("cache-control")).toBe("no-store");
    await Bun.sleep(20);
    writeFileSync(join(dir, "index.html"), "<script src=/assets/a2.js></script>");
    const v2 = (await (await app.request("/api/version")).json()).id;
    expect(v2).not.toBe(v1);
  });
});
