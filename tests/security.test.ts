import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sameOriginWrites, SECURITY_HEADERS } from "../src/server/auth";

function app() {
  const a = new Hono();
  a.use("*", sameOriginWrites());
  a.get("/api/x", (c) => c.text("ok"));
  a.post("/api/x", (c) => c.text("ok"));
  a.post("/notify-relay", (c) => c.text("ok"));
  return a;
}
const post = (h: Record<string, string>, path = "/api/x") => app().request(path, { method: "POST", headers: { Host: "me.ts.net:8443", ...h } });

describe("別のサイトからの書き込み", () => {
  test("別のサイトは断る", async () => {
    expect((await post({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post({ "Sec-Fetch-Site": "same-site" })).status).toBe(403);
    expect((await post({ Origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ Origin: "https://me.ts.net:9999" })).status).toBe(403);
    expect((await post({ Origin: "null" })).status).toBe(403);
    expect((await post({ "Sec-Fetch-Site": "same-origin", Origin: "https://evil.example" })).status).toBe(403);
  });

  test("同じサイト・アプリの通知のボタン・共有メニューは通す", async () => {
    expect((await post({ "Sec-Fetch-Site": "same-origin", Origin: "https://me.ts.net:8443" })).status).toBe(200);
    expect((await post({})).status).toBe(200); // Android のボタン（ヘッダーなし）
    expect((await post({ "Sec-Fetch-Site": "none" })).status).toBe(200);
  });

  test("tailscale serve 経由（Host は localhost、元の住所は X-Forwarded-Host）", async () => {
    const viaServe = { Host: "localhost", "X-Forwarded-Host": "me.ts.net:8443", "Sec-Fetch-Site": "same-origin" };
    expect((await post({ ...viaServe, Origin: "https://me.ts.net:8443" })).status).toBe(200);
    expect((await post({ ...viaServe, Origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ ...viaServe, Origin: "https://localhost" })).status).toBe(403);
  });

  test("読み取りと、トークンで守る受け口は対象外", async () => {
    expect((await app().request("/api/x", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(200);
    expect((await post({ "Sec-Fetch-Site": "cross-site" }, "/notify-relay")).status).toBe(200);
  });

  test("画面の守り: スクリプトは自分のものだけ・枠に入れない", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"];
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
