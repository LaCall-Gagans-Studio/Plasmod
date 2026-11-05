import { describe, expect, test } from "bun:test";
import { parseTerminal } from "../src/web/terminal";

const RULE = "─".repeat(200);

describe("ターミナルの表示", () => {
  test("罫線・空のプロンプト・操作ヒントを捨て、応答・ツール・状態に分ける", () => {
    const raw = [
      "╭──────────────────────────╮",
      "│ ✻ Welcome to Claude Code │",
      "╰──────────────────────────╯",
      "",
      "> PR を出して",
      "",
      "⏺ 了解。テストを流してから出すね。",
      "  2行目の続き",
      "",
      "⏺ Bash(bun test 2>&1 | tail -3)",
      "  ⎿  58 pass",
      "     0 fail",
      "",
      "⏺ Called thread, ran 1 shell command",
      "",
      "· Simmering… (1m 36s · ↓ 8.2k tokens)",
      "  ⎿  Tip: Use /btw to ask a quick side question",
      "",
      RULE,
      RULE,
      "❯",
      RULE,
      "  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt",
    ].join("\n");
    const b = parseTerminal(raw);
    expect(b).toEqual([
      { kind: "user", text: "PR を出して" },
      { kind: "assistant", text: "了解。テストを流してから出すね。\n2行目の続き" },
      { kind: "tool", title: "Bash(bun test 2>&1 | tail -3)", lines: ["58 pass", "0 fail"] },
      { kind: "tool", title: "Called thread, ran 1 shell command", lines: [] },
      { kind: "status", text: "Simmering… (1m 36s · ↓ 8.2k tokens)" },
    ]);
  });

  test("段落の空行は残し、3つ以上は詰める", () => {
    const b = parseTerminal("⏺ 一段落目\n\n\n\n  二段落目");
    expect(b).toEqual([{ kind: "assistant", text: "一段落目\n\n二段落目" }]);
  });

  test("作業中で、状態の行がまだ無いとき", () => {
    expect(parseTerminal("⏺ 調べてる\n  esc to interrupt").at(-1)).toEqual({ kind: "status", text: "作業中" });
  });

  test("新しい発言のあとは、前の状態を出さない", () => {
    const b = parseTerminal("✻ Thinking… (3s)\n> 次の話\n⏺ はい");
    expect(b.map((x) => x.kind)).toEqual(["user", "assistant"]);
  });
});

describe("本物の画面（Claude Code の表示）", () => {
  test("● の説明＋⎿ はツール、← は届いた発言、要約の行はツール、終わりの印は出さない", () => {
    const raw = [
      "● 結果をまとめたよ。",
      "  - 1つ目",
      "",
      "✻ Crunched for 1m 57s · done 12:42 AM",
      "",
      "← thread · オーナー: 実際のチャット欄で、横棒が多い",
      "",
      "  Read 1 file, called thread, ran 1 shell command",
      "",
      "● Write(src/web/terminal.ts)",
      "  ⎿  Wrote 79 lines to src/web/terminal.ts",
      "       1 // コメント",
      "     … +69 lines",
      "",
      "● Rendering parsed terminal blocks in session view",
      "  ⎿  $ bun test",
      "     ok",
      "",
      "✢ Osmosing… (1m 9s · ↓ 6.8k tokens)",
      "  ⎿  Tip: Use /btw to ask a quick side question",
      "─".repeat(120),
      "❯ ",
      "─".repeat(120),
      "  ⏵⏵ accept edits on (shift+tab to cycle) · ◉ canvas · esc to interrupt",
    ].join("\n");
    expect(parseTerminal(raw).map((b) => [b.kind, b.kind === "tool" ? b.title : b.text])).toEqual([
      ["assistant", "結果をまとめたよ。\n- 1つ目"],
      ["user", "オーナー: 実際のチャット欄で、横棒が多い"],
      ["tool", "Read 1 file, called thread, ran 1 shell command"],
      ["tool", "Write(src/web/terminal.ts)"],
      ["tool", "Rendering parsed terminal blocks in session view"],
      ["status", "Osmosing… (1m 9s · ↓ 6.8k tokens)"],
    ]);
  });
});

describe("届いた発言のあとの行", () => {
  test("← の発言に、作業中の行（Editing… や ⎿ $ …）を取り込まない。remote-control の行も出さない", () => {
    const raw = [
      "● /remote-control is active · Continue here, on your phone, or at",
      "  https://claude.ai/code/session_01K47FETxuicgM4J4vpEfj4a",
      "",
      "← thread · オーナー（アプリ）: 今後日本語で話してね。あと、上のエージェント選択のところで…",
      "  Editing ~/.claude/projects/-home-cc-work/memory/MEMORY.md",
      "  ⎿  $ cd ~/work/plasmod && git fetch -q origin",
      "",
      "✶ Vibing… (47s · ↓ 3.6k tokens)",
    ].join("\n");
    expect(parseTerminal(raw).map((b) => [b.kind, b.kind === "tool" ? `${b.title}|${b.lines.join("/")}` : b.text])).toEqual([
      ["user", "オーナー（アプリ）: 今後日本語で話してね。あと、上のエージェント選択のところで…"],
      ["tool", "Editing ~/.claude/projects/-home-cc-work/memory/MEMORY.md|$ cd ~/work/plasmod && git fetch -q origin"],
      ["status", "Vibing… (47s · ↓ 3.6k tokens)"],
    ]);
  });
});
