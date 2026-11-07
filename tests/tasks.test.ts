import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { MemoSpool } from "../src/server/memo-spool";
import { MemoStore } from "../src/server/memos";
import { Store } from "../src/server/store";
import { TaskStore } from "../src/server/tasks";

const FIXTURE = join(import.meta.dir, "../fixtures/board.json");
const fresh = () => new TaskStore(new Store(":memory:").db);
const mail = (over: Record<string, unknown> = {}) => ({ source: "mail", key: "thread-1", title: "田中商事 請求書", body: "返信の要否", kind: "reply", ...over });

describe("タスクの登録（同じ元は1件）", () => {
  test("初回は BackLog、同じ元は1件のまま、中身が変われば更新", () => {
    const s = fresh();
    const a = s.upsert(mail(), "hermes/default", 1000);
    expect(a).toMatchObject({ action: "created", task: { status: "inbox", kind: "reply", sourceKey: "thread-1", createdBy: "hermes/default" } });
    expect(s.upsert(mail(), "hermes/default", 2000).action).toBe("unchanged");
    expect(s.upsert(mail({ body: "期限が明日" }), "hermes/default", 3000)).toMatchObject({ action: "updated", task: { body: "期限が明日", status: "inbox" } });
    expect(s.list().length).toBe(1);
  });

  test("完了（不要）は、同じ元に新しい動きが無ければ起こさない。新しい動きがあれば BackLog に戻す（2026-10-29 から）", () => {
    const s = fresh();
    const { task } = s.upsert(mail(), "hermes/default", 1000);
    s.decide(task.id, "done", "", "app", 2000, "", "unneeded");
    expect(s.upsert(mail(), "hermes/default", 3000)).toMatchObject({ action: "ignored", task: { status: "done", doneReason: "unneeded" } });
    expect(s.inbox()).toEqual([]);
    expect(s.upsert(mail({ eventAt: 5000 }), "hermes/default", 6000)).toMatchObject({ action: "reopened", task: { status: "inbox" } });
  });

  test("ops はキーが回ごとに揺れても同じ件にまとめる（本番で不要にしたものが再浮上していた）", () => {
    const s = fresh();
    const ops = (key: string, over: Record<string, unknown> = {}) => ({ source: "ops", key, title: "ICANN 連絡先確認", kind: "confirm", ...over });
    const a = s.upsert(ops("domain:example-voters.com:icann-verification"), "hermes/ops", 1000).task;
    const b = s.upsert(ops("supabase:oauth-app-approval", { title: "Supabase の OAuth アプリ許可" }), "hermes/ops", 1000).task;
    const c = s.upsert(ops("aws:bedrock-claude-sonnet-46-subscription", { title: "Bedrock の Marketplace 購読" }), "hermes/ops", 1000).task;
    for (const t of [a, b, c]) s.decide(t.id, "done", "", "app", 2000);
    // 次の回: 言い方が変わっただけ・新しい動きなし → 出さない
    for (const k of ["domain:example-voters.com:icann-verify", "domain:example-voters.com", "supabase:oauth-approval", "aws:bedrock-subscription"])
      expect(s.upsert(ops(k, { title: "言い方違い" }), "hermes/default", 3000)).toMatchObject({ action: "ignored" });
    expect(s.inbox()).toEqual([]);
    // 新しい動きがあれば戻る
    expect(s.upsert(ops("domain:example-voters.com", { eventAt: 4000 }), "hermes/default", 4000)).toMatchObject({ action: "reopened", task: { id: a.id } });
    // 別の件はまとめない
    for (const k of ["domain:example-infos.org", "supabase:app1:rls-grants", "vps:disk-usage", "aws:bedrock"])
      expect(s.upsert(ops(k, { title: k }), "hermes/default", 5000).action).toBe("created");
    // メール・Beeper のキーは揺れの扱いをしない（題名が違えば別の件）
    s.upsert(mail({ key: "a:x-y-z" }), "hermes/default", 6000);
    expect(s.upsert(mail({ key: "a:x-y", title: "山田工業 見積の確認" }), "hermes/default", 6000).action).toBe("created");
  });

  test("キーが違っても題名がほぼ同じなら同じ件（本番の LIFF SDK・ドメイン・田中さん）", () => {
    const s = fresh();
    const up = (source: string, key: string, title: string, at: number, eventAt?: number) => s.upsert({ source, key, title, kind: "confirm", eventAt }, "hermes/default", at);
    const sdk = up("mail", "1921", "LINE LIFF SDK v2.31.1 更新（11/24 の外部ブラウザ制限前）", 1000).task;
    // 催促メール（別のメッセージ番号）と ops の言い換えは、どちらも同じ件
    expect(up("mail", "1924", "acme: LIFF SDK を v2.31.1 以降へ更新（11/24 に旧版の利用制限）", 2000)).toMatchObject({ action: "updated", task: { id: sdk.id } });
    expect(up("ops", "line:liff-sdk-update", "LINE：LIFF SDK を v2.31.1 以降へ更新（11/24 に旧版の利用制限）", 3000).task.id).toBe(sdk.id);
    expect(s.events(sdk.id).filter((e) => e.text.startsWith("同じ件が別の元")).length).toBe(2);
    const dom = up("ops", "domain:example-infos.org", "example-infos.org の有効期限が 11/01（自動更新オフ）", 1000).task;
    expect(up("mail", "acme:1920", "example-infos.org のドメイン期限（11/01・自動更新OFF）", 2000).task.id).toBe(dom.id);
    const bp = up("beeper", "!a:beeper.local:6546", "田中さん ログイン通知の確認・YouTube公開URLの反映報告", 1000).task;
    expect(up("beeper", "79:6562", "田中さん：YouTube外部公開URLの反映報告（①②の回答）", 2000).task.id).toBe(bp.id);
    // 本番で別件だった組はまとめない
    for (const [a, b] of [
      ["#全体連絡 本番の滞在期間の回答（回答必須）", "サークルA：本番の滞在期間アンケートの回答・役者継続の意向"],
      ["Google Chat 4-1_開発全体: 佐藤さんの返答（demo app 録音）", "鈴木さん demo app 提案書への経営層向けFBへの返信"],
      ["段3: MCP の OAuth ログインをアプリから中継", "段4: 秘密をアプリから直接入れる口"],
    ]) {
      const x = up("beeper", `x:${a}`, a, 5000).task;
      expect(up("beeper", `y:${b}`, b, 5000).task.id).not.toBe(x.id);
    }
    // 30 日より前のものとは比べない
    expect(up("mail", "9999", "LINE LIFF SDK v2.31.1 更新（11/24 の外部ブラウザ制限前）", 1000 + 31 * 86_400_000).action).toBe("created");
  });

  test("不要の移行: 古い dismissed と、記録に「不要」がある done を Done・理由 不要に。普通の done はそのまま", () => {
    const store = new Store(":memory:");
    const s = new TaskStore(store.db);
    const mk = (key: string) => s.upsert({ source: "mail", key, title: key, eventAt: 900 }, "hermes/default", 1000).task;
    const [old, card, reply, plain] = [mk("old"), mk("card"), mk("reply"), mk("plain")];
    s.decide(card.id, "done", "", "app", 2000, "不要");
    s.decide(reply.id, "done", "", "app", 2000, "返信不要: 営業");
    s.decide(plain.id, "done", "", "app", 2000, "確認した");
    store.db.query("UPDATE tasks SET status = 'dismissed' WHERE id = ?").run(old.id);
    store.db.exec("DROP TRIGGER tasks_done_reason");
    store.db.exec("ALTER TABLE tasks DROP COLUMN done_reason");
    const after = new TaskStore(store.db);
    for (const t of [old, card, reply]) expect(after.get(t.id)).toMatchObject({ status: "done", doneReason: "unneeded" });
    expect(after.get(plain.id)).toMatchObject({ status: "done", doneReason: null });
    expect(after.list({ status: ["dismissed"] }).map((t) => t.id).sort()).toEqual([old.id, card.id, reply.id].sort());
  });

  test("理由は Done の間だけ: 戻すと消え、Done のまま付け外しできる。古い dismissed の指定も受ける", () => {
    const s = fresh();
    const t = s.create({ title: "x" }, "app");
    expect(s.setStatusBy(t.id, "dismissed", "", "tsumugi", 2000)).toMatchObject({ status: "done", doneReason: "unneeded" });
    expect(s.update(t.id, { status: "done", doneReason: null }, "app", 3000).doneReason).toBeNull();
    expect(s.update(t.id, { doneReason: "unneeded" }, "app", 4000).doneReason).toBe("unneeded");
    expect(s.update(t.id, { title: "y" }, "app", 5000).doneReason).toBe("unneeded");
    expect(s.update(t.id, { status: "todo" }, "app", 6000)).toMatchObject({ status: "todo", doneReason: null });
    s.decide(t.id, "done", "", "app", 7000, "", "unneeded");
    s.decide(t.id, "inbox", "", "app", 8000);
    expect(s.get(t.id)?.doneReason).toBeNull();
  });

  test("不要で閉じた件も、同じキーに新しい動きがあれば理由を消して BackLog に戻る", () => {
    const s = fresh();
    const t = s.upsert(mail({ eventAt: 900 }), "hermes/default", 1000).task;
    s.decide(t.id, "done", "", "app", 2000, "", "unneeded");
    expect(s.upsert(mail({ eventAt: 3000 }), "hermes/default", 3000)).toMatchObject({ action: "reopened", task: { status: "inbox", doneReason: null } });
  });

  test("カンバンをタスクに写す: 進行中は AI-Driven で1件、完了で Done、消えたら猶予のあと Done。オーナー宛て・止まった・消したものは写さない", () => {
    const s = fresh();
    const card = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, title: `作業 ${id}`, body: "本文", status, assignee: "dev", created_by: "default", ...over });
    const board = [card("a", "running"), card("b", "blocked"), card("c", "done"), card("d", "ready", { assignee: "owner" }), card("e", "archived")];
    expect(s.syncKanban(board, 1000, ["owner"])).toBe(1);
    const a = s.byKanban("a")!;
    expect(a).toMatchObject({ status: "doing", source: "kanban", sourceKey: "a", kanbanId: "a", agent: "dev" });
    for (const id of ["b", "c", "d", "e"]) expect(s.byKanban(id)).toBeNull();
    expect(s.syncKanban(board, 2000, ["owner"])).toBe(0);
    expect(s.syncKanban([card("a", "done", { result: "できた" })], 3000)).toBe(1);
    expect(s.get(a.id)?.status).toBe("done");

    s.syncKanban([card("f", "running")], 10_000);
    const f = s.byKanban("f")!;
    expect(s.syncKanban([], 10_000 + 60_000)).toBe(0); // 猶予の内は閉じない
    expect(s.syncKanban([], 10_000 + 11 * 60_000)).toBe(1);
    expect(s.get(f.id)?.status).toBe("done");

    s.syncKanban([card("g", "running")], 20_000);
    s.remove(s.byKanban("g")!.id, "app", 21_000);
    expect(s.syncKanban([card("g", "running")], 22_000)).toBe(0); // 消したものは写し直さない
    expect(s.byKanban("g")).toBeNull();
  });

  test("Done の一覧は既定で承認の記録を外す。未完了の承認依頼は残り、件数も合う", () => {
    const store = new Store(":memory:");
    const s = new TaskStore(store.db);
    s.upsert({ source: "mail", key: "m", title: "メール" }, "hermes/default", 1000);
    const done = s.upsert({ source: "mail", key: "n", title: "済みメール" }, "hermes/default", 1000).task;
    s.decide(done.id, "done", "", "app", 2000);
    const mk = (key: string, status: string) => store.db.query("INSERT INTO tasks (title, body, kind, status, source, source_key, created_by, inbox_at, created_at, updated_at) VALUES (?, '', 'confirm', ?, 'perm', ?, 'dev', 1, 1, 1)").run(key, status, key);
    mk("p1", "done");
    mk("p2", "inbox");
    const hidden = s.view({ status: ["done"], hideDoneApprovals: true });
    expect(hidden.tasks.map((t) => t.title)).toEqual(["済みメール"]);
    expect(hidden.counts).toMatchObject({ inbox: 2, done: 1 });
    expect(s.view({ status: ["done"] }).tasks.length).toBe(2);
  });

  test("カードで「不要」にした件は、別のキーで来ても新しい動きがあっても開き直さない", () => {
    const s = fresh();
    const t = s.upsert({ source: "mail", key: "1921", title: "LINE LIFF SDK v2.31.1 更新（11/24 の外部ブラウザ制限前）", eventAt: 900 }, "hermes/default", 1000).task;
    s.decide(t.id, "done", "", "app", 2000, "不要", "unneeded");
    expect(s.upsert({ source: "mail", key: "1924", title: "acme: LIFF SDK を v2.31.1 以降へ更新（11/24 に旧版の利用制限）", eventAt: 3000 }, "hermes/default", 3000)).toMatchObject({ action: "ignored", task: { id: t.id, status: "done" } });
    expect(s.upsert({ source: "ops", key: "line:liff-sdk", title: "LINE：LIFF SDK を v2.31.1 以降へ更新", eventAt: 4000 }, "hermes/default", 4000).action).toBe("ignored");
    expect(s.inbox()).toEqual([]);
    // 「確認した」などで済みにしたものは、新しい動きがあれば戻る
    const u = s.upsert({ source: "beeper", key: "79:1", title: "田中さん ログイン通知の確認・YouTube公開URLの反映報告", eventAt: 900 }, "hermes/default", 1000).task;
    s.decide(u.id, "done", "", "app", 2000, "確認した");
    expect(s.upsert({ source: "beeper", key: "79:2", title: "田中さん：YouTube外部公開URLの反映報告（①②の回答）", eventAt: 3000 }, "hermes/default", 3000)).toMatchObject({ action: "reopened", task: { id: u.id } });
  });

  test("済みは、判断より後に元の動きがあったときだけ BackLog に戻す", () => {
    const s = fresh();
    const { task } = s.upsert(mail({ eventAt: 500 }), "hermes/default", 1000);
    s.decide(task.id, "done", "確認", "app", 2000);
    expect(s.upsert(mail({ eventAt: 1500 }), "hermes/default", 3000).action).toBe("ignored"); // 判断より前の動き
    expect(s.upsert(mail(), "hermes/default", 3000).action).toBe("ignored"); // 動きの時刻なし
    const r = s.upsert(mail({ eventAt: 2500, body: "先方から返信が来た" }), "hermes/default", 4000);
    expect(r).toMatchObject({ action: "reopened", task: { status: "inbox", body: "先方から返信が来た" } });
    expect(r.task.inboxAt).toBeGreaterThan(2000);
    expect(s.events(task.id).map((e) => e.kind)).toEqual(["reopen", "decide", "create"]);
  });

  test("完了は、新しい動き（返事が来た）で BackLog に戻る。自分でやる（todo）は戻さない", () => {
    const s = fresh();
    const a = s.upsert(mail(), "x", 1000).task;
    s.decide(a.id, "done", "", "app", 2000);
    expect(s.upsert(mail({ eventAt: 3000 }), "x", 3000).action).toBe("reopened");
    const b = s.upsert(mail({ key: "thread-2", title: "山田工業 見積" }), "x", 1000).task;
    s.decide(b.id, "todo", "", "app", 2000);
    expect(s.upsert(mail({ key: "thread-2", title: "山田工業 見積", eventAt: 3000 }), "x", 3000)).toMatchObject({ action: "updated", task: { status: "todo" } });
  });

  test("入力の確かめ: key・title が要る、due は日付、source は英小文字", () => {
    const s = fresh();
    expect(() => s.upsert(mail({ key: " " }), "x")).toThrow(/key/);
    expect(() => s.upsert(mail({ title: "" }), "x")).toThrow(/title/);
    expect(() => s.upsert(mail({ due: "明日" }), "x")).toThrow(/due/);
    expect(() => s.upsert(mail({ source: "メール" }), "x")).toThrow(/source/);
  });

  test("任せたタスクは、カンバンが終わったら済みになる", () => {
    const s = fresh();
    const { task } = s.upsert(mail(), "x", 1000);
    s.linkKanban(task.id, "t_abc", "acct", "", "app", 2000);
    expect(s.syncKanban([{ id: "t_abc", status: "running" }], 3000)).toBe(0);
    expect(s.syncKanban([{ id: "t_abc", status: "done", result: "下書きを作った" }], 4000)).toBe(1);
    expect(s.get(task.id)!.status).toBe("done");
    expect(s.events(task.id)[0].text).toContain("下書きを作った");
  });
});

describe("タスクからカード", () => {
  async function setup() {
    const store = new Store(":memory:");
    const tasks = new TaskStore(store.db);
    const source = new FixtureSource(FIXTURE);
    const hub = new Hub(config, source, store, null, null);
    hub.setTasks(tasks);
    await hub.refresh();
    return { hub, tasks, source };
  }

  test("BackLog のタスクがカードになり、「不要」（完了・不要）で消えて、同じ元は新しい動きがあったときだけ戻る", async () => {
    const { hub, tasks } = await setup();
    tasks.upsert(mail({ propose: ["kanban"], agent: "acct" }), "hermes/default");
    const card = hub.cards().find((c) => c.key.startsWith("apptask:"))!;
    expect(card).toMatchObject({ kind: "reply", source: "mail", delegate: "acct", agent: "default" });
    expect(card.ref).toBeUndefined(); // メールのスレッド ID は見せない
    expect(card.options.map((o) => o.id)).toEqual(["kanban", "draft", "dismiss", "mine", "later"]);
    await hub.act(card.key, "dismiss", "営業メール", "app");
    expect(hub.cards().some((c) => c.key === card.key)).toBe(false);
    expect(tasks.list({ status: ["dismissed"] }).length).toBe(1);
    tasks.upsert(mail(), "hermes/default"); // 同じ元・新しい動きなし → 出ない
    expect(hub.cards().some((c) => c.key.startsWith("apptask:"))).toBe(false);
    tasks.upsert(mail({ eventAt: Date.now() + 1000 }), "hermes/default"); // 先方から新しい返信 → また出る
    expect(hub.cards().some((c) => c.key.startsWith("apptask:"))).toBe(true);
  });

  test("「任せる」でカンバンのカードを作ってつなぎ、カンバンが終わればタスクも済み", async () => {
    const { hub, tasks, source } = await setup();
    const { task } = tasks.upsert({ source: "beeper", key: "chat-9:msg-3", title: "打ち合わせの日程", kind: "todo", agent: "default" }, "hermes/default");
    await hub.act(`apptask:${task.id}`, "handle", "来週で", "app");
    const t = tasks.get(task.id)!;
    expect(t.status).toBe("doing");
    expect(t.kanbanId).toMatch(/^t_fx/);
    await source.complete(t.kanbanId!, "日程を返した");
    await hub.refresh();
    expect(tasks.get(task.id)!.status).toBe("done");
  });

  test("「自分でやる」は todo に、「あとで」は伏せるだけ（タスクは BackLog のまま）", async () => {
    const { hub, tasks } = await setup();
    const a = tasks.upsert(mail({ key: "a" }), "x").task;
    const b = tasks.upsert(mail({ key: "b", title: "山田工業 見積" }), "x").task;
    await hub.act(`apptask:${a.id}`, "mine", "", "app");
    await hub.act(`apptask:${b.id}`, "later", "週明けに", "app");
    expect(tasks.get(a.id)!.status).toBe("todo");
    expect(tasks.get(b.id)!.status).toBe("inbox");
    expect(hub.cards("only").some((c) => c.key === `apptask:${b.id}`)).toBe(true);
    expect(tasks.events(b.id)[0]).toMatchObject({ kind: "comment", text: "週明けに" });
  });
});

describe("plasmod-task", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("登録・同じ元・探す・一覧（CLI）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-spool-"));
    dirs.push(dir);
    const store = new Store(":memory:");
    const tasks = new TaskStore(store.db);
    let changed = 0;
    const spool = new MemoSpool(new MemoStore(store.db), dir, new Map([[process.getuid!(), "hermes"]]), tasks, () => changed++);
    spool.start(20);
    const CLI = join(import.meta.dir, "../deploy/memo-spool/plasmod-task");
    const run = async (args: string[], stdin?: string) => {
      const p = Bun.spawn(["python3", "-I", CLI, "--as", "default", ...args], { env: { ...process.env, PLASMOD_MEMO_SPOOL: dir, PLASMOD_MEMO_TIMEOUT: "5" }, stdin: stdin ? new TextEncoder().encode(stdin) : "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, code };
    };
    const add = ["add", "--source", "mail", "--key", "18c2f", "--title", "請求書の件", "--kind", "reply", "--propose", "kanban", "--agent", "acct", "--event-at", "2026-10-24T09:00:00+09:00"];
    const first = await run(add, "10/31 払い");
    expect(first.code).toBe(0);
    expect(first.out).toContain("登録した: TASK-1（BackLog）請求書の件");
    expect((await run(add, "10/31 払い")).out).toContain("変わらず: TASK-1");
    expect(changed).toBe(1);
    tasks.decide(1, "done", "", "app", Date.now(), "", "unneeded");
    expect((await run(add, "10/31 払い")).out).toContain("登録しなかった: TASK-1（Done・不要）請求書の件 — 完了（判断のあとに元の新しい動きが無い）");
    const found = await run(["find", "--source", "mail", "--key", "18c2f"]);
    expect(found.out).toContain("不要");
    expect(found.out).toContain("hermes/default");
    expect((await run(["list"])).out).toContain("当てはまるタスクは無い");
    expect((await run(["list", "--status", "dismissed"])).out).toContain("請求書の件");
    const bad = await run(["add", "--source", "mail", "--key", "x", "--title", "t", "--due", "あした"]);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("due");
    spool.stop();
  });

  test("状態を指定して登録する・誰が登録したものでも状態を動かせる（CLI）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-spool-"));
    dirs.push(dir);
    const store = new Store(":memory:");
    const tasks = new TaskStore(store.db);
    const spool = new MemoSpool(new MemoStore(store.db), dir, new Map([[process.getuid!(), "dev"]]), tasks, () => {});
    spool.start(20);
    const CLI = join(import.meta.dir, "../deploy/memo-spool/plasmod-task");
    const run = async (args: string[]) => {
      const p = Bun.spawn(["python3", "-I", CLI, ...args], { env: { ...process.env, PLASMOD_MEMO_SPOOL: dir, PLASMOD_MEMO_TIMEOUT: "5" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, code };
    };
    // 計画の子は BackLog にしない（カードにならない）
    const a = await run(["add", "--source", "dev", "--key", "plan:1", "--title", "段1", "--status", "doing", "本文"]);
    expect(a.out).toContain("登録した: TASK-1（AI-Driven）段1");
    expect(tasks.inbox()).toEqual([]);
    expect(tasks.events(1)[0].text).toBe("dev: plan:1（AI-Drivenで登録）");
    // もうあるタスクの状態は、--status では変わらない
    tasks.decide(1, "todo", "", "app");
    expect((await run(["add", "--source", "dev", "--key", "plan:1", "--title", "段1", "--status", "doing", "本文"])).out).toContain("変わらず: TASK-1（Todo）");
    // status で動かせる
    expect((await run(["status", "TASK-1", "done", "終わった"])).out).toContain("TASK-1    Done");
    expect(tasks.events(1)[0].text).toBe("Done: 終わった");
    // ほかの人が登録したものも動かせる。誰が動かしたかは記録に残る
    const other = tasks.upsert({ source: "mail", key: "m", title: "メール" }, "hermes/default").task;
    const r = await run(["status", other.ref!, "done", "実態に合わせた"]);
    expect(r.code).toBe(0);
    expect(tasks.get(other.id)?.status).toBe("done");
    expect(tasks.events(other.id)[0]).toMatchObject({ author: "dev", text: "Done: 実態に合わせた" });
    spool.stop();
  });

  test("親子・つながり（CLI）。番号でも数字でも指せる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-spool-"));
    dirs.push(dir);
    const store = new Store(":memory:");
    const tasks = new TaskStore(store.db);
    let changed = 0;
    const spool = new MemoSpool(new MemoStore(store.db), dir, new Map([[process.getuid!(), "dev"]]), tasks, () => changed++);
    spool.start(20);
    const CLI = join(import.meta.dir, "../deploy/memo-spool/plasmod-task");
    const run = async (args: string[]) => {
      const p = Bun.spawn(["python3", "-I", CLI, ...args], { env: { ...process.env, PLASMOD_MEMO_SPOOL: dir, PLASMOD_MEMO_TIMEOUT: "5" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, code };
    };
    const add = (key: string, title: string, ...extra: string[]) => run(["add", "--source", "dev", "--key", key, "--title", title, ...extra, "本文"]);
    await add("plan", "親");
    await add("s1", "段1");
    // 登録と一緒に親を付ける。同じ中身でも親が変われば「更新した」
    expect((await add("s2", "段2", "--parent", "TASK-1")).out).toContain("登録した: TASK-3");
    expect(tasks.get(3)!.parentId).toBe(1);
    expect((await add("s2", "段2", "--parent", "TASK-1")).out).toContain("変わらず: TASK-3");
    expect((await add("s2", "段2", "--parent", "TASK-2")).out).toContain("更新した: TASK-3");
    expect((await run(["parent", "TASK-3", "TASK-1"])).out).toContain("TASK-3");
    expect((await run(["parent", "#2", "1"])).code).toBe(0);
    expect(tasks.links(1).children.map((t) => t.ref)).toEqual(["TASK-2", "TASK-3"]);
    // 自分の子孫は親にできない
    const loop = await run(["parent", "TASK-1", "TASK-3"]);
    expect(loop.code).not.toBe(0);
    expect(loop.err).toContain("子孫");
    expect((await run(["parent", "TASK-3"])).code).not.toBe(0);
    expect((await run(["parent", "TASK-3", "--none"])).out).toContain("親なし");
    expect(tasks.get(3)!.parentId).toBeNull();
    // つながり
    expect((await run(["link", "TASK-2", "TASK-3", "--kind", "blocks"])).out).toContain("止めている:\n  TASK-3");
    expect(tasks.links(3).blockedBy.map((t) => t.ref)).toEqual(["TASK-2"]);
    const ls = await run(["links", "TASK-2"]);
    expect(ls.out).toContain("親:\n  TASK-1");
    expect(ls.out).toContain("止めている:\n  TASK-3");
    await run(["link", "TASK-2", "TASK-3", "--kind", "blocks", "--off"]);
    expect(tasks.links(3).blockedBy).toEqual([]);
    expect((await run(["links", "TASK-3"])).out).toContain("親・子・つながりは無い");
    expect((await run(["parent", "TASK-99", "TASK-1"])).err).toContain("このタスクは無い: TASK-99");
    expect(tasks.events(3).some((e) => e.author === "dev" && e.text.includes("親を TASK-1 にした"))).toBe(true);
    expect(changed).toBeGreaterThan(3);
    spool.stop();
  });
});

describe("タスクの画面（段階2）", () => {
  test("画面で足す・書き換える・状態を変える・記録が残る", () => {
    const s = fresh();
    const t = s.create({ title: "見積もりを送る", project: "probe", due: "2026-10-30" }, "app", 1000);
    expect(t).toMatchObject({ status: "todo", source: "app", sourceKey: null, project: "probe", due: "2026-10-30" });
    const u = s.update(t.id, { body: "先方は木曜まで", due: null, baseUpdatedAt: t.updatedAt }, "app", 2000);
    expect(u).toMatchObject({ body: "先方は木曜まで", due: null });
    expect(() => s.update(t.id, { title: "x", baseUpdatedAt: t.updatedAt }, "app", 3000)).toThrow(/ほかで書き換え/);
    expect(s.update(t.id, { status: "doing" }, "app", 4000)).toMatchObject({ status: "doing", decidedAt: 4000 });
    expect(s.events(t.id).map((e) => [e.kind, e.text])).toEqual([
      ["decide", "AI-Driven"],
      ["update", "本文・期日 → なし"],
      ["create", "画面で追加"],
    ]);
    expect(() => s.create({ title: " " }, "app")).toThrow(/題/);
    expect(() => s.update(t.id, { due: "来週" }, "app")).toThrow(/期日/);
  });

  test("一覧: 期日の近い順、状態ごとの件数、プロジェクトで絞る", () => {
    const s = fresh();
    s.create({ title: "b", due: "2026-11-02", project: "P" }, "app");
    s.create({ title: "a", due: "2026-10-31" }, "app");
    s.create({ title: "c" }, "app");
    s.upsert(mail(), "hermes/default");
    const v = s.view({});
    expect(v.tasks.map((t) => t.title)).toEqual(["a", "b", "田中商事 請求書", "c"]); // 期日の無いものは新しい順
    expect(v.counts).toMatchObject({ inbox: 1, todo: 3, done: 0 });
    expect(v.projects).toEqual([{ name: "P", count: 1 }]);
    expect(s.view({ project: "P" }).tasks.map((t) => t.title)).toEqual(["b"]);
    expect(s.view({ project: "" }).tasks.length).toBe(3);
    expect(s.view({ status: ["inbox"] }).tasks.map((t) => t.source)).toEqual(["mail"]);
  });

  test("アプリ全体の検索に載り、不要にすると外れる", () => {
    const store = new Store(":memory:");
    const s = new TaskStore(store.db);
    const { SearchIndex } = require("../src/server/search") as typeof import("../src/server/search");
    const idx = new SearchIndex(store.db);
    const t = s.create({ title: "サーバーの更新", body: "カーネルを上げる" }, "app");
    expect(idx.search("カーネル").map((h) => [h.kind, h.ref])).toEqual([["apptask", String(t.id)]]);
    s.update(t.id, { status: "done", doneReason: "unneeded" }, "app");
    expect(idx.search("カーネル")).toEqual([]);
  });

  test("API: 一覧・作成・更新・コメント（カンバンの /api/tasks とは別）", async () => {
    const { createApp } = await import("../src/server/app");
    const store = new Store(":memory:");
    const tasks = new TaskStore(store.db);
    const hub = new Hub({ ...config, devNoAuth: true }, new FixtureSource(FIXTURE), store, null, null);
    hub.setTasks(tasks);
    const app = createApp({ ...config, devNoAuth: true }, hub, store, ".", { tasks });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const made = await (await call("POST", "/api/apptasks", { title: "書類を出す", due: "2026-11-01" })).json();
    expect(made).toMatchObject({ title: "書類を出す", status: "todo" });
    expect((await call("PATCH", `/api/apptasks/${made.id}`, { status: "done", baseUpdatedAt: made.updatedAt })).status).toBe(200);
    expect((await call("PATCH", `/api/apptasks/${made.id}`, { title: "x", baseUpdatedAt: made.updatedAt })).status).toBe(409);
    expect((await (await call("GET", "/api/apptasks")).json()).tasks).toEqual([]);
    expect((await (await call("GET", "/api/apptasks?status=done")).json()).tasks.length).toBe(1);
    const c = await (await call("POST", `/api/apptasks/${made.id}/comment`, { text: "提出済み" })).json();
    expect(c.events[0]).toMatchObject({ kind: "comment", text: "提出済み", author: "app" });
    expect((await call("GET", "/api/apptasks/abc")).status).toBe(400);
    expect((await call("GET", "/api/apptasks/999")).status).toBe(404);
    const snap = (await call("GET", "/api/apptasks/1")).headers.get("cache-control");
    expect(snap).toBe("no-store");
  });
});

describe("状態は4つ（2026-10-29）", () => {
  test("前の返事待ちは、起動のときに完了へ移し、記録に残す", () => {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(":memory:");
    const a = new TaskStore(db);
    const t = a.upsert({ source: "mail", key: "w1", title: "返事待ちだったもの" }, "x", 1000).task;
    db.query("UPDATE tasks SET status = 'waiting' WHERE id = ?").run(t.id);
    const b = new TaskStore(db);
    expect(b.get(t.id)?.status).toBe("done");
    expect(b.events(t.id)[0].text).toBe("返事待ちから完了へ（状態を4つにしたため）");
    // 新しい動きがあれば、これまでの返事待ちと同じく BackLog に戻る
    expect(b.upsert({ source: "mail", key: "w1", title: "返事待ちだったもの", eventAt: Date.now() + 1000 }, "x").action).toBe("reopened");
  });
});
