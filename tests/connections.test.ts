import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { connectionRows, ConnectionWatch, type RawConnections } from "../src/server/connections";
import { dashboardUrl, loginResult } from "../src/web/Connections";

const NOW = Date.parse("2026-11-20T00:00:00Z");
const sec = (ms: number) => Math.floor(ms / 1000);
const DAY = 86_400_000;
const healthy = (): RawConnections => ({
  claude: { available: true, loggedIn: true, authMethod: "claude.ai", loginExpiresAt: new Date(NOW + 20 * DAY).toISOString() },
  hermes: {
    nous: { logged_in: true, obtained_at: new Date(NOW - 60_000).toISOString() },
    mcp: { default: { vercel: { enabled: true, oauth: true, token: { exists: true, refresh: true, updated_at: sec(NOW - 60_000), expires_at: sec(NOW + 3_600_000) } } } },
  },
});
const state = (raw: RawConnections, id: string, now = NOW) => connectionRows(raw, now).rows.find((c) => c.id === id);

describe("接続の判定", () => {
  test("正常", () => {
    expect(connectionRows(healthy(), NOW).rows.map((c) => c.state)).toEqual(["ok", "ok", "ok"]);
  });

  test("Claude: 7日前からもうすぐ、過ぎたら切れた、未ログインも切れた", () => {
    const at = (d: number) => ({ ...healthy(), claude: { available: true, loggedIn: true, loginExpiresAt: new Date(NOW + d * DAY).toISOString() } });
    expect(state(at(8), "claude")!.state).toBe("ok");
    expect(state(at(6), "claude")!.state).toBe("soon");
    expect(state(at(-1), "claude")!.state).toBe("needs");
    expect(state({ ...healthy(), claude: { available: true, loggedIn: false } }, "claude")!.state).toBe("needs");
  });

  test("ログインし直せるのは Nous と OAuth の MCP だけ", () => {
    expect(state(healthy(), "nous")!.canLogin).toBe(true);
    expect(state(healthy(), "claude")!.canLogin).toBe(false);
    expect(state(healthy(), "mcp:default:vercel")!.canLogin).toBe(true);
    const plain: RawConnections = { claude: { available: false }, hermes: { mcp: { default: { ga: { oauth: false, token: { exists: false } } } } } };
    expect(state(plain, "mcp:default:ga")!.canLogin).toBe(false);
  });

  test("Claude を使わない環境では行を出さない", () => {
    expect(state({ ...healthy(), claude: { available: false } }, "claude")).toBeUndefined();
  });

  test("取れないときは切れた扱いにせず、理由を返す", () => {
    const r = connectionRows({ claude: { error: "bridge が止まっている" }, hermes: { error: "仲介の失敗" } }, NOW);
    expect(r.rows.map((c) => c.state)).toEqual(["unknown"]);
    expect(r.errors).toHaveLength(2);
  });

  test("Nous: ログインが無ければ切れた、理由も出す", () => {
    const raw = healthy();
    (raw.hermes as { nous: unknown }).nous = { logged_in: false, error: "invalid_grant" };
    expect(state(raw, "nous")).toMatchObject({ state: "needs", reason: "invalid_grant" });
  });

  const mcp = (s: object): RawConnections => ({ claude: { available: false }, hermes: { mcp: { default: { x: s } } } });
  test("MCP: アクセストークンの期限切れだけでは切れた扱いにしない", () => {
    const token = { exists: true, refresh: true, updated_at: sec(NOW - 2 * 3_600_000), expires_at: sec(NOW - 3_600_000) };
    expect(state(mcp({ oauth: true, token }), "mcp:default:x")!.state).toBe("ok");
  });

  test("MCP: 更新の失敗が最後の更新より新しければ切れた。古い失敗は無視する", () => {
    const token = { exists: true, refresh: true, updated_at: sec(NOW - 3_600_000), expires_at: sec(NOW + 3_600_000) };
    expect(state(mcp({ oauth: true, token, log_error: { at: sec(NOW - 60_000), reason: "invalid_grant" } }), "mcp:default:x")!.state).toBe("needs");
    expect(state(mcp({ oauth: true, token, log_error: { at: sec(NOW - 2 * 3_600_000), reason: "invalid_grant" } }), "mcp:default:x")!.state).toBe("ok");
  });

  test("MCP: 無効・ログイン不要・未ログイン・更新手段なし・長く止まっている", () => {
    expect(state(mcp({ enabled: false, oauth: true, token: { exists: false } }), "mcp:default:x")!.state).toBe("off");
    expect(state(mcp({ oauth: false, token: { exists: false } }), "mcp:default:x")).toMatchObject({ state: "ok", reason: "ログイン不要" });
    expect(state(mcp({ oauth: true, token: { exists: false } }), "mcp:default:x")!.state).toBe("needs");
    expect(state(mcp({ oauth: true, token: { exists: true, refresh: false, expires_at: sec(NOW - 1000) } }), "mcp:default:x")!.state).toBe("needs");
    expect(state(mcp({ oauth: true, token: { exists: true, refresh: true, expires_at: sec(NOW - 2 * DAY) } }), "mcp:default:x")!.state).toBe("unknown");
  });
});

describe("接続の通知", () => {
  const watch = (start: RawConnections) => {
    let raw = start;
    const sent: string[] = [];
    const w = new ConnectionWatch(new Database(":memory:"), async () => raw, (n) => sent.push(n.title));
    return { w, sent, set: (r: RawConnections) => (raw = r) };
  };
  const nousDown = (): RawConnections => {
    const r = healthy();
    (r.hermes as { nous: unknown }).nous = { logged_in: false, error: "invalid_grant" };
    return r;
  };

  test("最初が正常なら知らせない。切れたら1回、直ったら1回", async () => {
    const { w, sent, set } = watch(healthy());
    await w.check(NOW);
    expect(sent).toEqual([]);
    set(nousDown());
    await w.check(NOW + 1);
    await w.check(NOW + 2);
    expect(sent).toEqual(["Nous の接続が切れた"]);
    set(healthy());
    await w.check(NOW + 3);
    expect(sent).toEqual(["Nous の接続が切れた", "Nous がつながった"]);
    const v = await w.check(NOW + 4);
    expect(v.events.map((e) => e.toState)).toEqual(["ok", "needs"]);
  });

  test("最初から切れていれば知らせる", async () => {
    const { w, sent } = watch(nousDown());
    await w.check(NOW);
    expect(sent).toEqual(["Nous の接続が切れた"]);
  });

  test("期限が近いのは1回だけ。日数を出す", async () => {
    const soon = healthy();
    (soon.claude as { loginExpiresAt: string }).loginExpiresAt = new Date(NOW + 6 * DAY).toISOString();
    const notices: string[] = [];
    const w = new ConnectionWatch(new Database(":memory:"), async () => soon, (n) => notices.push(n.message));
    await w.check(NOW);
    await w.check(NOW + 1000);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("あと6日");
  });

  test("取れない間は状態を変えず、誤報を出さない", async () => {
    const { w, sent, set } = watch(nousDown());
    await w.check(NOW);
    set({ claude: { error: "x" }, hermes: { error: "y" } });
    await w.check(NOW + 1);
    set(nousDown());
    await w.check(NOW + 2);
    expect(sent).toEqual(["Nous の接続が切れた"]);
  });

  test("短い間は取り直さない。force なら取り直す", async () => {
    let calls = 0;
    const w = new ConnectionWatch(new Database(":memory:"), async () => (calls++, healthy()), () => {});
    await w.view(false, NOW);
    await w.view(false, NOW + 1000);
    expect(calls).toBe(1);
    await w.view(true, NOW + 2000);
    expect(calls).toBe(2);
  });
});

describe("つなぎ直しの結果", () => {
  test("ログイン先とコードを読む。失敗の理由も伝える", () => {
    expect(loginResult('戻り先を設定した\nPLASMOD_RESULT {"ok":true,"url":"https://x","code":"AB"}\n')).toEqual({ url: "https://x", code: "AB" });
    expect(loginResult('PLASMOD_RESULT {"ok":true,"url":"https://x"}')).toEqual({ url: "https://x", code: null });
    expect(() => loginResult('PLASMOD_RESULT {"ok":false,"error":"ダッシュボードが断った"}')).toThrow("ダッシュボードが断った");
    expect(() => loginResult("Traceback")).toThrow("取得できなかった");
  });
});

describe("ダッシュボードの住所", () => {
  test("Tailscale の入口からだけ出す。プロファイルを渡す", () => {
    expect(dashboardUrl("vps.example.ts.net")).toBe("https://vps.example.ts.net/");
    expect(dashboardUrl("vps.example.ts.net", "default")).toBe("https://vps.example.ts.net/");
    expect(dashboardUrl("vps.example.ts.net", "acct")).toBe("https://vps.example.ts.net/?profile=acct");
    expect(dashboardUrl("localhost")).toBeNull();
  });
});
