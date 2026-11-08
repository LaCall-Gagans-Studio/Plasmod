import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AllowlistError, cleanLogins, cleanModels, loginsScript, modelsScript } from "../src/server/allowlists";

const run = (script: string) => {
  const r = Bun.spawnSync(["bash", "-c", script]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
};

describe("許可リスト", () => {
  test("ログイン: 重複を除き、空・形の違うもの・自分を消すことは断る", () => {
    expect(cleanLogins([" a@example.com ", "a@example.com", "b@github"], "a@example.com")).toEqual(["a@example.com", "b@github"]);
    expect(() => cleanLogins([], "")).toThrow(AllowlistError);
    expect(() => cleanLogins(["b@x.com"], "a@x.com")).toThrow("消せない");
    for (const bad of ["no-at", "a@b,c@d", "a b@c", "$(id)@x", "a@b;rm"]) expect(() => cleanLogins([bad], "")).toThrow(AllowlistError);
  });

  test("モデル: 形を確かめ、余計な項目と制御文字は落とす", () => {
    expect(cleanModels({ default: [{ provider: "nous", model: "openai/gpt-6.1", label: "GPT\u0000 6.1", extra: 1 }] })).toEqual({ default: [{ provider: "nous", model: "openai/gpt-6.1", label: "GPT 6.1" }] });
    expect(() => cleanModels({ "../x": [] })).toThrow(AllowlistError);
    expect(() => cleanModels({ default: [{ provider: "a b", model: "m" }] })).toThrow(AllowlistError);
    expect(() => cleanModels({ default: [{ provider: "p", model: "$(rm -rf /)" }] })).toThrow(AllowlistError);
    expect(() => cleanModels([])).toThrow(AllowlistError);
  });

  test("ログインのスクリプトは、その1行だけを書き換え、権限を保つ", () => {
    const d = mkdtempSync(join(tmpdir(), "pl-allow-"));
    const env = join(d, "env");
    writeFileSync(env, "PLASMOD_PORT=8790\nPLASMOD_ALLOWED_LOGINS=old@x.com\nPLASMOD_NOTIFY_TOKEN=secret\n");
    chmodSync(env, 0o640);
    run(loginsScript(["a@x.com", "b@github"], env, false));
    expect(readFileSync(env, "utf8")).toBe("PLASMOD_PORT=8790\nPLASMOD_ALLOWED_LOGINS=a@x.com,b@github\nPLASMOD_NOTIFY_TOKEN=secret\n");
    expect(statSync(env).mode & 0o777).toBe(0o640);
  });

  test("モデルのスクリプトは JSON を書く", () => {
    const d = mkdtempSync(join(tmpdir(), "pl-allow-"));
    const f = join(d, "models.json");
    run(modelsScript({ default: [{ provider: "nous", model: "x/y" }] }, f));
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ default: [{ provider: "nous", model: "x/y" }] });
    // 渡さなかったプロファイルは残す
    run(modelsScript({ dev: [] }, f));
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ default: [{ provider: "nous", model: "x/y" }], dev: [] });
    expect(statSync(f).mode & 0o777).toBe(0o644);
  });
});
