import { describe, expect, test } from "bun:test";
import { hideCard, withoutHidden } from "../src/web/api";
import type { Card, Snapshot } from "../src/shared/types";

const card = (key: string) => ({ key, kind: "review", createdAt: 1 }) as Card;
const snap = (keys: string[], snoozed: string[] = []) => ({ cards: keys.map(card), snoozed: snoozed.map(card), agents: [], board: null, bridgeConnected: true }) as unknown as Snapshot;

describe("判断したカードをすぐ畳む", () => {
  test("畳んだカードは、サーバーの一覧に残っていても出さない", () => {
    hideCard("task:a");
    expect(withoutHidden(snap(["task:a", "task:b"])).cards.map((c) => c.key)).toEqual(["task:b"]);
  });

  test("サーバーの一覧から消えたら忘れる（あとで同じ key が出てきたら、また出す）", () => {
    hideCard("task:c");
    withoutHidden(snap(["task:b"]));
    expect(withoutHidden(snap(["task:c"])).cards.map((c) => c.key)).toEqual(["task:c"]);
  });

  test("10分たったら忘れる", () => {
    hideCard("task:d");
    expect(withoutHidden(snap(["task:d"]), Date.now() + 11 * 60_000).cards.map((c) => c.key)).toEqual(["task:d"]);
  });
});
