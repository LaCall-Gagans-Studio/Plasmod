import { describe, expect, test } from "bun:test";
import { cardSvg, H, makeCreature, step, W, wirePoints } from "../src/web/specimen";

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
});
