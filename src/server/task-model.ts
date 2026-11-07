// タスクの型・状態・同じ元を見分ける処理・DB の行の読み方
import type { AppTask, AppTaskDoneReason, AppTaskEvent, AppTaskStatus, InboxKind } from "../shared/types";

export type TaskStatus = AppTaskStatus;

export type TaskDoneReason = AppTaskDoneReason;

export const TASK_STATUSES: TaskStatus[] = ["inbox", "todo", "doing", "done"];

/** 古い端末や plasmod-task が送ってくる状態名。受け取ったら Done（理由は不要）として扱う */
export const LEGACY_DISMISSED = "dismissed";

export const OPEN: TaskStatus[] = ["inbox", "todo", "doing"];

export type Task = AppTask;

export type TaskEvent = AppTaskEvent;

export class TaskError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export interface TaskInput {
  source: string;
  key: string;
  title: string;
  body?: string;
  kind?: string;
  url?: string | null;
  agent?: string | null;
  propose?: string[];
  project?: string | null;
  due?: string | null;
  /** 元の最後の動き（ms）。完了したタスクは、これが判断より後のときだけ開き直す */
  eventAt?: number | null;
  /**
   * 新しく作るときの状態（既定は BackLog）。BackLog に入れるのは、オーナーに決めてほしい問いだけ。
   * 計画の段・子は todo（オーナーがやる）か doing（エージェントがやる）で入れる。もうあるタスクの状態は変えない
   */
  status?: "inbox" | "todo" | "doing";
}

/**
 * カンバン・承認依頼・カードのメモのカードを、BackLog のタスクとして記録するための入力（2026-10-29「BackLog＝カード、例外なし」）。
 * source は kanban / perm / note、key はその元の ID
 */
export interface MirrorInput {
  cardKey: string;
  source: "kanban" | "perm" | "note";
  key: string;
  title: string;
  body: string;
  kind: InboxKind;
  /** カードを出した人（created_by に入れる） */
  agent: string;
  /** カードの時刻（ms）。判断より新しければ、閉じたタスクを BackLog に戻す */
  createdAt: number;
  url?: string | null;
  /** カンバンのカードなら、その番号。アプリのタスクから任せたカードなら、元のタスクを BackLog に戻す */
  kanbanId?: string;
  /** 開き直したときに記録に残す文 */
  reopenText: string;
}

/** 元が無くなって自動で閉じたときの記録の書き手 */
export const GONE = "auto";

export type UpsertResult = { action: "created" | "updated" | "unchanged" | "reopened" | "ignored"; reason?: string; task: Task };

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const STATUS_LABEL: Record<TaskStatus, string> = { inbox: "BackLog", todo: "Todo", doing: "AI-Driven", done: "Done" };

export const statusLabel = (status: TaskStatus, reason: TaskDoneReason | null) => (status === "done" && reason === "unneeded" ? "Done（不要）" : STATUS_LABEL[status]);

export const KINDS: Record<string, InboxKind> = { confirm: "confirm", ops: "confirm", reply: "reply", todo: "todo" };

export const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** キーを見回りが自分で考える元。メール・Beeper は元の ID なので揺れない */
export const LOOSE_KEY_SOURCES = new Set(["ops"]);

/** 「対象:問題」のキーを、先頭の部分（vercel・domain など）と残りの単語に分ける */
export function keyParts(key: string): [string, Set<string>] {
  const [head, ...rest] = key.toLowerCase().split(":");
  return [head, new Set(rest.join(" ").split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
}

/** 先頭が同じで、残りの単語が2つ以上かつ短い方の 3/4 以上重なれば同じ件 */
export function sameLooseKey(a: string, b: string): boolean {
  const [ha, ta] = keyParts(a);
  const [hb, tb] = keyParts(b);
  if (ha !== hb || !ta.size || !tb.size) return false;
  const shared = [...ta].filter((w) => tb.has(w)).length;
  return shared >= 2 && shared / Math.min(ta.size, tb.size) >= 0.75;
}

/**
 * 題名の近さ（キーが違っても同じ件か）。メールは見回りがメッセージ番号をキーにするので再送・催促のたびに、
 * Beeper は新着のたびに、同じ件がメールと ops の両方から、別のキーで来る（本番 2026-10-27: LIFF SDK が mail 1921・1924・ops で3件）。
 * 先頭の「AWS：」「acme:」などは外し、文字の2つ組の重なり（Dice）で比べる
 */
export function titleGrams(title: string): Set<string> {
  const t = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[^:：]{1,20}[:：]\s*/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  const g = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}

const asciiWords = (title: string) => new Set(title.normalize("NFKC").toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []);

/** 0.6 以上、または 0.45 以上で英字の語（liff・youtube など）を共有していれば同じ件。本番の DB で、別件どうしは 0.43 まで・同じ件は 0.53 から */
export function titleScore(a: string, b: string): number {
  const ga = titleGrams(a);
  const gb = titleGrams(b);
  if (ga.size < 8 || gb.size < 8) return 0; // 短すぎる題名は比べない
  const dice = (2 * [...ga].filter((x) => gb.has(x)).length) / (ga.size + gb.size);
  if (dice >= 0.6) return dice;
  const wb = asciiWords(b);
  return dice >= 0.45 && [...asciiWords(a)].some((w) => wb.has(w)) ? dice : 0;
}

/** 題名で同じ件を探す範囲 */
export const TITLE_WINDOW_MS = 30 * 86_400_000;

/** タグ（区切りは U+001F） */
export const TAGS = "(SELECT GROUP_CONCAT(tag, char(31)) FROM task_tags WHERE task_id = t.id) AS tags_concat";

/** 開いている子の数（一覧の「サブ n」） */
export const OPEN_CHILDREN = "(SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id AND c.status IN ('inbox','todo','doing')) AS open_children";

export interface Row {
  open_children?: number;
  tags_concat?: string | null;
  id: number;
  ref: string | null;
  parent_id: number | null;
  title: string;
  body: string;
  kind: InboxKind;
  status: TaskStatus;
  done_reason: TaskDoneReason | null;
  source: string;
  source_key: string | null;
  url: string | null;
  agent: string | null;
  propose: string;
  project: string | null;
  due: string | null;
  created_by: string;
  kanban_id: string | null;
  event_at: number | null;
  decided_at: number | null;
  inbox_at: number;
  created_at: number;
  updated_at: number;
}

export const toTask = (r: Row): Task => ({
  id: r.id,
  ref: r.ref ?? null,
  parentId: r.parent_id ?? null,
  tags: r.tags_concat ? r.tags_concat.split("\u001f") : [],
  ...(r.open_children ? { openChildren: r.open_children } : {}),
  title: r.title,
  body: r.body,
  kind: r.kind,
  status: r.status,
  doneReason: r.done_reason ?? null,
  source: r.source,
  sourceKey: r.source_key,
  url: r.url,
  agent: r.agent,
  propose: JSON.parse(r.propose) as Task["propose"],
  project: r.project,
  due: r.due,
  createdBy: r.created_by,
  kanbanId: r.kanban_id,
  eventAt: r.event_at,
  decidedAt: r.decided_at,
  inboxAt: r.inbox_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
