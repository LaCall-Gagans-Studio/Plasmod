// サーバーとフロントで共有する型。

export type TaskStatus =
  | "triage" | "todo" | "scheduled" | "ready" | "running"
  | "blocked" | "review" | "done" | "archived";

export interface KanbanComment {
  author: string;
  body: string;
  created_at: number;
}

export interface KanbanTask {
  id: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: TaskStatus;
  priority: number;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  last_heartbeat_at: number | null;
  block_kind: string | null;
  result: string | null;
  latest_comment: KanbanComment | null;
}

export interface KanbanRun {
  task_id: string;
  profile: string | null;
  started_at: number;
  last_heartbeat_at: number | null;
}

/** カードの詳細（仲介の task）。Hermes のダッシュボードのカードと同じ中身 */
export interface TaskDetail {
  task: Pick<KanbanTask, "id" | "title" | "body" | "assignee" | "status" | "priority" | "created_by" | "created_at" | "started_at" | "completed_at" | "result"> & {
    skills?: string[] | null;
    model_override?: string | null;
    provider_override?: string | null;
    last_failure_error?: string | null;
  };
  latest_summary: string | null;
  comments: KanbanComment[];
  events: { kind: string; created_at: number; run_id: number | null; detail: string | null }[];
  runs: { id: number; profile: string | null; status: string; outcome: string | null; summary: string | null; error: string | null; started_at: number; ended_at: number | null }[];
  parents: TaskRef[];
  children: TaskRef[];
  attachments: { name: string; size: number; path: string; mtime: number }[];
}

export interface TaskRef {
  id: string;
  title: string;
  status: TaskStatus | null;
  assignee: string | null;
}

/** システム画面の「定期実行」: Hermes の cron（仲介の cron）。送り先は種類だけ */
export interface CronJob {
  profile: string;
  id: string;
  name: string;
  schedule: string | null;
  kind: string | null;
  enabled: boolean;
  /** scheduled / paused / running / completed / error など（Hermes の state） */
  state: string;
  paused_reason: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_delivery_error: string | null;
  failure_streak: number;
  repeat: { times: number | null; completed: number };
  skills: string[];
  model: string | null;
  script: boolean;
  no_agent: boolean;
  deliver: string[];
  prompt: string | null;
}

/** VPS の systemd タイマー（systemctl list-timers）。時刻は ms、無ければ null */
export interface TimerInfo {
  unit: string;
  activates: string;
  description: string;
  /** OnCalendar= や OnUnitActiveSec= をそのまま */
  schedule: string;
  next: number | null;
  last: number | null;
  /** 起動するサービスの前回の結果（success / exit-code など） */
  result: string | null;
  /** apt・logrotate など OS 標準のもの */
  os: boolean;
}

export interface Schedules {
  hermes: CronJob[];
  timers: TimerInfo[];
  errors: { source: string; error: string }[];
  at: number;
}

/** 設定の「VPS」: systemd のサービス1つ */
export interface VpsService {
  unit: string;
  description: string;
  /** active / inactive / failed / activating … */
  active: string;
  sub: string;
  /** タイマーで動く oneshot。止まっているのが普通で、最後の結果（result）で見る */
  oneshot: boolean;
  result: string | null;
  /** 今の状態になった時刻（ms） */
  since: number | null;
  restarts: number | null;
  /** バイト */
  memory: number | null;
}

export interface VpsStatus {
  at: number;
  hostname: string;
  /** 起動してからの時間（ms） */
  uptime: number | null;
  load: [number, number, number] | null;
  cpus: number;
  /** バイト */
  mem: { total: number; used: number } | null;
  swap: { total: number; used: number } | null;
  disks: { path: string; total: number; used: number; avail: number }[];
  services: VpsService[];
  /** systemctl --state=failed のユニット（OS のものも含む） */
  failed: string[];
  /** 本番（/opt）に入っている commit */
  deployed: string | null;
  errors: { source: string; error: string }[];
}

/** 設定の VPS のグラフの1点。CPU・メモリ・ディスクは %、ネットはバイト/秒。測れなかったら null */
export interface VpsSample {
  at: number;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  net: number | null;
}

/** システム画面の「エージェント」。Hermes は仲介の agents、開発エージェントは bridge で CLAUDE.md を読む */
export interface AgentInfo {
  id: string;
  kind: "hermes" | "dev";
  model: string;
  /** 人格（SOUL.md / CLAUDE.md）の先頭 */
  soul: string | null;
  /** 開けるファイル（root は ファイル画面と同じ work / hermes） */
  files: { label: string; root: "work" | "hermes"; path: string }[];
  skills: { name: string; description: string; category: string; root: "work" | "hermes"; path: string }[];
  error?: string;
}

export interface Board {
  latest_event_id: number;
  tasks: KanbanTask[];
  links: { parent_id: string; child_id: string }[];
  active_runs: KanbanRun[];
  fetched_at: number;
}

/** 開発エージェント（Claude Code）が出した承認依頼。plasmod-bridge から届く。 */
export interface PermissionRequest {
  thread: string;
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
  thread_title: string | null;
  created_at: number;
}

/** Hermes のエージェントの承認待ち（危険なコマンドの確認）。アプリのセッションのターンから届く */
export interface HermesApproval {
  id: string;
  agent: string;
  session: string;
  runId: string;
  /** Hermes が送ってきたときだけ。返すときに同じものを付ける */
  requestId?: string;
  command: string;
  description: string;
  createdAt: number;
}

/** 「あとで」の伏せる長さ。無ければ既定（PLASMOD_SNOOZE_MIN） */
export type SnoozeKind = "3h" | "morning" | "week";

/** 受信箱のカード（エージェントが「オーナーに見てほしい」と起こしたもの）の種類 */
export type InboxKind = "confirm" | "reply" | "todo";

export type CardKind = "blocked" | "review" | "triage" | "permission" | "note" | InboxKind;

export interface CardOption {
  id: string;
  label: string;
  tone: "primary" | "default" | "quiet" | "danger";
  /** true なら自由入力の返事が必須（「指示を付けて戻す」など） */
  needsText?: boolean;
  /** 押すと何が起きるか（ボタンの下に小さく出す） */
  hint?: string;
}

/** これより長く判断を待っているカードは、同じ種類の中で先頭に出し、一覧に「N時間待ち」と出す（メモは除く） */
export const STALE_WAIT_MS = 4 * 3600_000;

export function staleHours(c: Pick<Card, "kind" | "createdAt">, now = Date.now()): number | null {
  if (c.kind === "note") return null;
  const ms = now - c.createdAt;
  return ms >= STALE_WAIT_MS ? Math.floor(ms / 3600_000) : null;
}

/** 待っている時間の短い書き方: 1日まで「5h」、24時間を過ぎたら日で「3d」、30日を過ぎたら月で「1m」（端数は切り捨て） */
export function hoursLabel(h: number): { short: string; long: string } {
  if (h < 24) return { short: `${h}h`, long: `${h}時間` };
  const d = Math.floor(h / 24);
  if (d < 30) return { short: `${d}d`, long: `${d}日` };
  const m = Math.floor(d / 30);
  return { short: `${m}m`, long: `${m}ヶ月` };
}

export interface Card {
  key: string;
  kind: CardKind;
  agent: string;
  title: string;
  body: string;
  statusLabel: string;
  createdAt: number;
  options: CardOption[];
  taskId?: string;
  thread?: string;
  requestId?: string;
  /** 受信箱のカード: 「対応する」で依頼を渡す先（プロファイル）。無ければハブ（ハブ） */
  delegate?: string;
  /** 受信箱のカード: 元の参照（タスク番号・メールの件名など）と URL */
  ref?: string;
  url?: string;
  /** 受信箱のカード: エージェントの提案（「カンバンに起こす（経理エージェント）」「など、表示用） */
  proposals?: string[];
  /** 受信箱のカード: 元の種類（mail / beeper / ops など） */
  source?: string;
  /** 「あとで」で伏せているカード: この時刻（ms）まで。一覧では薄く出す */
  snoozedUntil?: number;
  /** アプリのタスク（TASK-173）から作ったカード: タスクの番号 */
  appTaskId?: number;
  /** カンバン・承認依頼・メモのカードを記録している、判断待ちのタスク（「カード＝判断待ちのタスク」） */
  recordTaskId?: number;
  /** カードのタスクの番号（TASK-123）。右上に出して、押すとタスクを開く */
  recordRef?: string;
  /** タスクに親があれば、その番号と題（子だけ見ても文脈が分かるように） */
  parent?: { id: number; ref: string | null; title: string };
}

export interface AgentProfile {
  id: string;
  name: string;
  initial: string;
  color: string;
  /** 設定によっては別の名前で来ることがある（Hermes の API の宛先の名前など）。どれでもこのプロファイルとして表示する */
  aliases?: string[];
  /** 顔の画像の URL（無ければ頭文字の丸） */
  avatar?: string;
  /** チーム: work＝実働（既定）、watch＝監察（読むだけ・週1回の報告） */
  team?: "work" | "watch";
  /** 役割（図・設定で名前の下に出す短い説明） */
  role?: string;
}

/** id か別名で、プロファイルを探す */
export function findProfile<T extends AgentProfile>(profiles: T[], id: string): T | undefined {
  const k = id.toLowerCase();
  return profiles.find((p) => p.id.toLowerCase() === k || (p.aliases ?? []).some((a) => a.toLowerCase() === k));
}

export type AgentState = "running" | "blocked" | "idle";

export interface AgentNode extends AgentProfile {
  state: AgentState;
  running: number;
  blocked: number;
  ready: number;
  hub: boolean;
}

/** レポートのスライド（ストーリー型） */
export type ReportSlide =
  /** カンバンとエージェントの実績をまとめた1枚（最後に出す） */
  | {
      kind: "digest";
      done: number;
      running: number;
      cards: { name: string; agent: string; color: string }[];
      agents: { id: string; name: string; done: number; running: number; color: string }[];
      tasksDone: TaskSummaryItem[];
    }
  | { kind: "memos"; items: { id: number; title: string; project: string | null; excerpt: string; at: number }[] }
  | { kind: "habits"; items: Habit[] }
  | { kind: "waiting"; items: { key: string; agent: string; label: string; title: string }[] }
  | { kind: "tasks"; today: TaskSummaryItem[]; week: TaskSummaryItem[]; doing: TaskSummaryItem[]; error?: string }
  | { kind: "watch"; items: WatchReport[]; error?: string }
  | { kind: "routine"; items: WatchReport[]; late: { agent: string; name: string; reason: string }[]; error?: string };

/** ルーティーン */
export interface Habit {
  id: number;
  name: string;
  emoji: string | null;
  doneToday: boolean;
  /** 続いている日数（今日がまだでも、昨日まで続いていれば数える） */
  streak: number;
  total: number;
}

export interface HabitOverview {
  /** YYYY-MM-DD */
  today: string;
  habits: Habit[];
  /** 古い順。草グラフの1マスずつ */
  days: { day: string; count: number }[];
}

/** 定期報告（各プロファイルの cron の出力。監察チームの週1回の報告もこれ）。text は返答の部分だけ */
export interface WatchReport {
  agent: string;
  job: string;
  name: string;
  /** ms */
  at: number;
  ok: boolean;
  text: string;
}

/** レポートに出す issue（チームの、今日・今週・進行中・今週終えた） */
export interface TaskSummaryItem {
  id: string;
  title: string;
  url: string;
  state: string;
  /** YYYY-MM-DD（期限）。終えたものは完了した日 */
  due: string | null;
  overdue?: boolean;
}

/** 下のメニューの数字 */
export interface NavBadges {
  home: number;
  dev: number;
  watching: number;
  system: number;
}

export interface Report {
  /** 対象期間の終わり（ms）と長さ（時間） */
  at: number;
  hours: number;
  slides: ReportSlide[];
}

export interface SearchHit {
  kind: "task" | "card" | "decision" | "report" | "note" | "memo" | "apptask" | "session";
  ref: string;
  title: string;
  snippet: string;
  at: number;
}

/** メモ（TASK-174）。プロジェクトは1つまで、タグはいくつでも */
export interface Memo {
  id: number;
  title: string;
  body: string;
  project: string | null;
  tags: string[];
  /** 親のメモ（無ければ一番上） */
  parentId: number | null;
  /** 最初に書いた人（app=オーナー） */
  author: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface MemoSummary {
  id: number;
  title: string;
  excerpt: string;
  project: string | null;
  tags: string[];
  parentId: number | null;
  updatedAt: number;
  archived: boolean;
}

export interface MemoList {
  memos: MemoSummary[];
  projects: { name: string; count: number }[];
  tags: { name: string; count: number }[];
}

/** タスク（TASK-173）。見回りが元の ID 付きで登録したもの・オーナーが画面で足したもの */
/**
 * タスクの状態（2026-10-29 に4つに）: 判断待ち（inbox）・やる（todo）・任せ中（doing）・完了（done / dismissed）。
 * dismissed は「完了・理由は不要」。画面では完了にまとめ、小さく「不要」と添える。返事待ち（waiting）はやめた（完了にしておけば、元に新しい動きがあると判断待ちに戻る）
 */
export type AppTaskStatus = "inbox" | "todo" | "doing" | "done" | "dismissed";

export interface AppTask {
  id: number;
  /** 番号（TASK-123）。取り込んだものは元の番号、アプリで作ったものは続きの番号 */
  ref: string | null;
  /** 親タスク（サブタスクのとき） */
  parentId: number | null;
  /** 開いているサブタスクの数（一覧のとき） */
  openChildren?: number;
  /** タグ（メモと共通の名前） */
  tags: string[];
  title: string;
  body: string;
  kind: InboxKind;
  status: AppTaskStatus;
  /** mail / beeper / ops / app（画面で足したもの）など */
  source: string;
  sourceKey: string | null;
  url: string | null;
  /** 「任せる」ときの渡し先（プロファイル） */
  agent: string | null;
  propose: ("kanban" | "task")[];
  project: string | null;
  /** YYYY-MM-DD */
  due: string | null;
  createdBy: string;
  kanbanId: string | null;
  /** 元の最後の動き（新しいメールが来た時刻など） */
  eventAt: number | null;
  decidedAt: number | null;
  /** 判断待ち（inbox）になった時刻 */
  inboxAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface AppTaskEvent {
  id: number;
  at: number;
  author: string;
  kind: "create" | "update" | "reopen" | "decide" | "kanban" | "done" | "comment" | "ignored";
  text: string;
}

/** タスク同士のつながり（中身の画面用） */
export interface AppTaskLinks {
  parent: AppTask | null;
  children: AppTask[];
  /** このタスクが止めている（先に済ませないと進まない）もの */
  blocks: AppTask[];
  /** このタスクを止めているもの */
  blockedBy: AppTask[];
  related: AppTask[];
}

export interface AppTaskList {
  tasks: AppTask[];
  /** 状態ごとの件数（絞り込み前・プロジェクトと語の絞り込みは反映） */
  counts: Record<AppTaskStatus, number>;
  projects: { name: string; count: number }[];
}

/** プロジェクト（PJ）。メモとタスクで共通 */
export type ProjectStatus = "active" | "paused" | "done";

export interface Project {
  id: number;
  name: string;
  /** 説明（Markdown） */
  description: string;
  status: ProjectStatus;
  emoji: string | null;
  openTasks: number;
  /** 期限切れの開いているタスク */
  lateTasks: number;
  nextDue: string | null;
  memos: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectDetail {
  project: Project;
  tasks: AppTask[];
  doneTasks: AppTask[];
  memos: MemoSummary[];
}

export interface ProjectOverview {
  /** urgent は期限切れと3日以内のタスク（サブタスクも）。畳んでいても常に見せる */
  projects: (Project & { tasks: AppTask[]; urgent: AppTask[]; recentMemos: MemoSummary[] })[];
  none: { tasks: AppTask[]; urgent: AppTask[]; recentMemos: MemoSummary[]; openTasks: number; memos: number };
}

/** 保存のたびの版 */
export interface MemoEvent {
  id: number;
  at: number;
  author: string;
  kind: "create" | "edit" | "archive" | "restore";
  title: string;
  body: string;
  project: string | null;
  tags: string[];
}

export interface SessionInfo {
  agent: string;
  id: string;
  title: string;
  last: number;
  alive: boolean;
  working: boolean;
  /** Hermes の cron が動いた回（source=cron）。一覧のトグルで省ける */
  cron?: boolean;
  /** ピン留めした時刻。ピンのものは一覧の一番上 */
  pinnedAt?: number;
  /** 題名を付け替えたとき、元の題名（title が付け替えた方） */
  originalTitle?: string;
}

/** チャットに出す写真・ファイル。url はアプリの取り出し口（パス検査は持ち主の側） */
export interface MediaItem {
  name: string;
  url: string;
  kind: "image" | "pdf" | "file";
  size?: number;
}

/** 開発エージェントのスレッドの会話 */
export interface ChatMessage {
  id: string;
  /** owner（オーナー）/ dev（開発エージェントの返事）/ system（bridge の知らせ）/ other */
  author: "owner" | "dev" | "system" | "other";
  via?: string | null;
  content: string;
  attachments: string[];
  /** 取り出せるファイル（bridge の記録に載ったもの）。無ければ attachments の名前だけ出す */
  media?: MediaItem[];
  at: number;
}

/** 上にスクロールして前の会話を読むための目印 */
export interface HistoryCursor {
  /** これより前を読む（開発エージェント: 記録の id、Hermes: メッセージの id） */
  before: string;
  /** Hermes: 新しい方から読み終えた件数 */
  offset?: number;
  /** まだ前がある */
  more: boolean;
  /** 開発エージェント: bridge から読めるのは最新の500件まで。そこで止まった */
  capped?: boolean;
}

export type SessionView =
  | { kind: "terminal"; text: string; alive: boolean; working: boolean; messages?: ChatMessage[]; chatError?: string; cursor?: HistoryCursor }
  | { kind: "chat"; messages: HermesMessage[]; alive: boolean; working: boolean; error?: string; cursor?: HistoryCursor; approvalCard?: string };

export type OlderPage = { messages: ChatMessage[] | HermesMessage[]; cursor: HistoryCursor };

/** Hermes の会話の1件。role が "steps" のものは途中経過（道具を使った記録。画面に出る「ウェブを検索中: …」と同じもの） */
export interface HermesMessage {
  role: string;
  text: string;
  media?: MediaItem[];
  steps?: string[];
  /** 記録の時刻（ms）。途中経過の最後の時刻で「作業中」を判断する */
  at?: number;
}

export interface DevPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  updatedAt: number;
  additions: number;
  deletions: number;
  files: number;
  summary: string;
  refs: string[];
  checks: { state: "success" | "failure" | "pending" | "none"; passed: number; failed: number; pending: number };
  previewUrl: string | null;
}

export interface DevSnapshot {
  prs: DevPr[];
  fetchedAt: number;
  error: string | null;
}

export interface ShareInfo {
  id: string;
  title: string;
  text: string;
  url: string;
  files: { name: string; type: string; size: number }[];
  createdAt: number;
}

export interface UsageWindow {
  tokens: number;
  cost: number;
  sessions: number;
}

export type ConnectionState = "ok" | "soon" | "needs" | "off" | "unknown";

/** 接続1つの状況。トークンの値は持たない */
export interface Connection {
  id: string;
  kind: "claude" | "nous" | "mcp";
  name: string;
  profile: string | null;
  state: ConnectionState;
  reason: string | null;
  /** アプリからログインし直せるか */
  canLogin: boolean;
  lastRefreshAt: number | null;
  expiresAt: number | null;
}

export interface ConnectionEvent {
  id: number;
  at: number;
  connId: string;
  name: string;
  fromState: ConnectionState | null;
  toState: ConnectionState;
  reason: string | null;
}

export interface ConnectionsView {
  at: number;
  connections: Connection[];
  events: ConnectionEvent[];
  errors: string[];
}

export interface UsageSnapshot {
  claude:
    | {
        h5: Record<string, number>;
        d7: Record<string, number>;
        messages_h5: number;
        messages_d7: number;
        oldest_h5: number | null;
        /** API 換算の金額（ドル）。bridge に app-usage-cost.patch が当たっていなければ無い */
        cost_h5?: number;
        cost_d7?: number;
        /** 単価が分からず金額に入れなかったモデル */
        unpriced?: string[];
      }
    | { error: string };
  hermes: Record<string, { h5: UsageWindow; d7: UsageWindow; d30: UsageWindow; models: { model: string; tokens: number; cost: number }[] } | { error: string }>;
  plans: { name: string; usd: number }[];
  monthlyUsd: number;
  at: number;
}

/** Nous のクレジット（仲介の credits）。金額はドル */
export interface NousCredits {
  paidAccess: boolean | null;
  reason: string | null;
  plan: string | null;
  /** 月の枠と、枠の残り（Hermes の「You've used $X of your $Y cap」の Y と Y−X） */
  monthly: number | null;
  subscriptionRemaining: number | null;
  purchasedRemaining: number | null;
  totalRemaining: number | null;
  periodEnd: string | null;
  error?: string;
  at: number;
}

export interface ModelEntry {
  key: string;
  name: string;
  current: string;
  choices: { id: string; label: string; note: string }[];
  error?: string;
}

export interface FsList {
  path: string;
  items: { name: string; dir: boolean; size: number; mtime: number; locked: boolean }[];
}

export interface FsRead {
  path: string;
  size: number;
  binary: boolean;
  truncated?: boolean;
  text: string;
}

export interface TaskBadge {
  id: string;
  title: string;
  url: string;
  state: string;
  /** backlog / unstarted / started / completed / canceled / triage */
  stateType: string;
}

export interface Snapshot {
  board: Board | null;
  boardError: string | null;
  cards: Card[];
  /** 「あとで」で伏せているカード。cards とは別（通知・数字には数えない） */
  snoozed: Card[];
  agents: AgentNode[];
  bridgeConnected: boolean;
  /** 開発エージェントの bridge を入れているか。入れていなければ未接続の警告を出さない */
  devEnabled?: boolean;
}

/**
 * アプリ自身の通知（APK が受け取る。TASK-250）。path はアプリの中の行き先（#/card/… など）。
 * ボタンは、カードの選択肢（option）か、開く先（path）
 */
export interface AppNotice {
  id: number;
  at: number;
  type: "notice";
  /** card＝判断待ち、reply＝エージェントの返事、system＝デプロイ・root など */
  kind: "card" | "reply" | "system";
  /** 同じ key の通知は上書きし、clear で消す（カードの key など） */
  key: string;
  title: string;
  message: string;
  /** 1〜5（5 が一番高い。承認依頼・再通知） */
  priority: number;
  path: string;
  actions: { label: string; option?: string; path?: string }[];
}
export type NoticeEvent = AppNotice | { id: number; at: number; type: "clear"; key: string };

/** 速さの記録: startup_*＝起動の内訳（startupStages）、startup＝起動から操作できるまで、session_new・session_reply＝話しかけてから最初の返事が見えるまで（新しいセッション・続き） */
export type PerfName = "startup" | "startup_entry" | "startup_doc" | "startup_script" | "startup_data" | "session_new" | "session_reply";
export interface PerfRow {
  name: PerfName;
  via: "apk" | "browser";
  n: number;
  p50: number;
  p90: number;
}
