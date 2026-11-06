// 開発エージェントのセッション（tmux の Claude Code の画面）を、読みやすい塊に分ける。
//  - 罫線・入力欄の枠・空のプロンプト・下の操作ヒントは捨てる
//  - 「⏺ 文章」は開発エージェントの応答、「⏺ Bash(…)」などはツールの実行、「> 文章」はオーナーの発言
//  - 「✻ Thinking…」「· Simmering…」「Tip:」などは状態

export type TermBlock =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; title: string; lines: string[] }
  | { kind: "status"; text: string };

const RULE_RE = /^[\s─━═│┃║╭╮╰╯┌┐└┘├┤┬┴┼╌╍▔▁_\-–—]*$/;
const FOOTER_RE = /(accept edits on|shift\+tab to cycle|bypass permissions|plan mode on|\? for shortcuts|auto-accept|ctrl\+[a-z] to|⏵⏵|⇧⇥)/i;
const SPINNER_RE = /^[✻✶✳✢✽✺·*]\s+\S/;
const SUMMARY_RE = /^(Read|Called|Ran|Searched|Listed|Wrote|Updated|Edited|Fetched)\b.*\b(command|file|pattern|thread|tool|page|search)/;
// 実行中のツールの行（● が付かないことがある）
const ACTIVE_RE = /^(Editing|Reading|Writing|Running|Searching|Fetching|Updating|Creating|Listing|Calling)\b/;
const TOOL_RE = /^[A-Za-z_][\w.:-]*\(|^(Called|Read|Ran|Searched|Listed|Wrote|Updated|Edited)\b.*\b(command|file|files|pattern|thread|tool)s?\b/;
const MARK_RE = /^[⏺●◉]\s?/;

/** 枠の縦線（│ … │）を外す */
const unbox = (l: string) => l.replace(/^\s*[│┃║]\s?/, "").replace(/\s?[│┃║]\s*$/, "");

export function parseTerminal(raw: string): TermBlock[] {
  const blocks: TermBlock[] = [];
  let cur = null as TermBlock | null;
  const push = (b: TermBlock) => {
    blocks.push(b);
    cur = b;
  };
  let status: string | null = null;

  for (const rawLine of raw.replace(/\r/g, "").split("\n")) {
    const line = unbox(rawLine).replace(/\s+$/, "");
    const t = line.trim();
    if (!t || RULE_RE.test(t)) {
      const c0 = cur as TermBlock | null;
      if (c0?.kind === "assistant") c0.text += "\n";
      continue;
    }
    if (/^[❯>]$/.test(t)) continue; // 空のプロンプト
    if (FOOTER_RE.test(t) || /esc to interrupt\s*$/.test(t)) {
      if (/esc to interrupt/.test(t) && !status) status = "作業中";
      continue;
    }
    if (/welcome to claude code/i.test(t) || /^\/help for help|^cwd:/i.test(t)) continue;
    if (/^\/?remote-control is active|^Continue here, on your phone|^https:\/\/claude\.ai\/code\/session_/i.test(t.replace(MARK_RE, ""))) continue;

    if (SPINNER_RE.test(t)) {
      // 「✻ Crunched for 1m 57s」のような終わりの印は出さない。考え中・作業中だけ残す
      status = /…|\.\.\./.test(t) ? t.replace(/^[✻✶✳✢✽✺·*]\s+/, "") : null;
      cur = null;
      continue;
    }
    // チャンネル（アプリ）から届いた発言
    if (/^←\s/.test(t)) {
      push({ kind: "user", text: t.replace(/^←\s+\S+\s+·\s+/, "").replace(/^←\s+/, "") });
      cur = null; // 届いた発言は1行。次の行（作業中の表示など）を取り込まない
      status = null;
      continue;
    }
    if ((SUMMARY_RE.test(t) || ACTIVE_RE.test(t)) && !(cur && (cur as TermBlock).kind === "tool")) {
      push({ kind: "tool", title: t, lines: [] });
      continue;
    }
    if (/^(⎿\s*)?Tip:/.test(t)) {
      cur = null;
      continue;
    }
    if (/^[❯>]\s+\S/.test(t)) {
      push({ kind: "user", text: t.replace(/^[❯>]\s+/, "") });
      status = null;
      continue;
    }
    if (MARK_RE.test(t)) {
      const body = t.replace(MARK_RE, "");
      if (TOOL_RE.test(body)) push({ kind: "tool", title: body, lines: [] });
      else push({ kind: "assistant", text: body });
      status = null;
      continue;
    }
    // 続きの行
    let c = cur as TermBlock | null;
    // 「● 説明」の次が ⎿ なら、それはツールの実行（Bash の説明文など）
    if (c?.kind === "assistant" && /^⎿/.test(t) && !c.text.includes("\n")) {
      const tool: TermBlock = { kind: "tool", title: c.text, lines: [] };
      blocks[blocks.indexOf(c)] = tool;
      cur = c = tool;
    }
    if (c?.kind === "tool") c.lines.push(t.replace(/^⎿\s*/, ""));
    else if (c?.kind === "assistant") c.text += (c.text.endsWith("\n") || !c.text ? "" : "\n") + line.replace(/^ {2}/, "");
    else if (c?.kind === "user") {
      // 入力した発言の続き（複数行）だけを足す。ツールの行らしきものは別の塊にする
      if (/^⎿/.test(t)) {
        cur = null;
        const last = blocks.findLast((b) => b.kind === "tool");
        if (last && last.kind === "tool") last.lines.push(t.replace(/^⎿\s*/, ""));
      } else c.text += `\n${t}`;
    }
    else if (/^⎿/.test(t) && blocks.length) {
      const last = blocks[blocks.length - 1];
      if (last.kind === "tool") last.lines.push(t.replace(/^⎿\s*/, ""));
    } else push({ kind: "assistant", text: line.replace(/^ {2}/, "") });
  }
  for (const b of blocks) if (b.kind === "assistant") b.text = b.text.replace(/\n{3,}/g, "\n\n").trim();
  const out = blocks.filter((b) => b.kind !== "assistant" || b.text);
  if (status) out.push({ kind: "status", text: status });
  return out;
}
