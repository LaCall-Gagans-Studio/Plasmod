import { useEffect, useState } from "react";

// メモ・タスクで使う軽い部品（JSON を読む・フォルダとタグの印）。編集の部品（CodeMirror）を持ち込まないよう、別のファイルに分ける
export const json = async <T,>(res: Response): Promise<T> => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `HTTP ${res.status}`), { status: res.status });
  return body as T;
};

export const FolderIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" className="flex-none">
    <path d="M3 6.5A1.5 1.5 0 014.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0121 8.7v9.8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5z" />
  </svg>
);

/**
 * プロジェクト名 → 絵文字。設定の一覧から読み、端末にも覚えておく（つながらないときも前の絵文字を出す）。
 * 同じ画面で何度呼んでも、読み込みは1回だけ
 */
const EMOJI_KEY = "gh-pj-emoji";
let emojiCache: Record<string, string> | null = null;
let emojiLoad: Promise<Record<string, string>> | null = null;
function readEmojiCache(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(EMOJI_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
export function useProjectEmojis(): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>(() => emojiCache ?? readEmojiCache());
  useEffect(() => {
    emojiLoad ??= fetch("/api/projects-settings")
      .then((r) => json<{ projects: { name: string; emoji: string | null }[] }>(r))
      .then((x) => {
        const m: Record<string, string> = {};
        for (const p of x.projects) if (p.emoji) m[p.name] = p.emoji;
        emojiCache = m;
        try {
          localStorage.setItem(EMOJI_KEY, JSON.stringify(m));
        } catch {
          /* 覚えられないだけ */
        }
        return m;
      })
      .finally(() => setTimeout(() => (emojiLoad = null), 30_000));
    let live = true;
    emojiLoad.then((m) => live && setMap(m)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return map;
}

/** プロジェクトの印: 絵文字があればそれ、無ければフォルダ */
export const ProjectGlyph = ({ emoji, size = 14 }: { emoji?: string | null; size?: number }) =>
  emoji ? (
    <span aria-hidden="true" className="inline-flex flex-none items-center justify-center leading-none" style={{ width: size + 2, fontSize: size }}>
      {emoji}
    </span>
  ) : (
    <FolderIcon size={size} />
  );

export const TagIcon =({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" className="flex-none">
    <path d="M3 12V4.5A1.5 1.5 0 014.5 3H12l9 9-9 9z" />
    <circle cx="7.5" cy="7.5" r="1.3" />
  </svg>
);

/** プロパティ欄のタグ: Enter・読点・カンマ・空白で確定、× で外す */
