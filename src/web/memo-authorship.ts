// メモの「手書き」の判定。履歴（版ごとの本文と書いた人）をたどって、今の本文の1文字ずつが人の手で書かれたかを決める。
// 行ごとに比べ、変わった行は前後の同じ部分を残して、変わった真ん中だけを新しい書き手のものにする。

export interface AttrLine {
  text: string;
  /** 文字（UTF-16）ごとに 1 = 人が書いた */
  who: Uint8Array;
}

export type Attribution = AttrLine[];

const makeLine = (text: string, human: boolean): AttrLine => ({ text, who: new Uint8Array(text.length).fill(human ? 1 : 0) });

/** LCS が重くなりすぎるときは、変わった範囲をまとめて差し替える */
const MAX_CELLS = 4_000_000;

/** a と b の共通の行の組（a の番号, b の番号）を前から順に */
function commonLines(a: string[], b: string[]): [number, number][] {
  if (!a.length || !b.length || a.length * b.length > MAX_CELLS) return [];
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) out.push([i++, j++]);
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}

/** 書き換えられた1行: 前後の同じ部分は前の書き手のまま、真ん中だけ新しい書き手に */
function editLine(prev: AttrLine, text: string, human: boolean): AttrLine {
  const max = Math.min(prev.text.length, text.length);
  let head = 0;
  while (head < max && prev.text[head] === text[head]) head++;
  let tail = 0;
  while (tail < max - head && prev.text[prev.text.length - 1 - tail] === text[text.length - 1 - tail]) tail++;
  if (head + tail === 0) return makeLine(text, human);
  const who = new Uint8Array(text.length).fill(human ? 1 : 0);
  who.set(prev.who.subarray(0, head), 0);
  if (tail) who.set(prev.who.subarray(prev.text.length - tail), text.length - tail);
  return { text, who };
}

/** 前の版から次の本文へ。変わったところだけ、その版の書き手のものになる */
export function nextVersion(prev: Attribution, body: string, human: boolean): Attribution {
  const lines = body.split("\n");
  let head = 0;
  while (head < prev.length && head < lines.length && prev[head].text === lines[head]) head++;
  let tail = 0;
  while (tail < prev.length - head && tail < lines.length - head && prev[prev.length - 1 - tail].text === lines[lines.length - 1 - tail]) tail++;
  if (head === prev.length && head === lines.length) return prev;
  const oldMid = prev.slice(head, prev.length - tail);
  const newMid = lines.slice(head, lines.length - tail);
  const pairs = commonLines(oldMid.map((l) => l.text), newMid);
  const mid: AttrLine[] = [];
  let i = 0;
  let j = 0;
  // 一致した行のあいだの、消えた行と増えた行を順に組にする（組になった行は「書き換え」）
  const fill = (toI: number, toJ: number) => {
    while (j < toJ) {
      mid.push(i < toI ? editLine(oldMid[i++], newMid[j], human) : makeLine(newMid[j], human));
      j++;
    }
    i = toI;
  };
  for (const [a, b] of pairs) {
    fill(a, b);
    mid.push(oldMid[a]);
    i = a + 1;
    j = b + 1;
  }
  fill(oldMid.length, newMid.length);
  return [...prev.slice(0, head), ...mid, ...prev.slice(prev.length - tail)];
}

/** 履歴（古い順）から、最後の版の書き分けを作る */
export function attribute(versions: { body: string; human: boolean }[]): Attribution {
  let cur: Attribution = [];
  for (const v of versions) cur = nextVersion(cur, v.body, v.human);
  return cur;
}

/** 本文の中で人が書いた範囲（空白だけの部分と改行は含めない） */
export function humanRanges(attr: Attribution): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let offset = 0;
  for (const l of attr) {
    for (let s = 0; s < l.who.length; ) {
      if (!l.who[s]) {
        s++;
        continue;
      }
      let e = s;
      while (e < l.who.length && l.who[e]) e++;
      if (l.text.slice(s, e).trim()) out.push({ from: offset + s, to: offset + e });
      s = e;
    }
    offset += l.text.length + 1;
  }
  return out;
}
