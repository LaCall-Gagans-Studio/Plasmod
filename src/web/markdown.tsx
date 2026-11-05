// 返事の Markdown のうち、見出し・箇条書き・表（| で区切った行）・コードの囲み（```、コピーボタン付き）・
// 選択肢（```choices）を見た目にする。ほかは今までどおり文字のまま。
import { createContext, type ReactNode, useContext, useState } from "react";
import { haptic, writeClipboard } from "./touch";

export type ListItem = { text: string; depth: number; checked?: boolean };
export type Choice = { label: string; description?: string };

export type Block =
  | { type: "text"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "code"; lang: string; text: string }
  | { type: "choices"; multi: boolean; options: Choice[] }
  | { type: "table"; head: string[]; align: ("left" | "right" | "center")[]; rows: string[][] };

const HEADING = /^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|(\d{1,4})[.)])\s+(.*)$/;

/**
 * ```choices（複数選べるなら ```choices multi）の中身。1行1つ、「- ラベル — 説明」（説明は無くてよい）。
 * 区切りは「 — 」か「 -- 」
 */
export function parseChoices(body: string): Choice[] {
  const out: Choice[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*+]|\d{1,2}[.)])\s+/, "").trim();
    if (!line) continue;
    const [label, ...rest] = line.split(/\s+(?:—|--)\s+/);
    const description = rest.join(" — ").trim();
    if (label.trim() && !out.some((c) => c.label === label.trim())) out.push(description ? { label: label.trim(), description } : { label: label.trim() });
  }
  return out.slice(0, 8);
}

const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const alignOf = (c: string): "left" | "right" | "center" => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left");

export function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  let buf: string[] = [];
  const flush = () => {
    // 塊の間の空行は、余白（塊ごとの margin）に任せて落とす
    while (buf.length && !buf[0].trim()) buf.shift();
    while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
    if (buf.length) out.push({ type: "text", text: buf.join("\n") });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\S*)(?:\s+multi)?\s*$/);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) j++;
      if (j < lines.length) {
        flush();
        const body = lines.slice(i + 1, j).join("\n");
        const options = fence[1] === "choices" ? parseChoices(body) : [];
        if (options.length) out.push({ type: "choices", multi: /^\s*```choices\s+multi\s*$/.test(line), options });
        else out.push({ type: "code", lang: fence[1], text: body });
        i = j;
        continue;
      }
    }
    const h = line.match(HEADING);
    if (h) {
      flush();
      out.push({ type: "heading", level: h[1].length, text: h[2] });
      continue;
    }
    const first = line.match(ITEM);
    if (first) {
      flush();
      const ordered = !!first[3];
      const base = first[1].length;
      const items: ListItem[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const m = lines[j].match(ITEM);
        if (m && !!m[3] === ordered || (m && m[1].length > base)) {
          const box = m[4].match(/^\[([ xX])\]\s+(.*)$/);
          const item: ListItem = { text: box ? box[2] : m[4], depth: Math.min(3, Math.floor(Math.max(0, m[1].length - base) / 2)) };
          if (box) item.checked = box[1] !== " ";
          items.push(item);
        } else if (!m && /^\s{2,}\S/.test(lines[j]) && items.length) {
          // 字下げした続きの行は、前の項目の続き
          items[items.length - 1].text += `\n${lines[j].trim()}`;
        } else break;
      }
      out.push({ type: "list", ordered, start: ordered ? Number(first[3]) : 1, items });
      i = j - 1;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = splitRow(line);
      const seps = splitRow(lines[i + 1]);
      if (head.length >= 2 && seps.length === head.length) {
        flush();
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim() !== "" && lines[j].includes("|")) {
          const cells = splitRow(lines[j]);
          rows.push(head.map((_, k) => cells[k] ?? ""));
          j++;
        }
        out.push({ type: "table", head, align: seps.map(alignOf), rows });
        i = j - 1;
        continue;
      }
    }
    buf.push(line);
  }
  flush();
  return out;
}

export type LinkPart = { text: string; href?: string };

/** [名前](https://…) と、むき出しの http(s) の URL を取り出す。URL の後ろに続く句読点・閉じ括弧はリンクに含めない */
export function splitLinks(text: string): LinkPart[] {
  const out: LinkPart[] = [];
  const re = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[\x21-\x7e]+/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let href = m[2] ?? m[0];
    let label = m[1] ?? href;
    let end = m.index + m[0].length;
    if (!m[2]) {
      const trimmed = href.replace(/[.,;:!?'"\]>*]+$/, "");
      // 閉じ括弧は、URL の中に開き括弧が無いときだけ外す（Wikipedia の URL などは括弧を含む）
      href = !trimmed.includes("(") ? trimmed.replace(/\)+$/, "").replace(/[.,;:!?'"\]>*]+$/, "") : trimmed;
      label = href;
      end = m.index + href.length;
      re.lastIndex = end;
    }
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: label, href });
    last = end;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** 文字の中のリンクを、色を付けて押せるようにする（別のタブ・ブラウザで開く） */
export function Linkify({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((p, i) =>
        p.href ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className="break-all text-blue underline decoration-blue/40 underline-offset-2 hover:decoration-blue">
            {p.text}
          </a>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

/** **太字** と `コード` とリンクを見た目にする（ほかの記号はそのまま） */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).map((part, i) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
          <strong key={i} className="font-bold"><Linkify text={part.slice(2, -2)} /></strong>
        ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={i} className="rounded bg-chip px-1 font-mono text-[0.9em]">{part.slice(1, -1)}</code>
        ) : (
          <Linkify key={i} text={part} />
        ),
      )}
    </>
  );
}

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

/**
 * 選択肢（```choices）を押したときの送り先。チャットの画面だけが渡す。
 * active=false（もう次の発言がある・送信中）なら押せない。chosen は次に送った発言（押した選択肢に印を付ける）
 */
export const ChoiceContext = createContext<{ onChoose?: (text: string) => void; active: boolean; chosen?: string }>({ active: false });

function CodeBox({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-line bg-chip">
      <div className="flex items-center justify-between border-b border-line px-2.5 py-1 font-sans text-[10.5px] text-mute">
        <span>{lang || "コード"}</span>
        <button
          onClick={() => void writeClipboard(text).then((ok) => {
            haptic(ok ? "success" : "error");
            setCopied(ok);
            if (ok) setTimeout(() => setCopied(false), 1500);
          })}
          className="min-h-7 rounded px-2 text-[11px] text-ink-2 hover:text-ink"
          aria-label="コードをコピー"
        >
          {copied ? "コピーしました" : "コピー"}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto p-2.5 font-mono text-[11.5px] leading-snug text-ink-2">{text}</pre>
    </div>
  );
}

function Choices({ multi, options }: { multi: boolean; options: Choice[] }) {
  const { onChoose, active, chosen } = useContext(ChoiceContext);
  const [picked, setPicked] = useState<string[]>([]);
  const can = !!onChoose && active;
  const isChosen = (label: string) => !!chosen && (chosen === label || (multi && chosen.split("、").includes(label)));
  const click = (label: string) => {
    if (!can) return;
    if (!multi) return onChoose!(label);
    setPicked((x) => (x.includes(label) ? x.filter((v) => v !== label) : [...x, label]));
  };
  return (
    <div className="my-2 flex flex-col gap-1.5 font-sans" role="group" aria-label="選択肢">
      {options.map((o, i) => {
        const on = multi ? picked.includes(o.label) : false;
        return (
          <button
            key={o.label}
            onClick={() => click(o.label)}
            disabled={!can}
            aria-pressed={multi ? on : undefined}
            className={`flex min-h-11 w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left ${
              isChosen(o.label) ? "border-ink bg-ink text-paper" : on ? "border-ink bg-chip" : "border-line-2 bg-panel"
            } ${can ? "hover:border-ink" : "cursor-default"} ${!can && !isChosen(o.label) ? "opacity-60" : ""}`}
          >
            <span className={`mt-0.5 flex size-5 flex-none items-center justify-center ${multi ? "rounded-md" : "rounded-full"} border text-[11px] font-bold ${isChosen(o.label) ? "border-paper" : "border-line-2"}`}>
              {multi ? (on || isChosen(o.label) ? "✓" : "") : i + 1}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-[13.5px] font-bold leading-snug">{o.label}</span>
              {o.description && <span className={`text-[12px] leading-snug ${isChosen(o.label) ? "opacity-80" : "text-ink-2"}`}>{o.description}</span>}
            </span>
          </button>
        );
      })}
      {multi && can && (
        <button
          onClick={() => picked.length && onChoose!(options.filter((o) => picked.includes(o.label)).map((o) => o.label).join("、"))}
          disabled={!picked.length}
          className="min-h-10 self-start rounded-full bg-ink px-4 text-[12.5px] font-bold text-paper disabled:opacity-40"
        >
          選んだものを送る
        </button>
      )}
      {can && <span className="text-[11px] text-mute">ほかの答えは、下の入力欄から</span>}
    </div>
  );
}

const HEAD_CLS = ["", "text-[17px]", "text-[15.5px]", "text-[14.5px]", "text-[13.5px]"];

export function RichText({ text }: { text: string }): ReactNode {
  const blocks = parseBlocks(text);
  if (blocks.length === 1 && blocks[0].type === "text") return <span className="whitespace-pre-wrap"><Inline text={text} /></span>;
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text") return <div key={i} className="my-1 whitespace-pre-wrap first:mt-0 last:mb-0"><Inline text={b.text} /></div>;
        if (b.type === "heading")
          return <div key={i} role="heading" aria-level={b.level} className={`mb-1 mt-3 font-sans font-bold leading-snug text-ink first:mt-0 ${HEAD_CLS[b.level]}`}><Inline text={b.text} /></div>;
        if (b.type === "list") {
          const Tag = b.ordered ? "ol" : "ul";
          return (
            <Tag key={i} start={b.ordered ? b.start : undefined} className="my-1 flex list-none flex-col gap-0.5 p-0">
              {b.items.map((it, k) => (
                <li key={k} className="flex gap-2" style={{ paddingLeft: `${it.depth * 1.1}em` }}>
                  <span className="flex-none select-none text-mute" aria-hidden="true">
                    {it.checked !== undefined ? (it.checked ? "☑" : "☐") : b.ordered ? `${b.start + k}.` : it.depth ? "◦" : "•"}
                  </span>
                  <span className={`min-w-0 whitespace-pre-wrap ${it.checked ? "text-mute line-through" : ""}`}><Inline text={it.text} /></span>
                </li>
              ))}
            </Tag>
          );
        }
        if (b.type === "code") return <CodeBox key={i} lang={b.lang} text={b.text} />;
        if (b.type === "choices") return <Choices key={i} multi={b.multi} options={b.options} />;
        return (
          <div key={i} className="my-2 max-w-full overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-collapse font-sans text-[12px] leading-snug">
              <thead>
                <tr>
                  {b.head.map((h, k) => (
                    <th key={k} className={`whitespace-nowrap border-b border-line bg-chip px-2.5 py-1.5 font-bold ${ALIGN[b.align[k]]}`}><Inline text={h} /></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri} className={ri % 2 ? "bg-panel-2" : ""}>
                    {r.map((c, k) => (
                      <td key={k} className={`border-t border-line px-2.5 py-1.5 align-top ${ALIGN[b.align[k]]}`}><Inline text={c} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}
