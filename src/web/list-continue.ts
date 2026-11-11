// 入力欄で Enter を押したときの Markdown リストの自動継続。
// 「- 」「* 」「+ 」「1. 」「1) 」で始まる行の Enter で次の項目を始め、空の項目で Enter するとリストを終える。
const ITEM = /^(\s*)([-*+]|(\d{1,9})([.)]))\s+/;

export type ListEdit = { value: string; caret: number };

/** Enter が押されたときの編集。リスト行でなければ null（ふつうの改行に任せる） */
export function continueList(value: string, start: number, end: number): ListEdit | null {
  if (start !== end) return null;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEndAt = value.indexOf("\n", start);
  const lineEnd = lineEndAt < 0 ? value.length : lineEndAt;
  const line = value.slice(lineStart, lineEnd);
  const m = ITEM.exec(line);
  // 印の途中（「- 」より左）にカーソルがあるときは何もしない
  if (!m || start - lineStart < m[0].length) return null;
  const rest = line.slice(m[0].length);
  if (!rest.trim()) {
    // 空の項目: 印を消してリストを終える
    return { value: value.slice(0, lineStart) + value.slice(lineEnd), caret: lineStart };
  }
  const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
  const insert = `\n${m[1]}${marker} `;
  return { value: value.slice(0, start) + insert + value.slice(start), caret: start + insert.length };
}
