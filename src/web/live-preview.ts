// メモのエディタ（CodeMirror 6）。Obsidian のライブプレビューのように、カーソルがある行だけ Markdown の記号を見せ、
// ほかの行は見出し・太字・斜体・取り消し線・コード・リンク・箇条書き・チェック・引用・区切り線・表を整形して出す。
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Extension, Facet, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, placeholder, WidgetType } from "@codemirror/view";
import { lookupIssue } from "./badges";
import { parseBlocks } from "./markdown";

/** チェックの行（- [ ] …）をタスクにする関数（メモの画面が渡す）。作ったタスクの番号を返す */
const makeTaskFacet = Facet.define<((title: string) => Promise<string | null>) | null, ((title: string) => Promise<string | null>) | null>({
  combine: (v) => v.find((x) => !!x) ?? null,
});

const TASK_REF = /\[\[([A-Z][A-Z0-9]{1,9}-\d{1,6})\]\]/g;
const STATE_CLS: Record<string, string> = { completed: "is-done", canceled: "is-done", started: "is-doing" };

/** [[TASK-123]]: タスクの番号・題・状態のチップ。押すとタスクを開く */
class TaskRefWidget extends WidgetType {
  constructor(
    readonly ref: string,
    /** チェックの行など、題がもう書いてあるところでは番号と状態だけ */
    readonly compact = false,
  ) {
    super();
  }
  eq(o: TaskRefWidget) {
    return o.ref === this.ref && o.compact === this.compact;
  }
  toDOM() {
    const a = document.createElement("a");
    a.className = "cm-lp-taskref";
    a.textContent = this.ref;
    void lookupIssue(this.ref).then((i) => {
      if (!i) return a.classList.add("is-missing");
      a.href = i.url;
      a.title = `${i.title}（${i.state}）`;
      a.textContent = "";
      const id = document.createElement("span");
      id.className = "cm-lp-taskref-id";
      id.textContent = this.ref;
      a.append(id);
      if (!this.compact) {
        const t = document.createElement("span");
        t.textContent = ` ${i.title}`;
        a.append(t);
      }
      const cls = STATE_CLS[i.stateType];
      if (cls) a.classList.add(cls);
    });
    a.addEventListener("mousedown", (e) => {
      if (a.href) {
        e.preventDefault();
        location.hash = new URL(a.href).hash;
      }
    });
    return a;
  }
  ignoreEvent() {
    return true;
  }
}

/** チェックの行の右端の「タスクにする」 */
class TaskifyWidget extends WidgetType {
  constructor(
    readonly lineFrom: number,
    readonly title: string,
  ) {
    super();
  }
  eq(o: TaskifyWidget) {
    return o.lineFrom === this.lineFrom && o.title === this.title;
  }
  toDOM(view: EditorView) {
    const b = document.createElement("button");
    b.className = "cm-lp-taskify";
    b.textContent = "→ タスクにする";
    b.setAttribute("aria-label", `「${this.title}」をタスクにする`);
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const make = view.state.facet(makeTaskFacet);
      if (!make || b.disabled) return;
      b.disabled = true;
      b.textContent = "作っています…";
      void make(this.title).then((ref) => {
        if (!ref) {
          b.disabled = false;
          b.textContent = "→ タスクにする";
          return;
        }
        const line = view.state.doc.lineAt(Math.min(this.lineFrom, view.state.doc.length));
        view.dispatch({ changes: { from: line.to, insert: ` [[${ref}]]` } });
      });
    });
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

/** エディタにフォーカスがあるか。無いときは全部の行を整形して見せる */
const setFocus = StateEffect.define<boolean>();
const focused = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((x, e) => (e.is(setFocus) ? e.value : x), v),
});
const focusTracker = EditorView.focusChangeEffect.of((_state, f) => setFocus.of(f));

/** 選択（カーソル）が触れている行の番号 */
function activeLines(state: EditorState): Set<number> {
  const out = new Set<number>();
  if (!state.field(focused, false)) return out;
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return out;
}

class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }
  eq(o: BulletWidget) {
    return o.depth === this.depth;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-bullet";
    s.textContent = this.depth % 2 ? "◦" : "•";
    return s;
  }
}

class CheckWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }
  eq(o: CheckWidget) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = `cm-lp-check${this.checked ? " is-checked" : ""}`;
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    box.textContent = this.checked ? "✓" : "";
    // 押してもカーソルを動かさず（記号を出さず）に、[ ] と [x] を切り替える
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "cm-lp-hr";
    return hr;
  }
}

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
  ) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source && o.from === this.from;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-table";
    const b = parseBlocks(this.source).find((x) => x.type === "table");
    if (b && b.type === "table") {
      const t = document.createElement("table");
      const tr = t.createTHead().insertRow();
      for (const h of b.head) {
        const th = document.createElement("th");
        th.textContent = h.replace(/\*\*|`/g, "");
        tr.appendChild(th);
      }
      const body = t.createTBody();
      for (const r of b.rows) {
        const row = body.insertRow();
        for (const c of r) row.insertCell().textContent = c.replace(/\*\*|`/g, "");
      }
      wrap.appendChild(t);
    } else wrap.textContent = this.source;
    // 押すと表の先頭にカーソルを置く（表は Markdown のまま編集できる）
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(this.from) });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

const hide = Decoration.replace({});
const line = (cls: string) => Decoration.line({ class: cls });
const mark = (cls: string) => Decoration.mark({ class: cls });

function build(state: EditorState): DecorationSet {
  const tree = ensureSyntaxTree(state, state.doc.length, 300);
  if (!tree) return Decoration.none;
  const active = activeLines(state);
  const doc = state.doc;
  const lineOf = (pos: number) => doc.lineAt(pos).number;
  const isActive = (from: number, to: number) => {
    for (let n = lineOf(from); n <= lineOf(Math.max(from, to - 1)); n++) if (active.has(n)) return true;
    return false;
  };
  const deco: Range<Decoration>[] = [];
  const sel = state.selection.ranges;
  const touched = (from: number, to: number) => !!state.field(focused, false) && sel.some((r) => r.to >= from && r.from <= to);

  tree.iterate({
    enter: (n) => {
      const { from, to } = n;
      const name = n.name;
      const h = /^ATXHeading(\d)$/.exec(name);
      if (h) {
        deco.push(line(`cm-lp-h cm-lp-h${h[1]}`).range(doc.lineAt(from).from));
        return;
      }
      switch (name) {
        case "HeaderMark": {
          // 「## 」の記号と後ろの空白
          const end = Math.min(doc.lineAt(from).to, to + 1);
          if (!isActive(from, to) && n.node.parent?.name.startsWith("ATXHeading")) deco.push(hide.range(from, end));
          return;
        }
        case "StrongEmphasis":
          deco.push(mark("cm-lp-strong").range(from, to));
          return;
        case "Emphasis":
          deco.push(mark("cm-lp-em").range(from, to));
          return;
        case "Strikethrough":
          deco.push(mark("cm-lp-strike").range(from, to));
          return;
        case "InlineCode":
          deco.push(mark("cm-lp-code").range(from, to));
          return;
        case "EmphasisMark":
        case "StrikethroughMark":
          if (!isActive(from, to)) deco.push(hide.range(from, to));
          return;
        case "CodeMark":
          if (n.node.parent?.name === "InlineCode" && !isActive(from, to)) deco.push(hide.range(from, to));
          return;
        case "Link": {
          // [文字](URL): カーソルの無い行では文字だけを出す
          if (isActive(from, to)) {
            deco.push(mark("cm-lp-link-raw").range(from, to));
            return false;
          }
          const marks = n.node.getChildren("LinkMark");
          if (marks.length >= 2) {
            deco.push(hide.range(marks[0].from, marks[0].to));
            deco.push(mark("cm-lp-link").range(marks[0].to, marks[1].from));
            deco.push(hide.range(marks[1].from, to));
          }
          return false;
        }
        case "URL":
          if (n.node.parent?.name !== "Link") deco.push(mark("cm-lp-link").range(from, to));
          return;
        case "Blockquote":
          for (let p = from; p <= to; ) {
            const l = doc.lineAt(p);
            deco.push(line("cm-lp-quote").range(l.from));
            p = l.to + 1;
          }
          return;
        case "QuoteMark": {
          const end = Math.min(doc.lineAt(from).to, to + 1);
          if (!isActive(from, to)) deco.push(hide.range(from, end));
          return;
        }
        case "ListItem": {
          const lm = n.node.getChild("ListMark");
          if (!lm) return;
          const l = doc.lineAt(lm.from);
          const depth = Math.floor((lm.from - l.from) / 2);
          const task = n.node.getChild("Paragraph")?.getChild("Task") ?? n.node.getChild("Task");
          const tm = task?.getChild("TaskMarker");
          if (tm && lineOf(tm.from) === l.number) {
            const checked = /x/i.test(doc.sliceString(tm.from, tm.to));
            // チェックは、カーソルがあっても箱で出す（記号は箱の前の「- 」だけ隠す）
            deco.push(Decoration.replace({ widget: new CheckWidget(checked, tm.from) }).range(lm.from, tm.to));
            if (checked) deco.push(mark("cm-lp-done").range(tm.to, l.to));
            return;
          }
          const text = doc.sliceString(lm.from, lm.to);
          // 箇条書きの点は、カーソルが記号のすぐそばにあるときだけ「-」に戻す（行のほかの場所では点のまま）
          const nearMark = !!state.field(focused, false) && sel.some((r) => r.from <= lm.to + 1 && r.to >= lm.from);
          if (/^[-*+]$/.test(text) && !nearMark) deco.push(Decoration.replace({ widget: new BulletWidget(depth) }).range(lm.from, lm.to));
          else deco.push(mark("cm-lp-listmark").range(lm.from, lm.to));
          return;
        }
        case "HorizontalRule":
          if (!isActive(from, to)) deco.push(Decoration.replace({ widget: new RuleWidget() }).range(from, to));
          return;
        case "FencedCode": {
          const first = doc.lineAt(from).number;
          const last = doc.lineAt(to).number;
          const inside = isActive(from, to);
          for (let k = first; k <= last; k++) {
            const l = doc.line(k);
            const fence = k === first || k === last;
            deco.push(line(`cm-lp-codeblock${fence ? " cm-lp-fence" : ""}${fence && !inside ? " cm-lp-fence-quiet" : ""}`).range(l.from));
          }
          return false;
        }
        case "Table": {
          const a = doc.lineAt(from);
          const b = doc.lineAt(to);
          if (touched(a.from, b.to)) {
            for (let k = a.number; k <= b.number; k++) deco.push(line("cm-lp-table-raw").range(doc.line(k).from));
          } else deco.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(a.from, b.to), a.from), block: true }).range(a.from, b.to));
          return false;
        }
      }
    },
  });
  // [[TASK-123]]: カーソルの無い行ではチップにする
  const make = state.facet(makeTaskFacet);
  for (let n = 1; n <= doc.lines; n++) {
    const l = doc.line(n);
    if (!l.text.includes("[[") && !(make && /^\s*[-*+]\s+\[ \]\s+\S/.test(l.text))) continue;
    const isActive = active.has(n);
    let hasRef = false;
    for (const m of l.text.matchAll(TASK_REF)) {
      hasRef = true;
      const from = l.from + (m.index ?? 0);
      if (!isActive) deco.push(Decoration.replace({ widget: new TaskRefWidget(m[1], /^\s*[-*+]\s+\[[ xX]\]\s+/.test(l.text)) }).range(from, from + m[0].length));
      else deco.push(mark("cm-lp-taskref-raw").range(from, from + m[0].length));
    }
    // まだタスクにしていないチェックの行: カーソルがあるとき、右端に「タスクにする」
    const box = /^\s*[-*+]\s+\[ \]\s+(.+)$/.exec(l.text);
    if (make && box && !hasRef && isActive) deco.push(Decoration.widget({ widget: new TaskifyWidget(l.from, box[1].trim()), side: 1 }).range(l.to));
  }
  return Decoration.set(deco, true);
}

const livePreview = StateField.define<DecorationSet>({
  create: build,
  update: (v, tr) => (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setFocus)) ? build(tr.state) : v),
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.theme({
  "&": { fontSize: "15px", color: "var(--color-ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "1.75", overflow: "visible" },
  ".cm-content": { padding: "4px 0 40vh", caretColor: "var(--color-ink)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--color-ink)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--color-blue) 22%, transparent) !important" },
  ".cm-placeholder": { color: "var(--color-mute)" },
  ".cm-lp-h": { fontWeight: "700", color: "var(--color-ink)", letterSpacing: "-0.01em" },
  ".cm-lp-h1": { fontSize: "1.6em", lineHeight: "1.35", paddingTop: "0.5em" },
  ".cm-lp-h2": { fontSize: "1.35em", lineHeight: "1.4", paddingTop: "0.45em" },
  ".cm-lp-h3": { fontSize: "1.15em", paddingTop: "0.35em" },
  ".cm-lp-h4, .cm-lp-h5, .cm-lp-h6": { fontSize: "1em", paddingTop: "0.3em" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through", color: "var(--color-mute)" },
  ".cm-lp-code": { fontFamily: "var(--font-mono)", fontSize: "0.86em", backgroundColor: "var(--color-chip)", borderRadius: "4px", padding: "0.1em 0.3em" },
  ".cm-lp-link": { color: "var(--color-blue)", textDecoration: "underline", textDecorationColor: "color-mix(in srgb, var(--color-blue) 40%, transparent)", textUnderlineOffset: "3px" },
  ".cm-lp-link-raw": { color: "var(--color-mute)" },
  ".cm-lp-bullet": { display: "inline-block", width: "1em", color: "var(--color-mute)", textAlign: "center", fontWeight: "700" },
  ".cm-lp-listmark": { color: "var(--color-mute)" },
  ".cm-lp-check": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.05em",
    height: "1.05em",
    margin: "0 0.35em 0 0.05em",
    verticalAlign: "-0.15em",
    border: "1.5px solid var(--color-line-2)",
    borderRadius: "4px",
    fontSize: "0.8em",
    fontWeight: "700",
    cursor: "pointer",
    color: "var(--color-paper)",
  },
  ".cm-lp-check.is-checked": { backgroundColor: "var(--color-ink)", borderColor: "var(--color-ink)" },
  ".cm-lp-done": { color: "var(--color-mute)", textDecoration: "line-through" },
  ".cm-lp-quote": { borderLeft: "3px solid var(--color-line-2)", paddingLeft: "0.9em !important", color: "var(--color-ink-2)" },
  ".cm-lp-hr": { display: "inline-block", width: "100%", height: "1px", verticalAlign: "middle", backgroundColor: "var(--color-line-2)" },
  ".cm-lp-codeblock": { fontFamily: "var(--font-mono)", fontSize: "0.84em", backgroundColor: "var(--color-chip)", padding: "0 0.8em !important" },
  ".cm-lp-fence": { color: "var(--color-mute)" },
  ".cm-lp-fence-quiet": { fontSize: "0.7em", lineHeight: "1.6" },
  ".cm-lp-table-raw": { fontFamily: "var(--font-mono)", fontSize: "0.84em", color: "var(--color-ink-2)" },
  ".cm-lp-table": { margin: "0.4em 0", overflowX: "auto", cursor: "text" },
  ".cm-lp-table table": { borderCollapse: "collapse", fontSize: "0.88em", minWidth: "50%" },
  ".cm-lp-table th, .cm-lp-table td": { border: "1px solid var(--color-line)", padding: "0.3em 0.7em", textAlign: "left", verticalAlign: "top" },
  ".cm-lp-taskref": {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "0.15em",
    maxWidth: "100%",
    padding: "0 0.45em",
    borderRadius: "6px",
    backgroundColor: "var(--color-blue-soft)",
    color: "var(--color-blue)",
    textDecoration: "none",
    cursor: "pointer",
    fontSize: "0.92em",
  },
  ".cm-lp-taskref-id": { fontFamily: "var(--font-mono)", fontSize: "0.85em", opacity: "0.8", whiteSpace: "nowrap", flex: "none" },
  ".cm-lp-taskref.is-done": { backgroundColor: "var(--color-chip)", color: "var(--color-mute)", textDecoration: "line-through" },
  ".cm-lp-taskref.is-doing": { backgroundColor: "var(--color-lime-soft)", color: "var(--color-lime-ink)" },
  ".cm-lp-taskref.is-missing": { backgroundColor: "var(--color-orange-soft)", color: "var(--color-orange-ink)" },
  ".cm-lp-taskref-raw": { color: "var(--color-blue)" },
  ".cm-lp-taskify": {
    marginLeft: "0.6em",
    padding: "0 0.5em",
    border: "1px solid var(--color-line-2)",
    borderRadius: "999px",
    background: "var(--color-panel)",
    color: "var(--color-ink-2)",
    fontSize: "0.78em",
    cursor: "pointer",
  },
  ".cm-lp-table th": { backgroundColor: "var(--color-chip)", fontWeight: "700" },
});

/** 箇条書き・チェック・番号の続きで Enter したら、次の行に同じ記号を付ける（空の項目で Enter なら記号を消す） */
function continueList(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  if (!r.empty) return false;
  const l = state.doc.lineAt(r.head);
  const m = /^(\s*)([-*+]|(\d+)[.)])(\s+)(\[[ xX]\]\s+)?/.exec(l.text);
  if (!m || r.head < l.from + m[0].length) return false;
  if (l.text.slice(m[0].length).trim() === "") {
    view.dispatch({ changes: { from: l.from, to: l.to, insert: "" } });
    return true;
  }
  const next = m[3] ? `${Number(m[3]) + 1}${m[2].slice(-1)}` : m[2];
  const insert = `\n${m[1]}${next}${m[4]}${m[5] ? "[ ] " : ""}`;
  view.dispatch({ changes: { from: r.head, insert }, selection: { anchor: r.head + insert.length }, scrollIntoView: true });
  return true;
}

export function memoExtensions(onChange: (text: string) => void, hint: string, makeTask: ((title: string) => Promise<string | null>) | null = null): Extension[] {
  return [
    makeTaskFacet.of(makeTask),
    history(),
    keymap.of([{ key: "Enter", run: continueList }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    placeholder(hint),
    focused,
    focusTracker,
    livePreview,
    theme,
    EditorView.contentAttributes.of({ "aria-label": "本文", autocapitalize: "sentences", spellcheck: "false" }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(u.state.doc.toString());
    }),
  ];
}

/** カーソルの位置に文を入れる（音声入力） */
export function insertAtCursor(view: EditorView, text: string) {
  const r = view.state.selection.main;
  const before = view.state.doc.sliceString(Math.max(0, r.from - 1), r.from);
  const insert = before && !/\s/.test(before) ? ` ${text}` : text;
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: r.from + insert.length } });
  view.focus();
}

export { build as buildLivePreview, setFocus as focusEffect };
