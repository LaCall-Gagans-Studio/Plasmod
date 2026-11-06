import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { tailscaleEnv } from "../src/server/auth";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { RootClient } from "../src/server/root";
import { Store } from "../src/server/store";
import { BridgeClient } from "../src/server/bridge";

const EMAIL = "owner@example.com";
const cfg = { ...config, allowedLogins: [EMAIL], devNoAuth: false, tailscaleSelfIps: ["100.64.0.1"] };
/** Tailscale の入口から来た、スマホの本人 */
const ME = { "Tailscale-User-Login": EMAIL, "X-Forwarded-For": "100.64.0.9" };
const RID = "20261020010203-abcdef";
const PW = "hunter2-very-secret";

let dir = "";
let srv: Server | null = null;
afterEach(() => {
  srv?.close();
  srv = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** 偽の plasmod-rootd（app.sock）。受け取った行を記録し、reply の返事を返す */
function fakeRootd(reply: (req: Record<string, unknown>) => Record<string, unknown>) {
  dir = mkdtempSync(join(tmpdir(), "rootd-test-"));
  const sock = join(dir, "app.sock");
  const seen: Record<string, unknown>[] = [];
  srv = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf.split("\n")[0]);
      seen.push(req);
      c.end(JSON.stringify(reply(req)) + "\n");
    });
  }).listen(sock);
  return { sock, seen };
}

async function appFor(sock: string) {
  const store = new Store(":memory:");
  const bridge = new BridgeClient("/nonexistent");
  const hub = new Hub(cfg, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, bridge, null);
  const raw = createApp(cfg, hub, store, ".", { rootd: new RootClient(sock, 2000) });
  // ふつうの道は Tailscale の入口（ソケット）から
  const app = { request: (path: string, init?: RequestInit) => raw.request(path, init, tailscaleEnv()) };
  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { app, raw, post };
}

const approvePath = `/api/root/requests/${RID}/approve`;
const body = { digest: "a".repeat(64), password: PW };

describe("root 作業の承認（アプリ側）", () => {
  test("本人でない・VPS 自身・TCP なら、承認の経路にも一覧にも届かない", async () => {
    const { sock, seen } = fakeRootd(() => ({ ok: true }));
    const { app, raw, post } = await appFor(sock);
    expect((await post(approvePath, {}, body)).status).toBe(403);
    expect((await post(approvePath, { ...ME, "Tailscale-User-Login": "other@example.com" }, body)).status).toBe(403);
    expect((await post(approvePath, { ...ME, "X-Forwarded-For": "100.64.0.1" }, body)).status).toBe(403); // VPS 自身（開発くん）
    expect((await raw.request(approvePath, { method: "POST", headers: { "Content-Type": "application/json", ...ME }, body: JSON.stringify(body) })).status).toBe(403); // TCP
    expect((await raw.request("/api/root/requests", { headers: ME })).status).toBe(403);
    expect((await app.request("/api/root/requests")).status).toBe(403);
    expect((await post(`/api/root/requests/${RID}/reject`, {}, {})).status).toBe(403);
    expect(seen).toEqual([]);
  });

  test("本人なら、digest・パスワード・承認者の email をそのまま plasmod-rootd に渡す", async () => {
    const { sock, seen } = fakeRootd(() => ({ ok: true, id: RID, status: "approved" }));
    const { post } = await appFor(sock);
    const r = await post(approvePath, ME, body);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(seen).toEqual([{ op: "approve", id: RID, digest: body.digest, password: PW, by: `${EMAIL}（Tailscale）` }]);
    // 返事にパスワードが含まれない
    expect(JSON.stringify(await r.json())).not.toContain(PW);
  });

  test("パスワード誤り=403、ロック=429、digest 不一致・済み=409、未設定=403", async () => {
    let reply: Record<string, unknown> = { ok: false, code: "bad_password", error: "パスワードが違う", remaining: 3 };
    const { sock } = fakeRootd(() => reply);
    const { post } = await appFor(sock);
    const h = ME;
    const status = async () => (await post(approvePath, h, body)).status;
    expect(await status()).toBe(403);
    reply = { ok: false, code: "locked", error: "ロック中", locked_until: 1 };
    expect(await status()).toBe(429);
    reply = { ok: false, code: "digest_mismatch", error: "x" };
    expect(await status()).toBe(409);
    reply = { ok: false, code: "not_pending", error: "x" };
    expect(await status()).toBe(409);
  });

  test("パスワードはログにも、エラー（plasmod-rootd が落ちているとき）にも出ない", async () => {
    const logged: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      const { post } = await appFor("/nonexistent/app.sock");
      const r = await post(approvePath, ME, body);
      expect(r.status).toBe(500);
      expect(JSON.stringify(await r.json())).not.toContain(PW);
    } finally {
      Object.assign(console, orig);
    }
    expect(logged.join("\n")).not.toContain(PW);
  });

  test("不正な ID・本文は plasmod-rootd に届かない", async () => {
    const { sock, seen } = fakeRootd(() => ({ ok: true }));
    const { post } = await appFor(sock);
    const h = ME;
    expect((await post(`/api/root/requests/..%2F..%2Fetc/approve`, h, body)).status).toBe(400);
    expect((await post(approvePath, h, { digest: "a" })).status).toBe(400);
    expect((await post(approvePath, h, { digest: "a", password: "" })).status).toBe(400);
    expect((await post(approvePath, h, { password: 5, digest: "a" })).status).toBe(400);
    expect(seen).toEqual([]);
  });

  test("オーナーのコマンド: 本人とパスワードが要る。コマンドとパスワードを plasmod-rootd の run に渡す", async () => {
    const { sock, seen } = fakeRootd((r) => (r.password === PW ? { ok: true, id: RID, status: "approved" } : { ok: false, code: "bad_password", error: "違う" }));
    const { post } = await appFor(sock);
    expect((await post("/api/root/run", {}, { command: "id", password: PW })).status).toBe(403);
    expect((await post("/api/root/run", ME, { password: PW })).status).toBe(400);
    expect((await post("/api/root/run", ME, { command: "id" })).status).toBe(400);
    expect(seen).toEqual([]);
    const r = await post("/api/root/run", ME, { command: "id", password: PW });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, id: RID });
    expect(seen).toEqual([{ op: "run", command: "id", password: PW, by: `${EMAIL}（Tailscale）` }]);
    expect((await post("/api/root/run", ME, { command: "id", password: "wrong" })).status).toBe(403);
  });

  test("元に戻す: パスワードと承認者を plasmod-rootd の undo に渡す。パスワードが無ければ届かない", async () => {
    const { sock, seen } = fakeRootd((r) => (r.password === PW ? { ok: true, id: "20261020010204-bbbbbb", status: "approved", preview: "戻す" } : { ok: false, code: "bad_password", error: "x" }));
    const { app, post } = await appFor(sock);
    const h = ME;
    const undo = `/api/root/requests/${RID}/undo`;
    expect((await post(undo, {}, { password: PW })).status).toBe(403);
    expect((await post(undo, h, {})).status).toBe(400);
    expect((await post(`/api/root/requests/..%2Fx/undo`, h, { password: PW })).status).toBe(400);
    expect(seen).toEqual([]);
    const r = await post(undo, h, { password: PW });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, id: "20261020010204-bbbbbb" });
    expect(seen).toEqual([{ op: "undo", id: RID, password: PW, by: `${EMAIL}（Tailscale）` }]);
    expect((await post(undo, h, { password: "wrong" })).status).toBe(403);
    void app;
  });

  test("一覧・詳細・却下の中継（却下はパスワード不要）", async () => {
    const { sock, seen } = fakeRootd((r) => ({ ok: true, op: r.op }));
    const { app, post } = await appFor(sock);
    const h = ME;
    expect((await app.request("/api/root/requests", { headers: h })).status).toBe(200);
    expect((await app.request(`/api/root/requests/${RID}`, { headers: h })).status).toBe(200);
    expect((await post(`/api/root/requests/${RID}/reject`, h, {})).status).toBe(200);
    expect(seen.map((s) => s.op)).toEqual(["list", "get", "reject"]);
    expect(seen[2]).toMatchObject({ id: RID, by: `${EMAIL}（Tailscale）` });
  });
});
