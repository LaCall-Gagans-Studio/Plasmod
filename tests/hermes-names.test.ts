import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { HermesNameSync } from "../src/server/hermes-names";

/** 偽の仲介: Hermes 側の表示名を持ち、broker の set-display-name と同じ判定をする */
function fake(initial: Record<string, string> = {}) {
  const hermes = { ...initial };
  const calls: string[][] = [];
  let down = false;
  const call = async (...a: string[]) => {
    calls.push(a);
    if (down) throw new Error("仲介が落ちている");
    const [, id, raw] = a;
    const arg = JSON.parse(raw) as { name: string; expect?: string };
    const cur = hermes[id] ?? "";
    if (arg.expect !== undefined && cur !== arg.expect && cur !== arg.name) return JSON.stringify({ ok: false, conflict: true, current: cur });
    hermes[id] = arg.name;
    return JSON.stringify({ ok: true, current: arg.name });
  };
  return { hermes, calls, call, down: (v: boolean) => (down = v) };
}

describe("名前を Hermes に写す", () => {
  test("初めては Hermes 側が空なら書ける。2回目は前に書いた値を確かめる", async () => {
    const f = fake();
    const s = new HermesNameSync(new Database(":memory:"), f.call);
    expect(await s.sync("acct", "経理")).toMatchObject({ state: "synced", synced: "経理" });
    expect(f.hermes.acct).toBe("経理");
    expect(JSON.parse(f.calls[0][2])).toEqual({ name: "経理", expect: "" });
    await s.sync("acct", "経理部");
    expect(JSON.parse(f.calls[1][2])).toEqual({ name: "経理部", expect: "経理" });
    expect(f.hermes.acct).toBe("経理部");
  });

  test("Hermes 側で別に直されていたら上書きせず競合。本人が選べば上書きできる", async () => {
    const f = fake({ acct: "Hermes で付けた名前" });
    const s = new HermesNameSync(new Database(":memory:"), f.call);
    const r = await s.sync("acct", "経理");
    expect(r).toMatchObject({ state: "conflict", current: "Hermes で付けた名前" });
    expect(f.hermes.acct).toBe("Hermes で付けた名前");
    expect(s.get("acct")?.state).toBe("conflict");
    expect(await s.sync("acct", "経理", true)).toMatchObject({ state: "synced", synced: "経理" });
    expect(f.hermes.acct).toBe("経理");
  });

  test("失敗しても例外にならず、最後に書けた値を残す。直ったら再試行で書ける", async () => {
    const f = fake();
    const s = new HermesNameSync(new Database(":memory:"), f.call);
    await s.sync("acct", "経理");
    f.down(true);
    const r = await s.sync("acct", "経理部");
    expect(r).toMatchObject({ state: "failed", synced: "経理", error: "仲介が落ちている" });
    f.down(false);
    expect(await s.sync("acct", "経理部")).toMatchObject({ state: "synced", synced: "経理部" });
  });

  test("仲介が無いとき（Hermes につながっていない）は失敗として残る", async () => {
    const s = new HermesNameSync(new Database(":memory:"), null);
    expect(await s.sync("acct", "x")).toMatchObject({ state: "failed" });
  });

  test("同じ id の書き込みは順番に走る", async () => {
    const f = fake();
    const s = new HermesNameSync(new Database(":memory:"), f.call);
    const [a, b] = await Promise.all([s.sync("acct", "A"), s.sync("acct", "B")]);
    expect(a.state).toBe("synced");
    expect(b.state).toBe("synced");
    expect(f.hermes.acct).toBe("B");
    expect(JSON.parse(f.calls[1][2]).expect).toBe("A");
  });
});

describe("役割を Hermes のプロファイルの説明に写す", () => {
  test("kind=description は set-description を、description 引数で呼ぶ。別の表に結果を残す", async () => {
    const calls: string[][] = [];
    const db = new Database(":memory:");
    const call = async (...a: string[]) => {
      calls.push(a);
      return JSON.stringify({ ok: true, current: (JSON.parse(a[2]) as { description: string }).description });
    };
    const roles = new HermesNameSync(db, call, "description");
    const names = new HermesNameSync(db, call);
    expect(await roles.sync("acct", "経理担当")).toMatchObject({ state: "synced", synced: "経理担当" });
    expect(calls[0][0]).toBe("set-description");
    expect(JSON.parse(calls[0][2])).toEqual({ description: "経理担当", expect: "" });
    expect(roles.get("acct")?.synced).toBe("経理担当");
    expect(names.get("acct")).toBeUndefined();
  });

  test("Hermes 側に別の説明があれば上書きせず競合。force なら上書き", async () => {
    let cur = "Hermes で書いた説明";
    const call = async (...a: string[]) => {
      const arg = JSON.parse(a[2]) as { description: string; expect?: string };
      if (arg.expect !== undefined && cur !== arg.expect && cur !== arg.description) return JSON.stringify({ ok: false, conflict: true, current: cur });
      cur = arg.description;
      return JSON.stringify({ ok: true, current: cur });
    };
    const roles = new HermesNameSync(new Database(":memory:"), call, "description");
    expect(await roles.sync("acct", "経理")).toMatchObject({ state: "conflict", current: "Hermes で書いた説明" });
    expect(cur).toBe("Hermes で書いた説明");
    expect(await roles.sync("acct", "経理", true)).toMatchObject({ state: "synced" });
    expect(cur).toBe("経理");
  });

  test("この Hermes に説明を書く関数が無ければ、書かずに失敗として残す", async () => {
    const roles = new HermesNameSync(new Database(":memory:"), async () => JSON.stringify({ ok: false, unsupported: true }), "description");
    const r = await roles.sync("acct", "経理");
    expect(r.state).toBe("failed");
    expect(r.error).toContain("書く機能が見つからない");
  });
});
