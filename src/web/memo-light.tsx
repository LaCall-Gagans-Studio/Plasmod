// メモ・タスクで使う軽い部品（JSON を読む・フォルダとタグの印）。編集の部品（CodeMirror）を持ち込まないよう、別のファイルに分ける
export const json = async <T,>(res: Response): Promise<T> => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `HTTP ${res.status}`), { status: res.status });
  return body as T;
};

export const FolderIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <path d="M3 6.5A1.5 1.5 0 014.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0121 8.7v9.8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5z" />
  </svg>
);

export const TagIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <path d="M3 12V4.5A1.5 1.5 0 014.5 3H12l9 9-9 9z" />
    <circle cx="7.5" cy="7.5" r="1.3" />
  </svg>
);

/** プロパティ欄のタグ: Enter・読点・カンマ・空白で確定、× で外す */
