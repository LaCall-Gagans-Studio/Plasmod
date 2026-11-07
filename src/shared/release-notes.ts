// リリースノート。設定の「このアプリについて」に出す。新しい版を上に足す。
export interface ReleaseNote {
  version: string;
  /** 版の名前 */
  name: string;
  /** YYYY-MM-DD。開発中は null */
  date: string | null;
  items: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "3.0",
    name: "SO ELECTRIC",
    date: null,
    items: [
      "チーム: エージェントのまとまりを自由に作れる。チャット、レポート、任せ先に反映",
      "ブラウザと iPhone への通知（Web Push）",
      "初回の案内と、はじめての準備の手順書",
      "持ち主のプロフィールカード。枠の中を生き物が這い回る",
      "チームと接続の設定画面の作り直し",
      "作者の環境に寄った決め打ちをなくした（タイムゾーン、エージェントの動かし方）",
      "PR ごとのテスト、秘密の検査、空のマシンへのセットアップの試験",
    ],
  },
  {
    version: "2.0",
    name: "さらなる高みへ",
    date: "2026-11-07",
    items: [
      "オープンソース（MIT）として公開",
      "電波が無くてもメモを読み書きできる",
      "音声メモと音声入力",
      "ルーティーン、期限順のタスク、上に詰めたプロジェクト画面",
      "レポートを実務の順に。設定を整理",
      "読み込みのアメーバ。触手が画面を埋めて切り替わる",
      "Discord をやめて、アプリだけで完結",
    ],
  },
  {
    version: "1.0",
    name: "Hello My WINGMAN",
    date: "2026-11-05",
    items: [
      "Android アプリ。通知のボタンでその場で返せる。ホーム画面のウィジェット",
      "入口を Tailscale だけに",
      "root 作業をアプリで承認",
    ],
  },
];

/** 今の版の名前（2.0.0 → さらなる高みへ） */
export const versionName = (version: string) => RELEASE_NOTES.find((n) => version.startsWith(`${n.version}.`) || version === n.version)?.name ?? "";

/** CHANGELOG.md の中身。元はこのファイルだけにする */
export function renderChangelog(): string {
  const body = RELEASE_NOTES.map((n) => `## ${n.version}「${n.name}」${n.date ? ` — ${n.date}` : "（開発中）"}\n\n${n.items.map((x) => `- ${x}`).join("\n")}`).join("\n\n");
  return `# 変更の記録\n\nアプリの設定 → 一般 → リリースノートと同じ内容です。元は \`src/shared/release-notes.ts\`（\`bun scripts/changelog.ts\` で作り直す）。\n\n${body}\n`;
}
