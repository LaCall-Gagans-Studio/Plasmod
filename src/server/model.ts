// カンバンと承認依頼から、トップのカードとウォッチングの図を組み立てる（純粋関数）。
import type {
  AgentNode, AgentProfile, Board, Card, CardOption, HermesApproval, InboxKind, KanbanTask, PermissionRequest, SnoozeKind,
} from "../shared/types";
import { findProfile, staleHours } from "../shared/types";
import type { MirrorInput, Task } from "./tasks";
import { config } from "./config";

// ボタンの言葉（2026-10-29）: 押すとタスクがどの状態に移るかで揃える。状態は 判断待ち・やる・任せ中・完了 の4つ。
// hint は「→ 移る先。起きること」の形
const LATER: CardOption = { id: "later", label: "あとで", tone: "quiet", hint: "Inbox のまま、しばらく伏せる" };
const DISMISS: CardOption = { id: "dismiss", label: "不要", tone: "quiet", hint: "→ Done（不要）。誰にも頼まない" };
const MINE: CardOption = { id: "mine", label: "自分でやる", tone: "default", hint: "→ Todo。自分のタスクに残す" };
const DONE: CardOption = { id: "ok", label: "完了", tone: "default", hint: "→ Done。見たので閉じる" };
// カンバンのカード（止まった・レビュー・仕分け）でも、どの種類にも「自分でやる」「不要」を出す。カンバンのカードはアーカイブする
const MINE_KANBAN: CardOption = { id: "mine", label: "自分でやる", tone: "default", hint: "→ Todo。カンバンのカードは片付ける" };
const DISMISS_KANBAN: CardOption = { id: "dismiss", label: "不要", tone: "quiet", hint: "→ Done（不要）。カンバンも片付け" };

export const OPTIONS = {
  blocked: [
    { id: "approve", label: "進めて", tone: "primary", hint: "→ AI-Driven。止まっていた作業を再開してもらう" },
    { id: "revise", label: "指示して進めて", tone: "default", needsText: true, hint: "→ AI-Driven。書いた指示を渡して再開してもらう" },
    MINE_KANBAN,
    LATER,
    DISMISS_KANBAN,
  ],
  review: [
    { id: "complete", label: "完了", tone: "primary", hint: "→ Done。カンバンのカードも完了にする" },
    { id: "changes", label: "やり直し", tone: "default", needsText: true, hint: "→ AI-Driven。書いた内容でやり直してもらう" },
    MINE_KANBAN,
    LATER,
    DISMISS_KANBAN,
  ],
  note: [
    { id: "done", label: "完了", tone: "primary", hint: "→ Done。メモを閉じる" },
    MINE,
    LATER,
  ],
  permission: [
    { id: "allow", label: "許可", tone: "primary", hint: "→ Done。この操作をさせる" },
    { id: "deny", label: "拒否", tone: "danger", hint: "→ Done。この操作はさせない" },
    LATER,
  ],
} satisfies Record<string, CardOption[]>;

export function profileOf(profiles: AgentProfile[], id: string | null | undefined): AgentProfile {
  const key = id || "unassigned";
  if (key === "me") return { id: "me", name: config.ownerName, initial: [...config.ownerName][0] ?? "?", color: "#E9E5DC" };
  const hit = findProfile(profiles, key);
  if (hit) return { ...hit, id: key };
  return profiles.find((p) => p.id === key) ?? { id: key, name: key, initial: key.slice(0, 1).toUpperCase(), color: "#D9D5CC" };
}

/** 止まっている理由。block のときは最新コメント（block の理由が入る）、無ければ本文 */
function taskBody(t: KanbanTask): string {
  const parts: string[] = [];
  if (t.latest_comment?.body) parts.push(t.latest_comment.body);
  else if (t.body) parts.push(t.body);
  return parts.join("\n\n").slice(0, 4000);
}

/**
 * 仕分け待ち（triage）の選択肢: 実働のエージェントごとに「〇〇に任せる」（今の担当を先頭に）・不要（アーカイブ）・あとで。
 * Hermes の「完了」は triage に効かないので、進める＝担当を決めて todo に戻す、不要＝アーカイブ
 */
export function triageOptions(t: KanbanTask, profiles: AgentProfile[]): CardOption[] {
  const work = profiles.filter((p) => (p.team ?? "work") === "work");
  const cur = t.assignee ? findProfile(profiles, t.assignee)?.id : undefined;
  const sorted = [...work].sort((a, b) => Number(b.id === cur) - Number(a.id === cur));
  return [
    ...sorted.map((p, i): CardOption => ({ id: `to-${p.id}`, label: `${p.name}に任せる`, tone: i === 0 ? "primary" : "default", hint: `→ AI-Driven。${p.name}を担当にして、カンバンを動かす` })),
    MINE_KANBAN,
    LATER,
    { id: "archive", label: "不要", tone: "quiet", hint: "→ Done（不要）。カンバンも片付け" },
  ];
}

export function taskCard(t: KanbanTask, profiles: AgentProfile[]): Card | null {
  if (t.status === "triage")
    return {
      key: `task:${t.id}`,
      kind: "triage",
      agent: t.created_by ? (findProfile(profiles, t.created_by)?.id ?? t.created_by) : profileOf(profiles, t.assignee).id,
      title: t.title,
      body: taskBody(t),
      statusLabel: "仕分け",
      createdAt: (t.latest_comment?.created_at ?? t.created_at) * 1000,
      options: triageOptions(t, profiles),
      taskId: t.id,
    };
  if (t.status !== "blocked" && t.status !== "review") return null;
  const blocked = t.status === "blocked";
  return {
    key: `task:${t.id}`,
    kind: blocked ? "blocked" : "review",
    agent: profileOf(profiles, t.assignee).id,
    title: t.title,
    body: taskBody(t),
    statusLabel: blocked ? "止まった" : "レビュー",
    createdAt: (t.latest_comment?.created_at ?? t.started_at ?? t.created_at) * 1000,
    options: blocked ? OPTIONS.blocked : OPTIONS.review,
    taskId: t.id,
  };
}

export function permissionCard(p: PermissionRequest): Card {
  return {
    key: `perm:${p.thread}:${p.request_id}`,
    kind: "permission",
    agent: "dev",
    title: `承認が必要: ${p.tool_name}`,
    body: [p.description, p.input_preview].filter(Boolean).join("\n\n").slice(0, 4000),
    statusLabel: "承認",
    createdAt: p.created_at,
    options: OPTIONS.permission,
    thread: p.thread,
    requestId: p.request_id,
  };
}

/** Hermes のエージェントの承認待ち。許可は「今回だけ」（ずっと許可は Hermes 側の設定で決める） */
export function hermesApprovalCard(a: HermesApproval): Card {
  return {
    key: `hperm:${a.id}`,
    kind: "permission",
    agent: a.agent,
    title: `承認が必要: ${a.description || "コマンドの実行"}`,
    body: a.command.slice(0, 4000),
    statusLabel: "承認",
    createdAt: a.createdAt,
    options: OPTIONS.permission,
    requestId: a.id,
  };
}

/** 伏せる期限。朝は JST の 8 時。morning＝次の朝、week＝次の月曜の朝 */
export function snoozeUntil(kind: SnoozeKind, now = Date.now()): number {
  if (kind === "3h") return now + 3 * 3_600_000;
  const JST = 9 * 3_600_000;
  const day = 86_400_000;
  const today8 = Math.floor((now + JST) / day) * day + 8 * 3_600_000 - JST; // 今日（JST）の 8 時
  if (kind === "morning") return today8 > now ? today8 : today8 + day;
  const weekday = new Date(now + JST).getUTCDay(); // 0=日
  const days = ((8 - weekday) % 7) || 7; // 次の月曜（今日が月曜なら来週）
  return today8 + days * day;
}

/** 受信箱: オーナー宛て（assignee）のカードは、実行者のいない「見てほしい」カード。判断待ちの blocked/review とは別に扱う */
export const INBOX_ASSIGNEES = ["owner", "me", ...config.ownerAssignees];
export const INBOX_KINDS: InboxKind[] = ["confirm", "reply", "todo"];
export const isInboxKind = (k: string): k is InboxKind => (INBOX_KINDS as string[]).includes(k);
export const isInboxTask = (t: KanbanTask): boolean => INBOX_ASSIGNEES.includes((t.assignee ?? "").toLowerCase());

/** カードの種類の札（短い名詞） */
const INBOX_LABEL: Record<InboxKind, string> = { confirm: "確認", reply: "返信", todo: "対応" };

export interface InboxMeta {
  kind: InboxKind;
  agent?: string;
  ref?: string;
  url?: string;
  /** 元の種類（mail / beeper / ops …）。beeper は見るだけなので返信の選択肢を出さない */
  source?: string;
  /** エージェントの提案: kanban（agent に起こす）/ task（タスクに残す） */
  propose: ("kanban" | "task")[];
  /** 見出し行を除いた本文 */
  text: string;
}

/**
 * 受信箱のカードの選択肢。エージェントの提案があれば先頭に出して強調する。
 * メールの返信は「下書きを頼む」（送るのは自分）。Beeper は見るだけなので返信の選択肢を出さない。
 */
export function inboxOptions(m: InboxMeta, delegateName: string): CardOption[] {
  // ボタンには誰に頼むかを書き、押すと何が起きるかを hint に添える
  const handle: CardOption = { id: "handle", label: `${delegateName}に任せる`, tone: "default", hint: `→ AI-Driven。${delegateName}がカンバンで作業する` };
  const proposals: CardOption[] = m.propose.map((p) =>
    p === "kanban" ? { ...handle, id: "kanban" } : { id: "task", label: "自分でやる", tone: "default", hint: "→ Todo。自分のタスクに残す" },
  );
  const base: CardOption[] =
    m.kind === "reply" && m.source !== "beeper"
      ? [
          { id: "draft", label: "下書きを頼む", tone: "default", hint: "→ AI-Driven。返信の下書きまで作ってもらう（送るのは自分）" },
          { id: "dismiss", label: "返信不要", tone: "default", hint: "→ Done（不要）。返信しない" },
        ]
      : (m.kind === "todo" || m.kind === "confirm") && !proposals.some((p) => p.id === "kanban")
        ? [handle]
        : [];
  // 確認は「見たので閉じる」が主（完了）
  const opts = [...(m.kind === "confirm" ? [DONE] : []), ...proposals, ...base];
  if (opts.length) opts[0] = { ...opts[0], tone: "primary" };
  opts.push(LATER);
  if (!opts.some((o) => o.id === "dismiss")) opts.push(DISMISS);
  return opts;
}

/** オーナー宛てのカンバンのカード。エージェントがカンバンで直接頼んできたものを、取りこぼさずにカードにする */
export function inboxCard(t: KanbanTask, profiles: AgentProfile[], hub = "default"): Card | null {
  if (t.status === "done" || t.status === "archived" || t.status === "running") return null;
  const m: InboxMeta = { kind: "todo", text: (t.body ?? "").trim(), propose: [] };
  return {
    key: `task:${t.id}`,
    kind: m.kind,
    agent: t.created_by ? (findProfile(profiles, t.created_by)?.id ?? t.created_by) : "me",
    title: t.title,
    body: m.text.slice(0, 4000),
    statusLabel: INBOX_LABEL[m.kind],
    createdAt: t.created_at * 1000,
    options: inboxOptions(m, profileOf(profiles, hub).name),
    taskId: t.id,
  };
}

/** アプリのタスク（判断待ち）から作るカード。選択肢は受信箱と同じに「自分でやる」を足す */
export function appTaskCard(t: Task, profiles: AgentProfile[], hub = "default"): Card {
  const m: InboxMeta = { kind: t.kind, agent: t.agent ?? undefined, ref: t.sourceKey ?? undefined, url: t.url ?? undefined, source: t.source, propose: t.propose, text: t.body };
  const delegateName = profileOf(profiles, m.agent ?? hub).name;
  const opts = inboxOptions(m, delegateName);
  // 「自分でやる」は「あとで」の前に置く（提案の「タスクにする」があれば、それと同じなので足さない）
  if (!opts.some((o) => o.id === "task")) {
    const at = opts.findIndex((o) => o.id === "later");
    opts.splice(at < 0 ? opts.length : at, 0, MINE);
  }
  const who = t.createdBy.startsWith("hermes/") ? t.createdBy.slice("hermes/".length) : t.createdBy;
  return {
    key: `apptask:${t.id}`,
    kind: t.kind,
    agent: findProfile(profiles, who)?.id ?? (who === "app" ? "me" : who),
    title: t.title,
    body: t.body.slice(0, 4000),
    statusLabel: INBOX_LABEL[t.kind],
    createdAt: t.inboxAt,
    options: opts,
    appTaskId: t.id,
    ...(t.ref ? { recordRef: t.ref } : {}),
    ...(t.propose.length ? { proposals: opts.filter((o) => o.id === "kanban" || o.id === "task").map((o) => o.label) } : {}),
    source: t.source,
    ...(t.agent ? { delegate: t.agent } : {}),
    ...(t.sourceKey && t.source !== "mail" && t.source !== "beeper" ? { ref: t.sourceKey } : {}),
    ...(t.url ? { url: t.url } : {}),
  };
}

export interface NoteLike {
  id: number;
  title: string;
  body: string;
  created_at: number;
}

/** レポートなどに自分で注釈を付けて作ったメモ。オーナー自身のカード */
export function noteCard(n: NoteLike): Card {
  return {
    key: `note:${n.id}`,
    kind: "note",
    agent: "me",
    title: n.title,
    body: n.body,
    statusLabel: "メモ",
    createdAt: n.created_at,
    options: OPTIONS.note,
  };
}

export interface CardFilter {
  /** key → この時刻（ms）まで隠す */
  snoozedUntil: Map<string, number>;
  /** key → 判断した時点のカードの createdAt。カードが更新されて新しくなったら再び出す */
  decidedAt: Map<string, number>;
  /** "only": 伏せているカードだけを返す（snoozedUntil を付けて）。既定は伏せているものを除く */
  snoozed?: "hide" | "only";
}

/** カンバン・承認依頼・メモのカードを、タスクに写すときの形 */
export function mirrorInput(c: Card): MirrorInput {
  const base = { cardKey: c.key, title: c.title, body: c.body, agent: c.agent, createdAt: c.createdAt, url: c.url ?? null };
  if (c.kind === "permission") return { ...base, source: "perm", key: `${c.thread ?? c.agent}:${c.requestId}`, kind: "confirm", reopenText: `${c.thread ? "開発エージェント" : "エージェント"}の承認依頼: ${c.title}` };
  if (c.kind === "note") return { ...base, source: "note", key: c.key.slice("note:".length), kind: "todo", reopenText: "カードのメモ" };
  const what = c.kind === "blocked" ? "止まった" : c.kind === "review" ? "レビュー待ちになった" : c.kind === "triage" ? "仕分け待ちになった" : "オーナー宛てに来た";
  return { ...base, source: "kanban", key: c.taskId!, kanbanId: c.taskId!, kind: isInboxKind(c.kind) ? c.kind : "confirm", reopenText: `カンバン ${c.taskId} が${what}${c.body ? `: ${c.body.slice(0, 300)}` : ""}` };
}

/**
 * 判断待ちのカード。mirror を渡すと「カード＝判断待ちのタスク」（2026-10-29、例外なし）:
 * カンバンが止まった・承認依頼・メモは、判断待ちのタスクとして投げる（または元のタスクを判断待ちに移す）。
 * カードは判断待ちのタスクの見え方で、元のカードがあれば元に合わせた選択肢（recordTaskId でつなぐ）、無ければタスクのカード
 */
export function deriveCards(
  board: Board | null,
  perms: (PermissionRequest | HermesApproval)[],
  profiles: AgentProfile[],
  filter: CardFilter,
  now = Date.now(),
  notes: NoteLike[] = [],
  /** 関数なら、写し終えてから読む（写すと判断待ちが増えたり閉じたりする） */
  appTasks: Task[] | (() => Task[]) = [],
  hub = "default",
  mirror?: (items: MirrorInput[]) => Map<string, Task>,
): Card[] {
  let origin: Card[] = [];
  for (const p of perms) origin.push("runId" in p ? hermesApprovalCard(p) : permissionCard(p));
  for (const n of notes) origin.push(noteCard(n));
  for (const t of board?.tasks ?? []) {
    const c = isInboxTask(t) ? inboxCard(t, profiles) : taskCard(t, profiles);
    if (c) origin.push(c);
  }
  // 判断済み（判断のあとにカードが新しくなっていないもの）は出さない
  const undecided = (c: Card) => {
    const d = filter.decidedAt.get(c.key);
    return d === undefined || c.createdAt > d;
  };
  let rec: Map<string, Task> | null = null;
  if (mirror) {
    rec = mirror(dedupe(origin).filter(undecided).map(mirrorInput));
    const r = rec;
    origin = origin.flatMap((c) => {
      const t = r.get(c.key);
      return t ? [{ ...c, recordTaskId: t.id, ...(t.ref ? { recordRef: t.ref } : {}) }] : [];
    });
  }
  let own = typeof appTasks === "function" ? appTasks() : appTasks;
  if (rec) {
    const ids = new Set([...rec.values()].map((t) => t.id));
    // 判断待ちのタスクは必ずカードにする: 元のカードがあればそれ（元に合わせた選択肢）、無ければタスクのカード
    own = own.filter((t) => !ids.has(t.id));
  }
  const cards = [...origin, ...own.map((t) => appTaskCard(t, profiles, hub))];
  return dedupe(cards)
    .filter((c) => ((filter.snoozedUntil.get(c.key) ?? 0) > now) === (filter.snoozed === "only"))
    .filter(undecided)
    .map((c) => (filter.snoozed === "only" ? { ...c, snoozedUntil: filter.snoozedUntil.get(c.key) } : c))
    .sort((a, b) => order(a) - order(b) || byWait(a, b, now));
}

/** 同じ元（ref）から何度も起こされたら、いちばん新しい1枚だけ出す */
function dedupe(cards: Card[]): Card[] {
  const newest = new Map<string, number>();
  for (const c of cards) if (c.ref && isInboxKind(c.kind)) newest.set(`${c.kind}:${c.ref}`, Math.max(newest.get(`${c.kind}:${c.ref}`) ?? 0, c.createdAt));
  return cards.filter((c) => !(c.ref && isInboxKind(c.kind)) || newest.get(`${c.kind}:${c.ref}`) === c.createdAt);
}

/** 同じ種類の中では、長く待っているもの（古い順）→ 新しいもの（新しい順） */
function byWait(a: Card, b: Card, now: number): number {
  const sa = staleHours(a, now) !== null, sb = staleHours(b, now) !== null;
  if (sa !== sb) return sa ? -1 : 1;
  return sa ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
}

function order(c: Card): number {
  return { permission: 0, blocked: 1, review: 2, triage: 2, confirm: 3, reply: 3, todo: 3, note: 4 }[c.kind];
}

export function deriveAgents(board: Board | null, profiles: AgentProfile[], hub: string): AgentNode[] {
  const counts = new Map<string, { running: number; blocked: number; ready: number }>();
  const bump = (id: string, k: "running" | "blocked" | "ready") => {
    const c = counts.get(id) ?? { running: 0, blocked: 0, ready: 0 };
    c[k] += 1;
    counts.set(id, c);
  };
  for (const t of board?.tasks ?? []) {
    if (isInboxTask(t)) continue; // オーナー宛ての受信箱はエージェントではない
    const id = t.assignee || "unassigned";
    if (t.status === "running") bump(id, "running");
    else if (t.status === "blocked") bump(id, "blocked");
    else if (t.status === "ready") bump(id, "ready");
    else if (!counts.has(id) && t.status !== "done" && t.status !== "archived") counts.set(id, { running: 0, blocked: 0, ready: 0 });
  }
  for (const r of board?.active_runs ?? []) if (r.profile && !counts.has(r.profile)) bump(r.profile, "running");

  const ids = new Set<string>([...profiles.map((p) => p.id), ...counts.keys()]);
  ids.delete("unassigned");
  return [...ids].map((id) => {
    const c = counts.get(id) ?? { running: 0, blocked: 0, ready: 0 };
    return {
      ...profileOf(profiles, id),
      ...c,
      state: c.running > 0 ? "running" : c.blocked > 0 ? "blocked" : "idle",
      hub: id === hub,
    } satisfies AgentNode;
  }).sort((a, b) => Number(b.hub) - Number(a.hub));
}
