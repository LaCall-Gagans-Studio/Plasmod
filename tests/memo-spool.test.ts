import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentUids, MemoSpool } from "../src/server/memo-spool";
import { MemoStore } from "../src/server/memos";
import { SearchIndex } from "../src/server/search";
import { Store } from "../src/server/store";

const CLI = join(import.meta.dir, "../deploy/memo-spool/plasmod-memo");
const uid = process.getuid!();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(agents = new Map([[uid, "dev"]])) {
  const dir = mkdtempSync(join(tmpdir(), "memo-spool-"));
  dirs.push(dir);
  const store = new Store(":memory:");
  const memos = new MemoStore(store.db);
  const spool = new MemoSpool(memos, dir, agents);
  spool.start(20);
  return { dir, memos, spool, store };
}

const send = (dir: string, id: string, req: unknown) => writeFileSync(join(dir, "in", `${id}.json`), JSON.stringify(req));
const reply = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, "out", `${id}.json`), "utf8"));

describe("メモの受け渡し", () => {
  test("/etc/passwd から uid を引く。root と知らないユーザーは除く", () => {
    const pw = "root:x:0:0::/root:/bin/bash\ncc:x:1001:1001::/home/cc:/bin/bash\nhermes:x:1002:1002::/home/hermes:/bin/bash";
    expect([...agentUids("cc=dev,hermes=hermes,root=root,nobody=x,cc=BAD NAME", pw)]).toEqual([[1001, "dev"], [1002, "hermes"]]);
  });

  test("依頼の持ち主で記録の名前が決まる。as で名乗れる", () => {
    const { dir, memos, spool } = setup();
    send(dir, "aaaaaaaa", { op: "create", args: { title: "宿", body: "本文", project: "旅", tags: ["予約"] } });
    spool.tick();
    const r = reply(dir, "aaaaaaaa");
    expect(r.ok).toBe(true);
    expect(memos.get(r.result.id)).toMatchObject({ author: "dev", project: "旅", tags: ["予約"] });
    send(dir, "bbbbbbbb", { op: "append", args: { id: r.result.id, text: "追記" }, as: "default" });
    spool.tick();
    expect(reply(dir, "bbbbbbbb").result.body).toBe("本文\n\n追記");
    expect(memos.history(r.result.id).map((e) => e.author)).toEqual(["dev/default", "dev"]);
    expect(readdirSync(join(dir, "in"))).toEqual([]);
    spool.stop();
  });

  test("知らないユーザー・シンボリックリンク・形の違う名前は返事をせずに捨てる", () => {
    const { dir, spool } = setup(new Map([[uid + 12345, "other"]]));
    send(dir, "cccccccc", { op: "list" });
    spool.tick();
    expect(readdirSync(join(dir, "in"))).toEqual([]);
    expect(readdirSync(join(dir, "out"))).toEqual([]);
    spool.stop();
    const s2 = setup();
    writeFileSync(join(s2.dir, "target"), "{}");
    symlinkSync(join(s2.dir, "target"), join(s2.dir, "in", "dddddddd.json"));
    send(s2.dir, "NOT_HEX!", { op: "list" });
    s2.spool.tick();
    expect(readdirSync(join(s2.dir, "in"))).toEqual([]);
    expect(readdirSync(join(s2.dir, "out"))).toEqual([]);
    s2.spool.stop();
  });

  test("アーカイブはできない・知らない操作はエラーを返す", () => {
    const { dir, spool } = setup();
    send(dir, "eeeeeeee", { op: "archive", args: { id: 1 } });
    spool.tick();
    expect(reply(dir, "eeeeeeee")).toMatchObject({ ok: false, status: 400 });
    spool.stop();
  });

  test("CLI で 作る・探す・追記・見る", async () => {
    const { dir, spool } = setup();
    const run = async (args: string[], stdin?: string) => {
      const p = Bun.spawn(["python3", "-I", CLI, ...args], { env: { ...process.env, PLASMOD_MEMO_SPOOL: dir, PLASMOD_MEMO_TIMEOUT: "5" }, stdin: stdin ? new TextEncoder().encode(stdin) : "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, code };
    };
    const made = await run(["--json", "new", "--title", "AI のメモ", "-p", "Hermes", "-t", "開発", "-t", "#AI"], "最初の本文");
    expect(made.code).toBe(0);
    const id = JSON.parse(made.out).id as number;
    expect((await run(["append", String(id), "足した行"])).code).toBe(0);
    const shown = await run(["show", String(id)]);
    expect(shown.out).toContain("# AI のメモ");
    expect(shown.out).toContain("[Hermes] #開発 #AI");
    expect(shown.out).toContain("最初の本文\n\n足した行");
    expect((await run(["list", "-q", "足した"])).out).toContain("AI のメモ");
    expect((await run(["list", "-t", "無いタグ"])).out).toContain("当てはまるメモは無い");
    const bad = await run(["show", "999"]);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("このメモは無い");
    spool.stop();
  });

  test("メモはアプリ全体の検索にも出て、アーカイブで消える", () => {
    const store = new Store(":memory:");
    const memos = new MemoStore(store.db);
    const search = new SearchIndex(store.db);
    const m = memos.create({ title: "京都の宿", body: "清水寺", project: "夏の旅行", tags: ["旅"] }, "app");
    expect(search.search("清水寺").map((h) => [h.kind, h.ref])).toEqual([["memo", String(m.id)]]);
    expect(search.search("夏の旅行").length).toBe(1);
    memos.setArchived(m.id, true, "app");
    expect(search.search("清水寺")).toEqual([]);
  });
});
