import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Handler = (e: Record<string, unknown>) => void;

/** service worker のコードを、偽の self の上で動かす */
function loadSw(clients: { url: string; focus: () => Promise<void>; navigate: (u: string) => Promise<void> }[] = []) {
  const on: Record<string, Handler> = {};
  const shown: { title: string; opts: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (k: string, f: Handler) => void (on[k] = f),
    location: { origin: "https://me.ts.net:8443" },
    registration: { showNotification: async (title: string, opts: Record<string, unknown>) => void shown.push({ title, opts }) },
    clients: { matchAll: async () => clients, openWindow: async (u: string) => void opened.push(u) },
  };
  new Function("self", readFileSync(join(import.meta.dir, "../public/sw.js"), "utf8"))(self);
  return { on, shown, opened };
}
const run = async (h: Handler, e: Record<string, unknown>) => {
  let done: Promise<unknown> = Promise.resolve();
  h({ ...e, waitUntil: (p: Promise<unknown>) => void (done = p) });
  await done;
};
const pushOf = (v: unknown) => ({ data: { json: () => v, text: () => String(v) } });

describe("service worker の通知", () => {
  test("届いたら通知を出す", async () => {
    const s = loadSw();
    await run(s.on.push, pushOf({ title: "題", body: "本文", path: "#/todos", tag: "k", urgent: true }));
    expect(s.shown[0].title).toBe("題");
    expect(s.shown[0].opts).toMatchObject({ body: "本文", tag: "k", renotify: true, requireInteraction: true, data: { path: "#/todos" } });
  });

  test("中身が壊れていても、通知は必ず出す（iOS は出さないと権限を失う）", async () => {
    const s = loadSw();
    await run(s.on.push, { data: { json: () => { throw new Error("x"); }, text: () => "ただの文字" } });
    await run(s.on.push, {});
    expect(s.shown.map((x) => [x.title, x.opts.body])).toEqual([["Plasmod", "ただの文字"], ["Plasmod", ""]]);
  });

  test("押すと開いている画面をその行き先へ。無ければ新しく開く。外の住所へは行かない", async () => {
    const seen: string[] = [];
    const c = { url: "https://me.ts.net:8443/#/", focus: async () => {}, navigate: async (u: string) => void seen.push(u) };
    const a = loadSw([c]);
    const click = (path: string) => ({ notification: { close() {}, data: { path } } });
    await run(a.on.notificationclick, click("#/card/x"));
    expect(seen).toEqual(["https://me.ts.net:8443/#/card/x"]);
    const b = loadSw();
    await run(b.on.notificationclick, click("#/todos"));
    expect(b.opened).toEqual(["https://me.ts.net:8443/#/todos"]);
    const d = loadSw();
    await run(d.on.notificationclick, click("https://evil.example/"));
    expect(d.opened).toEqual(["https://me.ts.net:8443/"]);
  });
});
