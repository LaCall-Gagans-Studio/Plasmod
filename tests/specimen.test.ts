import { describe, expect, test } from "bun:test";
import { cardSvg, fmtTokens, growth, H, makeCreature, step, W, wirePoints } from "../src/web/specimen";

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
    for (let i = 1; i < c.segs.length; i++) expect(Math.hypot(c.segs[i][0] - c.segs[i - 1][0], c.segs[i][1] - c.segs[i - 1][1])).toBeCloseTo(c.gap, 1);
    expect(wirePoints(c, c.wires[0], t).length).toBeGreaterThan(2);
  });

  test("カードの絵は、名前の記号を逃がす", () => {
    const svg = cardSvg({ specimen: "", name: `<b>&"`, title: "x", color: "#C8F25A", days: 3, joined: "2026/11/08" });
    expect(svg).toContain("&lt;b&gt;&amp;&quot;");
    expect(svg).not.toContain("<b>");
    expect(svg).not.toContain("foreignObject");
  });

  test("トークンが増えるほど育つ（節・肢・目・飾り）。同じ数なら同じ姿", () => {
    const small = makeCreature("はなこ", 0);
    const mid = makeCreature("はなこ", 30_000_000);
    const big = makeCreature("はなこ", 3_000_000_000);
    expect(mid.segs.length).toBeGreaterThan(small.segs.length);
    expect(big.segs.length).toBeGreaterThan(mid.segs.length);
    expect(big.segs.length).toBeLessThanOrEqual(26);
    expect(big.gap).toBeLessThan(small.gap); // 節が増えたら間を詰める
    expect(big.gap * big.segs.length).toBeLessThanOrEqual(300);
    const reach = (c: ReturnType<typeof makeCreature>) => c.wires.reduce((a, w) => a + w.lens.reduce((x, y) => x + y, 0), 0);
    expect(reach(big)).toBeGreaterThan(reach(mid));
    expect(reach(mid)).toBeGreaterThan(reach(small));
    expect(big.eyes.length).toBeGreaterThan(small.eyes.length);
    expect(big.info.flatMap((i) => i.organs).length).toBeGreaterThan(small.info.flatMap((i) => i.organs).length);
    expect(makeCreature("はなこ", 3_000_000_000).wires).toEqual(big.wires);
  });

  test("育っても、既にある肢の関節の形は変わらない（手前の関節は引き継がれる）", () => {
    const a = makeCreature("はなこ", 20_000_000);
    const b = makeCreature("はなこ", 400_000_000);
    const wa = a.wires.find((w) => w.seg === 2 && w.side === 1);
    const wb = b.wires.find((w) => w.seg === 2 && w.side === 1);
    if (wa && wb) {
      expect(wb.bends.slice(0, wa.bends.length)).toEqual(wa.bends);
      expect(wb.a0).toBe(wa.a0);
    }
  });

  test("育った姿でも、10分動いて枠の近くにいて、節の間隔が保たれる", () => {
    const c = makeCreature("はなこ", 5_000_000_000);
    let t = 0;
    for (let i = 0; i < 18000; i++) {
      t += 1 / 30;
      step(c, 1 / 30, t);
      expect(c.x).toBeGreaterThan(-20);
      expect(c.x).toBeLessThan(W + 20);
    }
    for (let i = 1; i < c.segs.length; i++) expect(Math.hypot(c.segs[i][0] - c.segs[i - 1][0], c.segs[i][1] - c.segs[i - 1][1])).toBeCloseTo(c.gap, 1);
  });

  test("育ち具合は単調で、トークンの表示は短くなる", () => {
    expect(growth(0)).toBe(0);
    expect(growth(1e9)).toBeGreaterThan(growth(1e6));
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1234)).toBe("1.23K");
    expect(fmtTokens(12_345_678)).toBe("12.3M");
    expect(fmtTokens(2_500_000_000)).toBe("2.50B");
  });

  test("カードの絵にトークンの総数が入る", () => {
    expect(cardSvg({ specimen: "", name: "x", title: "", color: "#C8F25A", days: 1, joined: "2026/11/08", tokens: 2_500_000_000 })).toContain("2.50B");
  });
});
