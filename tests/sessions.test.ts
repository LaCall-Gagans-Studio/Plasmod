import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeClient } from "../src/server/bridge";
import { HermesApi, parseHermesApi, SessionService, textOf, toolLabel } from "../src/server/sessions";

// ---- 偽の Hermes API サーバー ----
const KEY = "test-key";
const sessions: { id: string; title: string; updated_at: number; source?: string }[] = [
  { id: "s1", title: "朝の振り分け", updated_at: 1_700_000_000 },
  { id: "cron_f430d6d69d61_20261022_080035", title: "見回り · Oct 22 08:06", updated_at: 1_699_999_000, source: "cron" },
  { id: "x9", title: "source だけで分かる回", updated_at: 1_699_998_000, source: "cron" },
];
const messages: Record<string, { role: string; content: unknown; tool_calls?: unknown[]; timestamp?: number }[]> = {
  s1: [
    { role: "system", content: "隠す" },
    { role: "user", content: "おはよう" },
    { role: "assistant", content: [{ type: "text", text: "おはようございます" }] },
  ],
};
let server: ReturnType<typeof Bun.serve>;
let approvalBody: unknown = null;
let approvalGiven: (() => void) | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("Authorization") !== `Bearer ${KEY}`) return new Response("no", { status: 401 });
      const url = new URL(req.url);
      const p = url.pathname.replace(/^\/p\/acct1/, "");
      if (p === "/api/sessions" && req.method === "GET") return Response.json({ sessions });
      if (p === "/api/sessions" && req.method === "POST") {
        const { title } = (await req.json()) as { title: string };
        // Hermes と同じ: 題名の重複は 400
        const dup = sessions.find((x) => x.title === title);
        // Python の json と同じく日本語は \uXXXX で返す
        if (dup) {
          const json = JSON.stringify({ error: { message: `Title '${title}' is already in use by session ${dup.id}`, code: "invalid_title" } });
          return new Response(json.replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const s = { id: `s${sessions.length + 1}`, title, updated_at: 1_700_000_100 };
        sessions.push(s);
        messages[s.id] = [];
        return Response.json({ session: s });
      }
      if (p === "/v1/runs/run_1/approval" && req.method === "POST") {
        approvalBody = await req.json();
        approvalGiven?.();
        return Response.json({ resolved: 1 });
      }
      const m = p.match(/^\/api\/sessions\/([^/]+)\/(messages|chat\/stream)$/);
      if (m && m[2] === "messages") {
        // Hermes と同じ: limit があれば新しい方から offset 件飛ばして limit 件（並びは古い順）、無ければ最新の500件
        const all = messages[m[1]] ?? [];
        const limit = Number(url.searchParams.get("limit") ?? 500);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return Response.json({ messages: all.slice().reverse().slice(offset).slice(0, limit).reverse() });
      }
      if (m && m[2] === "chat/stream") {
        const { input } = (await req.json()) as { input: string };
        const body = [
          ": keepalive\n\n",
          `event: tool.started\ndata: ${JSON.stringify({ tool_name: "web_search", preview: "平遥古城", args: { query: "平遥古城 観光車" } })}\n\n`,
          `event: assistant.delta\ndata: ${JSON.stringify({ delta: "了解、" })}\n\n`,
          `event: assistant.delta\ndata: ${JSON.stringify({ delta: "調べます" })}\n\n`,
          `event: run.completed\ndata: {}\n\n`,
        ];
        if (input.includes("道具")) {
          // 道具を使っている途中（記録にはまだ載っていない）
          messages[m[1]].push({ role: "user", content: input });
          return new Response(new ReadableStream({
            async start(c) {
              c.enqueue(new TextEncoder().encode(`event: tool.started\ndata: ${JSON.stringify({ tool_name: "skill_view", args: { name: "travel-lodging" } })}\n\n`));
              await Bun.sleep(300);
              c.enqueue(new TextEncoder().encode("event: run.completed\ndata: {}\n\n"));
              c.close();
            },
          }), { headers: { "Content-Type": "text/event-stream" } });
        }
        if (input.includes("危険")) {
          // Hermes と同じ: 承認待ちを流し、答えが来るまでターンを止める
          return new Response(new ReadableStream({
            async start(c) {
              c.enqueue(new TextEncoder().encode(`event: approval.request\ndata: ${JSON.stringify({ event: "approval.request", run_id: "run_1", command: "rm -rf /tmp/x", description: "再帰削除", choices: ["once", "session", "deny"] })}\n\n`));
              await new Promise<void>((r) => (approvalGiven = r));
              c.enqueue(new TextEncoder().encode("event: run.completed\ndata: {}\n\n"));
              c.close();
            },
          }), { headers: { "Content-Type": "text/event-stream" } });
        }
        if (input.includes("ゆっくり")) {
          // Hermes が走り出した時点で発言を履歴に書き、返事はまだ流している途中
          messages[m[1]].push({ role: "user", content: input });
          return new Response(new ReadableStream({
            async start(c) {
              c.enqueue(new TextEncoder().encode(`event: assistant.delta\ndata: ${JSON.stringify({ delta: "考え中" })}\n\n`));
              await Bun.sleep(300);
              messages[m[1]].push({ role: "assistant", content: "考え中" });
              c.enqueue(new TextEncoder().encode("event: run.completed\ndata: {}\n\n"));
              c.close();
            },
          }), { headers: { "Content-Type": "text/event-stream" } });
        }
        messages[m[1]].push({ role: "user", content: input }, { role: "assistant", content: "了解、調べます" });
        return new Response(new ReadableStream({
          start(c) {
            for (const b of body) c.enqueue(new TextEncoder().encode(b));
            c.close();
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response("nf", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

const api = (profile = "default", key = KEY) =>
  new HermesApi(profile, { url: `http://127.0.0.1:${server.port}${profile === "default" ? "" : `/p/${profile}`}`, key });

describe("Hermes の API サーバー", () => {
  test("一覧・履歴（system は除く、配列の content も文字にする）", async () => {
    const list = await api().list();
    expect(list[0]).toMatchObject({ agent: "default", id: "s1", title: "朝の振り分け", last: 1_700_000_000_000 });
    // cron の回は source か id（cron_…）で印を付ける（一覧のトグルで省く）
    expect(list.map((x) => [x.id, x.cron])).toEqual([["s1", false], ["cron_f430d6d69d61_20261022_080035", true], ["x9", true]]);
    expect(await api().messages("s1")).toEqual([
      { role: "user", text: "おはよう" },
      { role: "assistant", text: "おはようございます" },
    ]);
  });

  test("途中経過: 記録の tool_calls を 読める言い回しの行にまとめる（道具の結果は出さない）", async () => {
    const now = Date.now();
    const call = (name: string, args: unknown) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
    messages.s9 = [
      { role: "user", content: "平遥の宿" },
      { role: "assistant", content: "", tool_calls: [call("skill_view", { name: "travel-lodging" })], timestamp: now / 1000 - 30 },
      { role: "tool", content: "スキルの中身" },
      { role: "assistant", content: "", tool_calls: [call("web_search", { query: "平遥古城 城墙登城 2026" }), call("web_extract", { urls: ["https://www.pygc.com/single/14"] })], timestamp: now / 1000 - 5 },
      { role: "tool", content: "検索結果" },
    ];
    const ms = await api().messages("s9");
    expect(ms.map((m) => m.role)).toEqual(["user", "steps"]);
    expect(ms[1].steps).toEqual(["スキルを読み込み中: travel-lodging", "ウェブを検索中: 平遥古城 城墙登城 2026", "読み込み中: https://www.pygc.com/single/14"]);
    // アプリから送っていないターン（カンバン）でも、途中経過が新しいうちは作業中
    const svc = new SessionService(null, new Map([["default", api()]]));
    const v = await svc.view("default", "s9");
    expect(v.kind === "chat" && v.working).toBe(true);
    messages.s9.push({ role: "assistant", content: "候補は3つ" });
    const done = await svc.view("default", "s9");
    expect(done.kind === "chat" && [done.working, done.messages.map((m) => m.role)]).toEqual([false, ["user", "steps", "assistant"]]);
  });

  test("toolLabel: 引数の取り方・MCP・引数を出さない道具", () => {
    expect(toolLabel("terminal", { command: "ls -la\nrm x" })).toBe("実行中: ls -la");
    expect(toolLabel("read_file", '{"path": "/home/hermes/notes/plan.md"}')).toBe("読み込み中: plan.md");
    expect(toolLabel("mcp__linear__list_issues", { query: "旅" })).toBe("Linear: list_issues: 旅");
    expect(toolLabel("memory", { action: "add", content: "秘密" })).toBe("メモリを更新中");
    expect(toolLabel("my_tool", "壊れた JSON")).toBe("my_tool");
  });

  test("キーが違えばエラー", async () => {
    await expect(api("default", "wrong").list()).rejects.toThrow("HTTP 401");
  });

  test("新しいセッションを作って1ターン流す。途中経過も view に出る", async () => {
    const svc = new SessionService(null, new Map([["acct1", api("acct1")]]));
    const id = await svc.send("acct1", null, "カシュガルの宿を調べて");
    expect(id).toMatch(/^s\d+$/);
    for (let i = 0; i < 50; i++) {
      const v = await svc.view("acct1", id);
      if (v.kind === "chat" && !v.working) break;
      await Bun.sleep(10);
    }
    const v = await svc.view("acct1", id);
    expect(v.kind).toBe("chat");
    if (v.kind === "chat") {
      expect(v.messages.map((m) => m.text)).toEqual(["カシュガルの宿を調べて", "了解、調べます"]);
      expect(v.working).toBe(false);
    }
  });

  test("題名がかぶったら #2・#3 を付けて作り直す（カードから話すと1行目が毎回同じ）", async () => {
    const a = await api().create("カードについて相談したいです");
    const b = await api().create("カードについて相談したいです");
    const c = await api().create("カードについて相談したいです");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(sessions.filter((s) => s.title.startsWith("カードについて相談したいです")).map((s) => s.title)).toEqual([
      "カードについて相談したいです",
      "カードについて相談したいです #2",
      "カードについて相談したいです #3",
    ]);
    // 重複以外の 400 はそのまま投げる
    await expect(api("default", "wrong").create("x")).rejects.toThrow("HTTP 401");
  });

  test("長い日本語の題名がかぶっても #2 で作り直す（エラー文の切り詰めで判定できなかった）", async () => {
    const title = "二枚目の写真を一枚目の天気に合わせて変えてくれる？若干アングルも低くしてほしい".padEnd(60, "。");
    const a = await api().create(title);
    const b = await api().create(title);
    expect(a).not.toBe(b);
    expect(sessions.at(-1)?.title).toBe(`${title} #2`);
  });

  test("アプリから送ったターンの途中経過: 記録に載る前もストリームの道具を出す", async () => {
    const svc = new SessionService(null, new Map([["acct1", api("acct1")]]));
    const id = await svc.send("acct1", null, "道具を使って");
    await Bun.sleep(100);
    const mid = await svc.view("acct1", id);
    expect(mid.kind === "chat" && mid.working).toBe(true);
    expect(mid.kind === "chat" && mid.messages.at(-1)).toEqual({ role: "steps", text: "", steps: ["スキルを読み込み中: travel-lodging"] });
  });

  test("承認待ち: ストリームから受けて一覧に出し、答えると Hermes に返す", async () => {
    let changes = 0;
    const svc = new SessionService(null, new Map([["acct1", api("acct1")]]), () => changes++);
    const sid = await svc.send("acct1", null, "危険なコマンド");
    for (let i = 0; i < 100 && !svc.pendingApprovals().length; i++) await Bun.sleep(10);
    const [a] = svc.pendingApprovals();
    expect(a).toMatchObject({ agent: "acct1", session: sid, runId: "run_1", command: "rm -rf /tmp/x", description: "再帰削除" });
    expect(changes).toBeGreaterThan(0);
    const v = await svc.view("acct1", sid);
    expect(v.kind === "chat" && v.approvalCard).toBe(`hperm:${a.id}`);
    expect(svc.pendingApprovals(a.createdAt + 300_000)).toEqual([]); // 時間切れで消える
    a.createdAt -= 300_000; // 時間切れのものには答えられない
    await expect(svc.answerApproval(a.id, "once")).rejects.toThrow("もう終わっている");
    approvalGiven?.();
  });

  test("承認待ちに答えると Hermes に choice を返し、ターンが進む", async () => {
    const svc = new SessionService(null, new Map([["acct1", api("acct1")]]));
    const sid = await svc.send("acct1", null, "危険なコマンド2");
    for (let i = 0; i < 100 && !svc.pendingApprovals().length; i++) await Bun.sleep(10);
    await svc.answerApproval(svc.pendingApprovals()[0].id, "once");
    expect(approvalBody).toEqual({ choice: "once" });
    expect(svc.pendingApprovals()).toEqual([]);
    for (let i = 0; i < 100; i++) {
      const v = await svc.view("acct1", sid);
      if (v.kind === "chat" && !v.working) break;
      await Bun.sleep(10);
    }
    const v = await svc.view("acct1", sid);
    expect(v.kind === "chat" && v.working).toBe(false);
  });

  test("ターンが終わったら返事を知らせる", async () => {
    const svc = new SessionService(null, new Map([["acct1", api("acct1")]]));
    const got: string[] = [];
    svc.onReply((agent, id, text) => got.push(`${agent}:${id}:${text}`));
    const id = await svc.send("acct1", null, "宿の候補");
    for (let i = 0; i < 50 && !got.length; i++) await Bun.sleep(10);
    expect(got).toEqual([`acct1:${id}:了解、調べます`]);
  });

  test("走っている途中で履歴に発言が載っても、二重に出さない", async () => {
    const svc = new SessionService(null, new Map([["acct1", api("acct1")]]));
    const id = await svc.send("acct1", null, "ゆっくり考えて");
    await Bun.sleep(100);
    const mid = await svc.view("acct1", id);
    expect(mid.kind === "chat" && mid.working).toBe(true);
    expect(mid.kind === "chat" && mid.messages.map((m) => m.text)).toEqual(["ゆっくり考えて", "考え中"]);
    for (let i = 0; i < 50; i++) {
      const v = await svc.view("acct1", id);
      if (v.kind === "chat" && !v.working) break;
      await Bun.sleep(20);
    }
    const end = await svc.view("acct1", id);
    expect(end.kind === "chat" && end.messages.map((m) => m.text)).toEqual(["ゆっくり考えて", "考え中"]);
  });

  test("Hermes のエージェントにファイルを送る: 仲介が置いたパスを本文に添える。仲介が無ければ断る", async () => {
    const put: string[] = [];
    const svc = new SessionService(null, new Map([["acct1", api("acct1")]]), () => {}, () => 0, async (files) => {
      put.push(...files.map((f) => f.name));
      return files.map((f) => `/home/hermes/.hermes/plasmod-inbox/1-${f.name}`);
    });
    const id = await svc.send("acct1", null, "これ読んで", [{ name: "予約.pdf", data: new Uint8Array([1]) }]);
    for (let i = 0; i < 50; i++) {
      const v = await svc.view("acct1", id);
      if (v.kind === "chat" && !v.working) break;
      await Bun.sleep(10);
    }
    expect(put).toEqual(["予約.pdf"]);
    const v = await svc.view("acct1", id);
    // 表示では本文から添付の行を外し、ファイルとして出す
    expect(v.kind === "chat" && v.messages[0]).toMatchObject({ text: "これ読んで", media: [{ name: "1-予約.pdf", kind: "pdf" }] });
    await expect(new SessionService(null, new Map([["acct1", api("acct1")]])).send("acct1", null, "x", [{ name: "a", data: new Uint8Array([1]) }])).rejects.toThrow("仲介");
    // 添付だけでも送れる
    const only = await svc.send("acct1", null, "", [{ name: "b.png", data: new Uint8Array([1]) }]);
    expect(only).toMatch(/^s\d+$/);
  });

  test("設定の読み込み: url と key がそろったものだけ", () => {
    const m = parseHermesApi(JSON.stringify({ default: { url: "http://x/", key: "k" }, acct1: { url: "http://x/p/acct1" } }));
    expect([...m.keys()]).toEqual(["default"]);
    expect(m.get("default")!.url).toBe("http://x");
    expect(parseHermesApi("not json").size).toBe(0);
  });

  test("textOf", () => {
    expect(textOf("a")).toBe("a");
    expect(textOf([{ type: "text", text: "a" }, { type: "image_url" }, "b"])).toBe("a\n[image]\nb");
    expect(textOf(null)).toBe("");
  });
});

describe("開発くん（plasmod-bridge）", () => {
  test("一覧・画面・送信・停止を bridge の id 付き要求で行う。エラーも返る", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-bridge-"));
    const path = join(dir, "app.sock");
    const seen: Record<string, unknown>[] = [];
    const listener = Bun.listen({
      unix: path,
      socket: {
        open(s) {
          s.write(JSON.stringify({ type: "hello" }) + "\n");
        },
        data(s, chunk) {
          for (const line of new TextDecoder().decode(chunk).split("\n").filter(Boolean)) {
            const m = JSON.parse(line);
            seen.push(m);
            const reply = (o: object) => s.write(JSON.stringify({ type: "result", id: m.id, ...o }) + "\n");
            if (m.type === "list_sessions") reply({ ok: true, sessions: [{ thread: "42", title: "demo", alive: true, working: true, last: 1_700_000_000 }] });
            else if (m.type === "pane") m.thread === "42" ? reply({ ok: true, text: "❯ hi", alive: true, working: false }) : reply({ ok: false, error: "知らないセッション" });
            else if (m.type === "send") reply({ ok: true, thread: m.thread ?? "777" });
            else if (m.type === "stop") reply({ ok: true });
            else reply({ ok: false, error: `知らない操作: ${m.type}` });
          }
        },
      },
    });
    const bridge = new BridgeClient(path);
    bridge.start();
    for (let i = 0; i < 100 && !bridge.connected; i++) await Bun.sleep(10);
    const svc = new SessionService(bridge, new Map());
    expect(svc.agents()).toEqual([{ id: "dev", available: true }]);
    expect((await svc.list("dev"))[0]).toMatchObject({ id: "42", working: true, last: 1_700_000_000_000 });
    expect(await svc.view("dev", "42")).toMatchObject({ kind: "terminal", text: "❯ hi", alive: true, working: false });
    await expect(svc.view("dev", "99")).rejects.toThrow("知らないセッション");
    expect(await svc.send("dev", null, "新しく始めて")).toBe("777");
    expect(await svc.send("dev", "42", "続き")).toBe("42");
    await expect(svc.send("dev", "42", "  ")).rejects.toThrow("空");
    await svc.stop("dev", "42");
    await expect(svc.stop("default", "s1")).rejects.toThrow("開発エージェント");
    const ops = seen.map((m) => m.type).filter((t) => t !== "history");
    expect(ops).toEqual(["list_sessions", "pane", "pane", "send", "send", "stop"]);
    expect(seen.filter((m) => m.type === "history").length).toBe(1); // 古い bridge には一度聞いたら、もう聞かない
    const sends = seen.filter((m) => m.type === "send");
    expect(sends[0]).not.toHaveProperty("thread");
    expect(sends[1]).toMatchObject({ thread: "42", text: "続き" });
    bridge.stop();
    listener.stop(true);
  });

  test("bridge につながっていなければすぐエラー", async () => {
    const b = new BridgeClient("/nonexistent");
    await expect(new SessionService(b, new Map()).list("dev")).rejects.toThrow("つながっていない");
  });
});

describe("題名", () => {
  test("メンションや 📱 を外す", async () => {
    const { cleanTitle } = await import("../src/server/sessions");
    expect(cleanTitle("<@1557215487086043266> 今って開発くんと")).toBe("今って開発くんと");
    expect(cleanTitle("📱 Linear の TASK-160 を始めて")).toBe("Linear の TASK-160 を始めて");
    expect(cleanTitle("<@!1> <#2>  ")).toBe("（無題）");
  });
});

describe("エージェントの並びと別名", () => {
  test("プロファイルの順（ハブ・開発くん・デザインくん・経理くん）に並べ、hub1 / acct1 などの別名でも名前が出る", async () => {
    const { config } = await import("../src/server/config");
    const { findProfile } = await import("../src/shared/types");
    const { profileOf } = await import("../src/server/model");
    const order = (id: string) => {
      const p = findProfile(config.profiles, id);
      return p ? config.profiles.indexOf(p) : config.profiles.length;
    };
    const fake = new Map([["acct1", {}], ["hub1", {}], ["design", {}], ["other", {}]]) as never;
    const svc = new SessionService(null, fake, () => {}, order);
    expect(svc.agents().map((a) => a.id)).toEqual(["hub1", "dev", "design", "acct1", "other"]);
    expect(profileOf(config.profiles, "hub1")).toMatchObject({ id: "hub1", name: "ハブ", initial: "ミ" });
    expect(profileOf(config.profiles, "Acct1")).toMatchObject({ name: "経理くん" });
    expect(profileOf(config.profiles, "other").name).toBe("other");
  });
});

describe("前の会話を読む", () => {
  test("Hermes: 最初は最新の500件と目印。上にスクロールしたら100件ずつ。途中で新しい発言が来ても重ならない", async () => {
    messages.s30 = Array.from({ length: 650 }, (_, i) => ({ id: i + 1, role: i % 2 ? "assistant" : "user", content: `m${i + 1}` }) as never);
    const svc = new SessionService(null, new Map([["default", api()]]));
    const v = await svc.view("default", "s30");
    if (v.kind !== "chat") throw new Error("chat のはず");
    expect(v.messages.length).toBe(500);
    expect(v.messages[0].text).toBe("m151");
    expect(v.cursor).toEqual({ before: "151", offset: 500, more: true });
    const p1 = await svc.older("default", "s30", "151", 500);
    expect(p1.messages.map((m) => (m as { text: string }).text)).toEqual(Array.from({ length: 100 }, (_, i) => `m${i + 51}`));
    expect(p1.cursor).toEqual({ before: "51", offset: 600, more: true });
    // 読んでいる間に新しい発言が5件来た（offset が5件ずれる）
    for (let i = 651; i <= 655; i++) messages.s30.push({ id: i, role: "user", content: `m${i}` } as never);
    const p2 = await svc.older("default", "s30", "51", 600);
    expect(p2.messages.map((m) => (m as { text: string }).text)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i + 1}`));
    expect(p2.cursor.more).toBe(false);
  });

  test("開発くん: 最初は最新の60件。前は bridge の記録（最新の500件まで）から100件ずつ", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-bridge-"));
    const path = join(dir, "app.sock");
    const all = Array.from({ length: 130 }, (_, i) => ({ id: String(i + 1), author: i % 2 ? "dev" : "owner", content: `c${i + 1}`, attachments: [], at: i + 1 }));
    const listener = Bun.listen({
      unix: path,
      socket: {
        open(s) {
          s.write(JSON.stringify({ type: "hello" }) + "\n");
        },
        data(s, chunk) {
          for (const line of new TextDecoder().decode(chunk).split("\n").filter(Boolean)) {
            const m = JSON.parse(line);
            const reply = (o: object) => s.write(JSON.stringify({ type: "result", id: m.id, ok: true, ...o }) + "\n");
            if (m.type === "pane") reply({ text: "", alive: true, working: false });
            else if (m.type === "history") reply({ messages: all.slice(-m.limit) });
          }
        },
      },
    });
    const bridge = new BridgeClient(path);
    bridge.start();
    for (let i = 0; i < 100 && !bridge.connected; i++) await Bun.sleep(10);
    const svc = new SessionService(bridge, new Map());
    const v = await svc.view("dev", "7");
    expect(v.kind === "terminal" && [v.messages?.length, v.messages?.[0].content, v.cursor]).toEqual([60, "c71", { before: "71", more: true }]);
    const p = await svc.older("dev", "7", "71");
    expect(p.messages.map((m) => (m as { content: string }).content)).toEqual(Array.from({ length: 70 }, (_, i) => `c${i + 1}`));
    expect(p.cursor).toEqual({ before: "1", more: false });
    listener.stop(true);
  });
});

describe("開発くんの会話（history と chat）", () => {
  test("最初に履歴を取り、あとは流れてくる発言を足す。古い bridge なら画面だけ", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-bridge-"));
    const path = join(dir, "app.sock");
    let sock: { write(s: string): void } | null = null;
    let historyCalls = 0;
    const listener = Bun.listen({
      unix: path,
      socket: {
        open(s) {
          sock = s;
          s.write(JSON.stringify({ type: "hello" }) + "\n");
        },
        data(s, chunk) {
          for (const line of new TextDecoder().decode(chunk).split("\n").filter(Boolean)) {
            const m = JSON.parse(line);
            const reply = (o: object) => s.write(JSON.stringify({ type: "result", id: m.id, ...o }) + "\n");
            if (m.type === "pane") reply({ ok: true, text: "● Bash(ls)\n  ⎿  a\n✻ Thinking… (3s)", alive: true, working: true });
            else if (m.type === "history" && m.thread === "42") {
              historyCalls++;
              reply({ ok: true, messages: [{ id: "1", author: "owner", content: "お願い", attachments: [], at: 1 }, { id: "2", author: "dev", content: "了解", attachments: [], at: 2 }] });
            } else reply({ ok: false, error: "知らない操作: history" });
          }
        },
      },
    });
    const bridge = new BridgeClient(path);
    bridge.start();
    for (let i = 0; i < 100 && !bridge.connected; i++) await Bun.sleep(10);
    const svc = new SessionService(bridge, new Map());
    const v1 = await svc.view("dev", "42");
    expect(v1.kind === "terminal" && v1.messages?.map((m) => m.content)).toEqual(["お願い", "了解"]);
    sock!.write(JSON.stringify({ type: "chat", thread: "42", message: { id: "3", author: "dev", content: "できたよ", attachments: ["a.png"], at: 3 } }) + "\n");
    sock!.write(JSON.stringify({ type: "chat", thread: "42", message: { id: "3", author: "dev", content: "できたよ", attachments: [], at: 3 } }) + "\n");
    await Bun.sleep(30);
    const v2 = await svc.view("dev", "42");
    expect(v2.kind === "terminal" && v2.messages?.map((m) => [m.author, m.content, m.attachments])).toEqual([
      ["owner", "お願い", []], ["dev", "了解", []], ["dev", "できたよ", ["a.png"]],
    ]);
    expect(historyCalls).toBe(1);
    // 古い bridge（history が無い）: 会話は無しで、画面だけ
    const v3 = await svc.view("dev", "43");
    expect(v3.kind === "terminal" && v3.messages).toBeUndefined();
    expect(v3.kind === "terminal" && v3.chatError).toContain("知らない操作");
    bridge.stop();
    listener.stop(true);
  });
});
