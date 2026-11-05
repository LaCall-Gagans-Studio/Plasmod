import { describe, expect, test } from "bun:test";
import { currentToasts, dismissToast, toast } from "../src/web/touch";

describe("小さな知らせ", () => {
  test("出す・消す。同時に出すのは3つまで（古いものから消える）", () => {
    for (const t of currentToasts()) dismissToast(t.id);
    const ids = [toast("1"), toast("2"), toast("3"), toast("4", "error")];
    expect(currentToasts().map((t) => t.text)).toEqual(["2", "3", "4"]);
    expect(currentToasts().at(-1)!.tone).toBe("error");
    dismissToast(ids[2]);
    expect(currentToasts().map((t) => t.text)).toEqual(["2", "4"]);
    dismissToast(999_999); // 無いものは何もしない
    expect(currentToasts().length).toBe(2);
    for (const t of currentToasts()) dismissToast(t.id);
  });
});
