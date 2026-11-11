import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AppSettings, generatedProfile, mergeProfiles, ProfileRegistry } from "../src/server/profiles";
import { avatarExt } from "../src/server/routes/agents";
import type { AgentProfile } from "../src/shared/types";

const P = (id: string, name = id): AgentProfile => ({ id, name, initial: name[0], color: "#111111" });

describe("エージェントの一覧", () => {
  test("設定が無くても、見つけたプロファイルが出る。同じ id は同じ色", () => {
    const l = mergeProfiles([], ["default", "acct"], [], false);
    expect(l.map((p) => [p.id, p.name])).toEqual([["default", "アシスタント"], ["acct", "acct"]]);
    expect(generatedProfile("acct").color).toBe(generatedProfile("acct").color);
  });

  test("設定の並びと名前が優先。設定に無いものは後ろに足す。重複しない", () => {
    const l = mergeProfiles([P("design", "デザインくん"), P("default", "ハブ")], ["default", "design", "new"], [], false);
    expect(l.map((p) => p.name)).toEqual(["デザインくん", "ハブ", "new"]);
  });

  test("開発エージェントは bridge があるときだけ", () => {
    expect(mergeProfiles([P("dev")], [], [], false)).toEqual([]);
    expect(mergeProfiles([P("dev")], [], [], true).map((p) => p.id)).toEqual(["dev"]);
  });

  test("bridge が無ければ、Hermes の dev プロファイルを Hermes のエージェントとして出す（#28）", () => {
    const dev = { ...P("dev", "開発"), runtime: "claude-code" as const };
    const l = mergeProfiles([P("default"), dev], ["default", "dev"], [], false);
    expect(l.map((p) => [p.id, p.name, p.runtime])).toEqual([["default", "default", undefined], ["dev", "dev", undefined]]);
    // bridge があれば Claude Code の dev が1つだけ
    expect(mergeProfiles([P("default"), dev], ["default", "dev"], [], true).map((p) => [p.id, p.runtime])).toEqual([["default", undefined], ["dev", "claude-code"]]);
  });

  test("上書き: 名前・頭文字・色・顔。空の名前は無視", () => {
    const [a] = mergeProfiles([P("default", "元")], [], [{ id: "default", name: "新しい", color: "#222222", avatar: "/x.png" }], false);
    expect(a).toMatchObject({ name: "新しい", initial: "新", color: "#222222", avatar: "/x.png" });
    expect(mergeProfiles([P("default", "元")], [], [{ id: "default", name: "  " }], false)[0].name).toBe("元");
  });

  test("再検出: 新しく見つかった id だけ返し、既存の設定は変えない。失敗したら一覧はそのまま・同時に走るのは1回だけ", async () => {
    const r = new ProfileRegistry(new Database(":memory:"), [P("default")], () => false);
    await expect(r.refresh()).rejects.toThrow("つながっていない");
    r.setDiscovered(["default", "acct"]);
    r.setOverride("acct", { name: "経理", team: "ops" });
    let ids = ["default", "acct", "new1"];
    let calls = 0;
    r.setRefresher(async () => {
      calls++;
      await Promise.resolve();
      r.setDiscovered(ids);
    });
    const [a, b] = await Promise.all([r.refresh(), r.refresh()]);
    expect(a).toEqual({ added: ["new1"] });
    expect(b).toBe(a);
    expect(calls).toBe(1);
    expect(r.all().find((p) => p.id === "acct")).toMatchObject({ name: "経理", team: "ops" });
    expect(await r.refresh()).toEqual({ added: [] });
    r.setRefresher(async () => {
      throw new Error("仲介が落ちている");
    });
    await expect(r.refresh()).rejects.toThrow("落ちている");
    expect(r.all().map((p) => p.id)).toEqual(["default", "acct", "new1"]);
    ids = [];
  });

  test("保存して、同じ配列の中身を入れ替える。隠したものは画面から消え、設定には残る", () => {
    const target = [P("default", "元")];
    const r = new ProfileRegistry(new Database(":memory:"), target, () => false);
    r.setDiscovered(["default", "acct"]);
    expect(target.map((p) => p.id)).toEqual(["default", "acct"]);
    r.setOverride("acct", { name: "経理", hidden: true });
    expect(target.map((p) => p.id)).toEqual(["default"]);
    expect(r.all().find((p) => p.id === "acct")).toMatchObject({ name: "経理", hidden: true });
    r.setOverride("acct", { hidden: false });
    expect(target.at(-1)!.name).toBe("経理");
    expect(() => r.setOverride("none", { name: "x" })).toThrow("無い");
  });

  test("呼び名の保存", () => {
    const s = new AppSettings(new Database(":memory:"));
    expect(s.get("owner")).toBeNull();
    s.set("owner", "山田");
    s.set("owner", "佐藤");
    expect(s.get("owner")).toBe("佐藤");
  });
});

describe("顔の画像", () => {
  const b = (...x: number[]) => new Uint8Array(x);
  test("中身の先頭で判定する。SVG や種類を偽ったものは断る", () => {
    expect(avatarExt(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("png");
    expect(avatarExt(b(0xff, 0xd8, 0xff, 0xe0))).toBe("jpg");
    expect(avatarExt(new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBe("webp");
    expect(avatarExt(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(avatarExt(b())).toBeNull();
  });
});
