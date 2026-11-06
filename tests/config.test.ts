import { expect, test } from "bun:test";
import { withDefaults } from "../src/server/config";
import { findProfile } from "../src/shared/types";

test("PLASMOD_PROFILES に役割が無くても、同じ id の既定を足す。書いた別名はそのまま", () => {
  const list = withDefaults([{ id: "default", name: "ハブ", initial: "ミ", color: "#000", aliases: ["hub1"] }, { id: "x", name: "X", initial: "X", color: "#111", aliases: ["y"] }]);
  expect(findProfile(list, "HUB1")?.name).toBe("ハブ");
  expect(list[0].role).toBe("WINGMAN");
  expect(list[1].aliases).toEqual(["y"]);
  expect(list[1].avatar).toBeUndefined();
});
