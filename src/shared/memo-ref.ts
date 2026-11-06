// メモの番号。表記は MEMO-9（中身は memos.id）。本文に [[MEMO-9]] と書くと、そのメモへのつながりになる

/** 端末でまだ番号が付いていないメモ（id が負）には表記が無い */
export const memoRef = (id: number): string | null => (id > 0 ? `MEMO-${id}` : null);

/** MEMO-9 から 9 を取り出す。形が違えば null（MEMO-09 は本文の [[MEMO-9]] と一致しないので受けない） */
export function memoIdOf(ref: string): number | null {
  const m = /^MEMO-([1-9]\d{0,5})$/i.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

/** 本文の中でこのメモに触れている書き方（逆引きの検索語） */
export const memoLinkText = (id: number) => `[[MEMO-${id}]]`;
