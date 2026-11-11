import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeDigest, VERSION_RE, walk } from "../scripts/build-release";

const tree = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "rel-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, ".."), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
};

describe("配布パッケージ", () => {
  test("版の形", () => {
    for (const v of ["3.0.0", "10.2.13"]) expect(VERSION_RE.test(v)).toBe(true);
    for (const v of ["3.0", "v3.0.0", "3.0.0-rc1", "../3.0.0", "3.0.0\n"]) expect(VERSION_RE.test(v)).toBe(false);
  });
  test("指紋は中身とパスで決まり、置き場所に左右されない", () => {
    const a = tree({ "broker/x": "1", "broker/sub/y": "2" });
    const b = tree({ "broker/x": "1", "broker/sub/y": "2" });
    const c = tree({ "broker/x": "1", "broker/sub/y": "3" });
    expect(treeDigest(a, ["broker"])).toBe(treeDigest(b, ["broker"]));
    expect(treeDigest(a, ["broker"])).not.toBe(treeDigest(c, ["broker"]));
    expect(walk(a)).toEqual(["broker/sub/y", "broker/x"]);
  });
});
