import { describe, expect, test } from "bun:test";
import { cardSvg, fmtTokens, growthOf, H, makeCreature, step, W, wirePoints } from "../src/web/specimen";

describe("カードの生き物", () => {
  test("同じ名前なら同じ形、違う名前なら違う形", () => {
    expect(makeCreature("はなこ").radii).toEqual(makeCreature("はなこ").radii);
    expect(makeCreature("はなこ").radii).not.toEqual(makeCreature("たろう").radii);
  });

  test("動き続けて、10分たっても枠の近くにいる（節は前の節についていく）", () => {
    const c = makeCreature("はなこ");
    const start = [c.x, c.y];
    let t = 0;
    for (let i = 0; i < 18000; i++) {
      t += 1 / 30;
      step(c, 1 / 30, t);
      expect(c.x).toBeGreaterThan(-20);
      expect(c.x).toBeLessThan(W + 20);
      expect(c.y).toBeGreaterThan(-20);
      expect(c.y).toBeLessThan(H + 20);
    }
    expect(Math.hypot(c.x - start[0], c.y - start[1])).toBeGreaterThan(0);
    for (let i = 1; i < c.segs.length; i++) expect(Math.hypot(c.segs[i][0] - c.segs[i - 1][0], c.segs[i][1] - c.segs[i - 1][1])).toBeCloseTo(18, 1);
    expect(wirePoints(c, c.wires[0], t).length).toBeGreaterThan(2);
  });

  test("カードの絵は、名前の記号を逃がす", () => {
    const svg = cardSvg({ specimen: "", name: `<b>&"`, title: "x", color: "#C8F25A", days: 3, joined: "2026/11/08" });
    expect(svg).toContain("&lt;b&gt;&amp;&quot;");
    expect(svg).not.toContain("<b>");
    expect(svg).not.toContain("foreignObject");
  });

  test("総トークン数が増えると、節も触手も増えて長くなる。同じ入力なら同じ形", () => {
    const sizes = [0, 1e4, 1e6, 1e8, 1e10].map((n) => {
      const c = makeCreature("はなこ", n);
      return { segs: c.segs.length, wires: c.wires.length, reach: c.wires.reduce((a, w) => a + w.lens.reduce((x, y) => x + y, 0), 0) };
    });
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i].wires).toBeGreaterThanOrEqual(sizes[i - 1].wires);
      expect(sizes[i].reach).toBeGreaterThan(sizes[i - 1].reach);
    }
    expect(sizes[4].segs).toBeLessThanOrEqual(30);
    expect(sizes[4].segs).toBeGreaterThan(sizes[0].segs);
    expect(makeCreature("はなこ", 5e7).wires).toEqual(makeCreature("はなこ", 5e7).wires);
    // 段階表ではない: 近い数字でも連続して変わる
    expect(growthOf(1e6)).toBeLessThan(growthOf(1.1e6));
    expect(growthOf(1e6)).toBeGreaterThan(growthOf(9e5));
    expect(makeCreature("はなこ", 0).radii).toEqual(makeCreature("はなこ", 1e9).radii);
  });

  test("育ちきっても、動いて枠の近くにいて、節の間が揃う", () => {
    const c = makeCreature("はなこ", 5e10);
    let t = 0;
    for (let i = 0; i < 9000; i++) {
      t += 1 / 30;
      step(c, 1 / 30, t);
      expect(c.x).toBeGreaterThan(-20);
      expect(c.x).toBeLessThan(W + 20);
      expect(c.y).toBeGreaterThan(-20);
      expect(c.y).toBeLessThan(H + 20);
    }
    for (let i = 1; i < c.segs.length; i++) expect(Math.hypot(c.segs[i][0] - c.segs[i - 1][0], c.segs[i][1] - c.segs[i - 1][1])).toBeCloseTo(c.gap, 1);
    for (const w of c.wires) for (const p of wirePoints(c, w, t)) expect(Number.isFinite(p[0] + p[1])).toBe(true);
  });

  test("カードに総トークン数が出る", () => {
    expect(fmtTokens(12_345_678)).toBe("12.3M");
    expect(cardSvg({ specimen: "", name: "a", title: "", color: "#C8F25A", days: 1, joined: "x", tokens: 12_345_678 })).toContain("12.3M");
  });
});
