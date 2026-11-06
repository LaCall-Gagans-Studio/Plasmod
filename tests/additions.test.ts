import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ProfileRegistry } from "../src/server/profiles";
import { Store } from "../src/server/store";
import { inkOn } from "../src/web/AgentSquad";
import { buildLivePreview, memoExtensions, setAuthorship } from "../src/web/live-preview";
import { attribute, humanRanges, nextVersion } from "../src/web/memo-authorship";
import { holdSwipeDirection } from "../src/web/touch";
import { linePath, niceMax } from "../src/web/VpsChart";

const human = (doc: string, a: ReturnType<typeof attribute>) => humanRanges(a).map((r) => doc.slice(r.from, r.to));

describe("手書きの判定", () => {
  test("人が足した行だけ手書き。AI の行はそのまま", () => {
    const doc = "AI の見出し\n人の行\nAI の追記";
    const a = attribute([{ body: "AI の見出し", human: false }, { body: "AI の見出し\n人の行", human: true }, { body: doc, human: false }]);
    expect(human(doc, a)).toEqual(["人の行"]);
  });

  test("行の途中を直したら、直した部分だけ", () => {
    const doc = "宿は京都にする";
    expect(human(doc, attribute([{ body: "宿は奈良にする", human: false }, { body: doc, human: true }]))).toEqual(["京都"]);
  });

  test("行を動かさずに間へ差し込んでも、前の書き手は残る", () => {
    const doc = "人1\nAI\n人2";
    expect(human(doc, attribute([{ body: "人1\n人2", human: true }, { body: doc, human: false }]))).toEqual(["人1", "人2"]);
  });

  test("書き換えられて消えた手書きは残らない。空白は印を付けない", () => {
    const doc = "AI が全部書き直し";
    expect(human(doc, attribute([{ body: "人の文", human: true }, { body: doc, human: false }]))).toEqual([]);
    expect(humanRanges(attribute([{ body: "   ", human: true }]))).toEqual([]);
  });

  test("同じ本文の版（アーカイブ）は書き手を変えない", () => {
    const doc = "人の文";
    expect(human(doc, attribute([{ body: doc, human: true }, { body: doc, human: false }]))).toEqual([doc]);
  });

  test("範囲は本文の位置と合う（複数行）", () => {
    const a = nextVersion(attribute([{ body: "AI\n", human: false }]), "AI\n人", true);
    expect(humanRanges(a)).toEqual([{ from: 3, to: 4 }]);
  });
});

describe("エディタのハイライト", () => {
  const marks = (s: EditorState) => {
    const out: string[] = [];
    for (const src of s.facet(EditorView.decorations)) {
      const set = typeof src === "function" ? null : src;
      set?.between(0, s.doc.length, (from, to, d) => {
        if (d.spec.class === "cm-lp-human") out.push(s.doc.sliceString(from, to));
      });
    }
    return out;
  };
  test("渡すと手書きに印、入力は人の分として増え、null で消える", () => {
    let s = EditorState.create({ doc: "AI\n人", extensions: memoExtensions(() => {}, "") });
    s = s.update({ effects: setAuthorship.of(attribute([{ body: "AI", human: false }, { body: "AI\n人", human: true }])) }).state;
    expect(marks(s)).toEqual(["人"]);
    s = s.update({ changes: { from: s.doc.length, insert: "の手" } }).state;
    expect(marks(s)).toEqual(["人の手"]);
    s = s.update({ effects: setAuthorship.of(null) }).state;
    expect(marks(s)).toEqual([]);
    expect(buildLivePreview(s)).toBeDefined();
  });
});

describe("そのほかの部品", () => {
  test("長押しの引っ張り: 56px 以上で動く。右へ引くと前、左へ引くと次", () => {
    expect(holdSwipeDirection(56)).toBe(-1);
    expect(holdSwipeDirection(-56)).toBe(1);
    expect(holdSwipeDirection(55)).toBe(0);
    expect(holdSwipeDirection(0)).toBe(0);
  });

  test("グラフの線: 測れなかったところで切る", () => {
    expect(linePath([{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: null }, { x: 3, y: 4 }])).toEqual(["M0.0,1.0L1.0,2.0", "M3.0,4.0"]);
  });

  test("ネットの縦軸は切りのいい値", () => {
    expect(niceMax(0)).toBe(1024);
    expect(niceMax(1500)).toBe(2048);
    expect(niceMax(3 * 1024 * 1024)).toBe(5 * 1024 * 1024);
  });

  test("カードの文字の色: 明るい色に黒、暗い色に白", () => {
    expect(inkOn("#C8F25A")).toBe("#17171a");
    expect(inkOn("#17171a")).toBe("#ffffff");
    expect(inkOn("var(--x)")).toBe("#ffffff");
  });

  test("役割を変えられ、空にすると消える", () => {
    const db: Database = new Store(":memory:").db;
    const reg = new ProfileRegistry(db, [{ id: "a", name: "A", initial: "A", color: "#000000", role: "元" }], () => false);
    reg.setOverride("a", { role: "WINGMAN" });
    expect(reg.all()[0].role).toBe("WINGMAN");
    reg.setOverride("a", { role: "" });
    expect(reg.all()[0].role).toBeUndefined();
  });
});

describe("長押しメニューの部品", () => {
  test("プロジェクトとメモのメニューが読み込める", async () => {
    const m = await import("../src/web/pjmenus");
    expect(typeof m.openMemoMenu).toBe("function");
    expect(typeof m.openProjectMenu).toBe("function");
  });
});
