import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { createApp } from "../src/server/app";
import { requireLogin, requireRootLogin, tailscaleEnv } from "../src/server/auth";
import { BridgeClient } from "../src/server/bridge";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { checkTaskId, FixtureSource } from "../src/server/kanban";
import { deriveAgents, deriveCards, snoozeUntil } from "../src/server/model";
import { cardNotice, Notifier } from "../src/server/notify";
import { NotifyFeed } from "../src/server/notify-feed";
import { Store } from "../src/server/store";
import { TaskStore } from "../src/server/tasks";
import { hoursLabel, staleHours, type Board, type PermissionRequest } from "../src/shared/types";

const FIXTURE = join(import.meta.dir, "../fixtures/board.json");
const cfg = config;
const perm: PermissionRequest = {
  thread: "42", request_id: "abcde", tool_name: "Bash", description: "git push", input_preview: "git push origin main",
  thread_title: "t", created_at: 1_000,
};

class FakeBridge extends BridgeClient {
  verdicts: string[] = [];
  reqs: PermissionRequest[] = [];
  constructor() {
    super("/nonexistent");
    this.connected = true;
  }
  override requests() {
    return this.reqs;
  }
  override verdict(thread: string, rid: string, behavior: "allow" | "deny") {
    this.verdicts.push(`${thread}:${rid}:${behavior}`);
    this.reqs = this.reqs.filter((r) => r.request_id !== rid);
  }
}

async function setup() {
  const store = new Store(":memory:");
  const source = new FixtureSource(FIXTURE);
  const bridge = new FakeBridge();
  const hub = new Hub(cfg, source, store, bridge, null);
  await hub.refresh();
  return { store, source, bridge, hub };
}

describe("model", () => {
  test("blocked・review・承認依頼がカードになり、承認依頼が先頭に来る", async () => {
    const board = (await new FixtureSource(FIXTURE).board()) as Board;
    const cards = deriveCards(board, [perm], cfg.profiles, { snoozedUntil: new Map(), decidedAt: new Map() });
    expect(cards.map((c) => c.key)).toEqual(["perm:42:abcde", "task:t_8f2a", "task:t_91c0"]);
    expect(cards[1].body).toContain("PR #23");
    expect(cards[1].agent).toBe("dev");
  });

  test("同じ種類では長く待っているカードが古い順に先に来て、新しいものは新しい順", async () => {
    const now = 1_800_000_000_000;
    const task = (id: string, hoursAgo: number) =>
      ({ id, title: id, status: "blocked", assignee: "dev", created_at: (now - hoursAgo * 3600_000) / 1000 }) as Board["tasks"][number];
    const board = { tasks: [task("t_new", 1), task("t_old8", 8), task("t_mid", 2), task("t_old5", 5)] } as Board;
    const cards = deriveCards(board, [], cfg.profiles, { snoozedUntil: new Map(), decidedAt: new Map() }, now);
    expect(cards.map((c) => c.key)).toEqual(["task:t_old8", "task:t_old5", "task:t_new", "task:t_mid"]);
    expect(staleHours(cards[0], now)).toBe(8);
    expect(staleHours(cards[2], now)).toBeNull();
    expect([4, 23, 24, 47, 72, 29 * 24 + 23, 30 * 24, 65 * 24].map((h) => hoursLabel(h).short)).toEqual(["4h", "23h", "1d", "1d", "3d", "29d", "1m", "2m"]);
    expect(hoursLabel(48).long).toBe("2日");
  });

  test("スヌーズ中と判断済みのカードは隠れ、カードが更新されたら再び出る", async () => {
    const board = (await new FixtureSource(FIXTURE).board()) as Board;
    const now = Date.now();
    const base = { snoozedUntil: new Map([["task:t_91c0", now + 60_000]]), decidedAt: new Map([["task:t_8f2a", 1792373100 * 1000]]) };
    expect(deriveCards(board, [], cfg.profiles, base, now).map((c) => c.key)).toEqual([]);
    const later = { ...base, decidedAt: new Map([["task:t_8f2a", 1792373100 * 1000 - 1]]) };
    expect(deriveCards(board, [], cfg.profiles, later, now).map((c) => c.key)).toEqual(["task:t_8f2a"]);
  });

  test("伏せているカードは snoozed=\"only\" で別に取れ、期限が付く", async () => {
    const board = (await new FixtureSource(FIXTURE).board()) as Board;
    const now = Date.now();
    const filter = { snoozedUntil: new Map([["task:t_91c0", now + 60_000]]), decidedAt: new Map<string, number>() };
    const snoozed = deriveCards(board, [], cfg.profiles, { ...filter, snoozed: "only" }, now);
    expect(snoozed.map((c) => [c.key, c.snoozedUntil])).toEqual([["task:t_91c0", now + 60_000]]);
    expect(deriveCards(board, [], cfg.profiles, filter, now).map((c) => c.key)).not.toContain("task:t_91c0");
    // 期限が過ぎたら普通のカードに戻る
    expect(deriveCards(board, [], cfg.profiles, { ...filter, snoozed: "only" }, now + 120_000)).toEqual([]);
  });

  test("エージェントの状態: 実行中・停止・待機と、ハブが先頭", async () => {
    const board = (await new FixtureSource(FIXTURE).board()) as Board;
    const agents = deriveAgents(board, cfg.profiles, "default");
    expect(agents[0].id).toBe("default");
    const by = Object.fromEntries(agents.map((a) => [a.id, a]));
    expect(by.dev.state).toBe("running");
    expect(by.dev.blocked).toBe(1);
    expect(by.acct.state).toBe("idle");
    expect(by.acct.ready).toBe(1);
    expect(by.acct.name).toBe("経理くん");
    expect(by.design).toMatchObject({ name: "デザインくん", state: "idle" });
  });

  test("カードIDの検査", () => {
    expect(checkTaskId("t_8f2a")).toBe("t_8f2a");
    expect(() => checkTaskId("t; rm -rf /")).toThrow();
  });
});

describe("判断の実行", () => {
  test("blocked を「進めて」→ コメントして unblock、カードが消える", async () => {
    const { source, hub, store } = await setup();
    await hub.act("task:t_8f2a", "approve", "マージして OK", "app");
    expect(source.log).toEqual([
      "comment t_8f2a オーナーさん（Plasmod）: 承認。進めてください。\n\nマージして OK",
      "unblock t_8f2a",
    ]);
    expect(hub.cards().find((c) => c.key === "task:t_8f2a")).toBeUndefined();
    expect(store.decidedAt().has("task:t_8f2a")).toBe(true);
  });

  test("「指示を付けて戻す」は文章が無いと断る", async () => {
    const { hub, source } = await setup();
    await expect(hub.act("task:t_8f2a", "revise", "  ", "app")).rejects.toThrow("返事の文章");
    expect(source.log).toEqual([]);
  });

  test("review を「完了にする」→ complete", async () => {
    const { hub, source } = await setup();
    await hub.act("task:t_91c0", "complete", "", "ntfy");
    expect(source.log).toEqual(["complete t_91c0 オーナーさん（Plasmod）が確認して完了にした。"]);
  });

  test("承認依頼の許可 → bridge に verdict", async () => {
    const { hub, bridge } = await setup();
    bridge.reqs = [perm];
    await hub.act("perm:42:abcde", "allow", "", "ntfy");
    expect(bridge.verdicts).toEqual(["42:abcde:allow"]);
  });

  test("「あとで」はスヌーズするだけでカンバンは触らない", async () => {
    const { hub, source } = await setup();
    await hub.act("task:t_8f2a", "later", "", "app");
    expect(source.log).toEqual([]);
    expect(hub.cards().find((c) => c.key === "task:t_8f2a")).toBeUndefined();
    // 伏せたカードはスナップショットの snoozed に残り、そこから判断もできる
    expect(hub.snapshot().snoozed.map((c) => c.key)).toEqual(["task:t_8f2a"]);
    await hub.act("task:t_8f2a", "approve", "", "app");
    expect(source.log).toContain("unblock t_8f2a");
  });

  test("カードの詳細からの添付: 先に付けて、「📎 名前」のコメントを残す（添付だけでも）", async () => {
    const { hub, source } = await setup();
    await hub.commentTask("t_8f2a", "", [{ name: "分析.xlsx", data: new Uint8Array(4) }]);
    await hub.commentTask("t_8f2a", "見てください", [{ name: "a.png", data: new Uint8Array(1) }]);
    expect(source.log).toEqual(["attach t_8f2a 分析.xlsx 4", "comment t_8f2a 📎 分析.xlsx", "attach t_8f2a a.png 1", "comment t_8f2a 見てください\n\n📎 a.png"]);
  });

  test("「あとで」でも、書いたコメントと添付は捨てずにカードへ届ける", async () => {
    const { hub, source } = await setup();
    await hub.act("task:t_8f2a", "later", "明日見る", "app", [{ name: "memo.png", data: new Uint8Array(3) }]);
    expect(source.log).toEqual(["comment t_8f2a オーナーさん（Plasmod）: 明日見る", "attach t_8f2a memo.png 3"]);
    expect(hub.cards().find((c) => c.key === "task:t_8f2a")).toBeUndefined();
  });

  test("選択肢と一緒の添付は、先にカードへ付けてから実行する", async () => {
    const { hub, source } = await setup();
    await hub.act("task:t_8f2a", "approve", "", "app", [{ name: "spec.pdf", data: new Uint8Array(5) }]);
    expect(source.log).toEqual(["attach t_8f2a spec.pdf 5", "comment t_8f2a オーナーさん（Plasmod）: 承認。進めてください。", "unblock t_8f2a"]);
  });

  test("無いカード・無い選択肢は断る", async () => {
    const { hub } = await setup();
    await expect(hub.act("task:nope", "approve", "", "app")).rejects.toThrow("判断済み");
    await expect(hub.act("task:t_8f2a", "allow", "", "app")).rejects.toThrow("選択肢");
  });
});

describe("通知", () => {
  /** 流れに出た通知を集める */
  function notifier(store: Store, over: Partial<typeof cfg> = {}) {
    const feed = new NotifyFeed(store.db);
    const notices = () => feed.since(0).filter((e) => e.type === "notice");
    return { n: new Notifier({ ...cfg, ...over }, store, feed), notices };
  }

  test("カードの通知: 入力不要の選択肢がボタンになり、押すとカードを開く", async () => {
    const { hub } = await setup();
    const m = cardNotice(cfg, hub.cards().find((c) => c.key === "task:t_8f2a")!, 1);
    expect(m.actions).toEqual([{ label: "進めて", option: "approve" }]);
    expect(m.path).toBe("#/card/task%3At_8f2a");
  });

  test("返事の通知: エージェントの名前・本文の先頭・セッションを開く", async () => {
    const { store } = await setup();
    const { n, notices } = notifier(store);
    n.reply("default", "s/1", "了解。\n\n\n\n" + "あ".repeat(700));
    const [m] = notices();
    expect(m).toMatchObject({ title: "ハブから返事", kind: "reply", path: "#/session/default/s%2F1" });
    if (m.type !== "notice") throw new Error("notice でない");
    expect(m.message.startsWith("了解。\n\nあ")).toBe(true);
    expect(m.message.endsWith("…")).toBe(true);
  });

  test("初回 → 再通知（間隔後）→ 回数を超えたら止まる", async () => {
    const { hub, store } = await setup();
    const { n, notices } = notifier(store, { renotifyMin: 15, renotifyMax: 2 });
    const cards = hub.cards().filter((c) => c.key === "task:t_8f2a");
    const t0 = Date.now();
    await n.sweep(cards, t0);
    expect(notices().length).toBe(1);
    await n.sweep(cards, t0 + 5 * 60_000); // まだ間隔内
    expect(notices().length).toBe(1);
    await n.sweep(cards, t0 + 16 * 60_000);
    expect(notices().length).toBe(2);
    expect(store.notification("task:t_8f2a")!.attempts).toBe(2);
    await n.sweep(cards, t0 + 32 * 60_000); // 回数上限
    await n.sweep(cards, t0 + 60 * 60_000);
    expect(notices().length).toBe(2);
  });

  test("既読にしたら再通知しない・カードが消えたら記録も消える", async () => {
    const { hub, store } = await setup();
    const { n, notices } = notifier(store);
    const cards = hub.cards();
    await n.sweep(cards);
    store.markSeen("task:t_8f2a");
    await n.sweep(cards, Date.now() + 60 * 60_000);
    expect(notices().length).toBe(cards.length + cards.length - 1);
    await n.sweep([]);
    expect(store.notification("task:t_8f2a")).toBeNull();
  });
});

describe("bridge クライアント", () => {
  test("承認依頼と解決を JSON 行で受け取る", () => {
    const b = new BridgeClient("/nonexistent");
    let changes = 0;
    b.onChange(() => changes++);
    b.handle(JSON.stringify({ type: "permission_request", thread: "42", request_id: "abcde", tool_name: "Bash", created_at: 5 }));
    expect(b.requests()[0]).toMatchObject({ thread: "42", request_id: "abcde", tool_name: "Bash", created_at: 5000 });
    b.handle(JSON.stringify({ type: "permission_resolved", thread: "42", request_id: "abcde", behavior: "allow" }));
    expect(b.requests()).toEqual([]);
    b.handle("not json");
    expect(changes).toBe(2);
  });
});

describe("認証（入口は Tailscale だけ）", () => {
  const base = { allowedLogins: ["owner@example.com"], devNoAuth: false, tailscaleSelfIps: ["100.64.0.1", "fd7a:115c:a1e0::1"] };
  const me = { "Tailscale-User-Login": "owner@example.com" };
  const phone = { "X-Forwarded-For": "100.64.0.9" };

  function appWith(c: typeof base | Omit<typeof base, "tailscaleSelfIps">) {
    const app = new Hono();
    app.use("*", requireLogin(c));
    app.get("/api/snapshot", (x) => x.text("ok"));
    app.get("/api/health", (x) => x.text("ok"));
    app.post("/notify-relay", (x) => x.text("ok"));
    return (headers: Record<string, string>, env?: object) => app.request("/api/snapshot", { headers }, env);
  }

  test("Tailscale の入口（unix ソケット）から来た、許可リストの本人だけ通す", async () => {
    const get = appWith(base);
    expect((await get({ ...phone, ...me }, tailscaleEnv())).status).toBe(200);
    expect((await get({ ...phone, "Tailscale-User-Login": "other@example.com" }, tailscaleEnv())).status).toBe(403);
    expect((await get(phone, tailscaleEnv())).status).toBe(403);
  });

  test("TCP（127.0.0.1）は VPS の中の誰でも叩けるので、ヘッダーを付けても通さない", async () => {
    const get = appWith(base);
    expect((await get({ ...phone, ...me })).status).toBe(403);
    // 印に似せた env（文字列のキー）でも通らない
    expect((await get({ ...phone, ...me }, { "via-tailscale": true })).status).toBe(403);
  });

  test("VPS 自身から tailnet 越しに来たもの（開発くんなど）は、本人の名前が付いていても通さない", async () => {
    const get = appWith(base);
    expect((await get({ ...me, "X-Forwarded-For": "100.64.0.1" }, tailscaleEnv())).status).toBe(403);
    expect((await get({ ...me, "X-Forwarded-For": "FD7A:115C:A1E0::1" }, tailscaleEnv())).status).toBe(403);
    // どこから来たか分からないものも通さない
    expect((await get(me, tailscaleEnv())).status).toBe(403);
    // VPS の住所が分からない（tailscale ip が読めなかった）ときは全部断る
    const { tailscaleSelfIps: _, ...noSelf } = base;
    expect((await appWith(noSelf)({ ...phone, ...me }, tailscaleEnv())).status).toBe(403);
    expect((await appWith({ ...base, tailscaleSelfIps: ["*"] })({ ...phone, ...me }, tailscaleEnv())).status).toBe(403);
  });

  test("Cloudflare Access の JWT はもう本人の証明にならない", async () => {
    expect((await appWith(base)({ "cf-ray": "abc", "Cf-Access-Jwt-Assertion": "x.y.z" })).status).toBe(403);
  });

  test("死活確認と知らせの受け口は認証の手前を通す（受け口の中でトークンを照らす）", async () => {
    const app = new Hono();
    app.use("*", requireLogin(base));
    app.get("/api/health", (x) => x.text("ok"));
    app.post("/notify-relay", (x) => x.text("ok"));
    app.post("/api/act/:t/:o", (x) => x.text("ok"));
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/notify-relay", { method: "POST" })).status).toBe(200);
    // 前の通知ボタンの道は、もう認証なしでは通らない
    expect((await app.request("/api/act/x/y", { method: "POST" })).status).toBe(403);
  });

  test("root 作業の承認: Tailscale の入口から来た VPS の外の本人だけ。VPS 自身・TCP のヘッダーは通さない", async () => {
    const app = new Hono();
    app.use("*", requireRootLogin(base));
    app.post("/api/root/approve", (c) => c.text(String(c.get("loginName" as never))));
    const post = (headers: Record<string, string>, env?: object) => app.request("/api/root/approve", { method: "POST", headers: { ...me, ...headers } }, env);
    const ok = await post(phone, tailscaleEnv());
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("owner@example.com（Tailscale）");
    expect((await post({ "X-Forwarded-For": "100.64.0.1" }, tailscaleEnv())).status).toBe(403); // VPS 自身（開発くん）
    expect((await post({}, tailscaleEnv())).status).toBe(403); // 接続元なし
    expect((await post({ ...phone, "Tailscale-User-Login": "other@example.com" }, tailscaleEnv())).status).toBe(403);
    expect((await post(phone)).status).toBe(403); // TCP
  });
});

describe("レポート", () => {
  test("判断待ちと、24時間の実績をまとめた1枚ができる", async () => {
    const { hub } = await setup();
    const now = (1792310000 + 3600) * 1000; // t_a004 が片付いた1時間後
    const { buildReport } = await import("../src/server/report");
    const r = buildReport(hub.board, hub.cards(), cfg.profiles, now);
    expect(r.slides.map((s) => s.kind)).toEqual(["waiting", "digest"]);
    const sum = r.slides[1] as Extract<(typeof r.slides)[number], { kind: "digest" }>;
    expect(sum.done).toBe(1);
    expect(sum.cards.map((c) => c.name)).toEqual(["文字起こし再試行の修正"]);
    const waiting = r.slides[0] as Extract<(typeof r.slides)[number], { kind: "waiting" }>;
    expect(waiting.items.map((i) => i.key)).toEqual(["task:t_8f2a", "task:t_91c0"]);
  });

  test("何も片付いていなくても、判断待ちとまとめは出る", async () => {
    const { hub } = await setup();
    const { buildReport } = await import("../src/server/report");
    const r = buildReport(hub.board, [], cfg.profiles, Date.now() + 30 * 86400_000);
    expect(r.slides.map((s) => s.kind)).toEqual(["waiting", "digest"]);
  });
});

describe("検索・メモ", () => {
  test("カンバン・判断・メモを日本語で引ける（3文字以上は全文検索、2文字以下は部分一致）", async () => {
    const { hub } = await setup();
    hub.snapshot(); // 索引は changed で作られる
    await hub.act("task:t_8f2a", "approve", "staging を見てからマージ", "app");
    hub.addNote("宿の件", "カシュガルはオールドタウン寄りがいい", "report");
    expect(hub.find("マージ").map((h) => h.kind).sort()).toEqual(["decision", "task"]);
    expect(hub.find("オールドタウン")[0]).toMatchObject({ kind: "note", title: "宿の件" });
    expect(hub.find("宿").map((h) => h.kind)).toContain("note");
    expect(hub.find("請求書 確認").map((h) => h.ref)).toEqual(["t_91c0"]);
    expect(hub.find("存在しない言葉")).toEqual([]);
    expect(hub.find("100%_")).toEqual([]); // LIKE の記号を素通ししない
  });

  test("レポートを開くと日付ごとに1件、検索に残る", async () => {
    const { hub } = await setup();
    hub.report();
    hub.report();
    expect(hub.find("判断待ち").filter((h) => h.kind === "report").length).toBe(1);
  });

  test("Hermes の承認待ちはカードになり、許可は「今回だけ」、拒否は deny で返す", async () => {
    const { hub } = await setup();
    const answers: [string, string][] = [];
    let pending = [{ id: "a1", agent: "default", session: "s1", runId: "run_1", command: "rm -rf /tmp/x", description: "再帰削除", createdAt: Date.now() }];
    hub.setApprovals({
      pendingApprovals: () => pending,
      answerApproval: async (id, choice) => {
        answers.push([id, choice]);
        pending = [];
      },
    });
    const card = hub.cards().find((c) => c.key === "hperm:a1")!;
    expect(card).toMatchObject({ kind: "permission", agent: "default", title: "承認が必要: 再帰削除", body: "rm -rf /tmp/x", requestId: "a1" });
    await hub.act("hperm:a1", "allow", "", "app");
    expect(answers).toEqual([["a1", "once"]]);
    expect(hub.cards().some((c) => c.key === "hperm:a1")).toBe(false);
  });

  test("あとでの長さ: 3時間・次の朝 8 時（JST）・次の月曜の朝", () => {
    // 2026-11-05 は木曜。22:00 JST
    const now = Date.UTC(2026, 10, 5, 13, 0);
    expect(snoozeUntil("3h", now)).toBe(now + 3 * 3_600_000);
    expect(new Date(snoozeUntil("morning", now)).toISOString()).toBe("2026-11-05T23:00:00.000Z"); // 11/06 08:00 JST
    expect(new Date(snoozeUntil("week", now)).toISOString()).toBe("2026-11-08T23:00:00.000Z"); // 11/09（月）08:00 JST
    // 朝 8 時より前なら、今日の 8 時
    const early = Date.UTC(2026, 10, 5, 21, 0); // 11/06 06:00 JST
    expect(new Date(snoozeUntil("morning", early)).toISOString()).toBe("2026-11-05T23:00:00.000Z");
    // 月曜の朝なら、来週の月曜
    const monday = Date.UTC(2026, 10, 9, 0, 0); // 11/09（月）09:00 JST
    expect(new Date(snoozeUntil("week", monday)).toISOString()).toBe("2026-11-15T23:00:00.000Z");
  });

  test("あとでの長さを指定すると、その時刻まで伏せる。指定なしは既定", async () => {
    const { hub, store } = await setup();
    await hub.act("task:t_8f2a", "later", "", "app", [], "week");
    const until = store.snoozedUntil().get("task:t_8f2a")!;
    expect(until).toBe(snoozeUntil("week"));
    expect(hub.cards().some((c) => c.key === "task:t_8f2a")).toBe(false);
  });

  test("検索: 番号そのものなら、そのタスクが一番上", async () => {
    const { store } = await setup();
    const hub = new Hub(cfg, new FixtureSource(FIXTURE), store, null, null);
    const tasks = new TaskStore(store.db);
    hub.setTasks(tasks);
    const a = tasks.create({ title: "本体のタスク" }, "app");
    tasks.create({ title: "あとから書いた別のタスク", body: `${a.ref} の続き` }, "app");
    const low = hub.find(a.ref!.toLowerCase());
    expect(low[0]).toMatchObject({ kind: "apptask", ref: String(a.id), title: "本体のタスク" });
    expect(low.length).toBe(2);
    expect(hub.find("TASK-99999")).toEqual([]);
  });

  test("メモはカードになり、「済み」で消える。通知はしない", async () => {
    const { hub, store } = await setup();
    const n = new Notifier(cfg, store);
    const hub2 = new Hub(cfg, new FixtureSource(FIXTURE), store, null, n);
    await hub2.refresh();
    const note = hub2.addNote("あとで見る", "本文", "report");
    expect(hub2.cards().some((c) => c.key === `note:${note.id}`)).toBe(true);
    await Bun.sleep(10);
    expect(store.notification(`note:${note.id}`)).toBeNull();
    await hub2.act(`note:${note.id}`, "done", "", "app");
    expect(hub2.cards().some((c) => c.key === `note:${note.id}`)).toBe(false);
    void hub;
  });
});
