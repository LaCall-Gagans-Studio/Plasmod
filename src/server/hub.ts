// 状態の持ち主: カンバンの取得、カードの組み立て、判断の実行、通知、画面への配信。
import { existsSync } from "node:fs";
import type { Board, Card, HermesApproval, Report, SnoozeKind, SearchHit, Snapshot, TaskDetail, TaskStatus } from "../shared/types";
import type { BridgeClient } from "./bridge";
import type { Config } from "./config";
import type { KanbanSource } from "./kanban";
import { deriveAgents, deriveCards, INBOX_ASSIGNEES, isInboxKind, snoozeUntil } from "./model";
import type { Notifier } from "./notify";
import { buildReport, reportText } from "./report";
import { SearchIndex } from "./search";
import type { Store } from "./store";
import type { Task, TaskStore } from "./tasks";
import { config } from "./config";
import { localDay } from "../shared/time";

// 先（Hermes・仲介など）の失敗は 500 で返す
export class ActError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 500 = 400) {
    super(message);
  }
}

/** 判断の署名。呼び名は設定で変わるので毎回読む */
const sign = () => `${config.ownerName}（Plasmod）`;
/** Hermes の complete が受け付ける状態（それ以外はアーカイブで閉じる） */
const COMPLETABLE: TaskStatus[] = ["running", "ready", "blocked", "review"];

export class Hub {
  board: Board | null = null;
  boardError: string | null = null;
  private lastEventId = -1;
  private subscribers = new Set<(s: Snapshot) => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  readonly search: SearchIndex;
  /** Hermes のエージェントの承認待ち（SessionService） */
  private approvals: { pendingApprovals(): HermesApproval[]; answerApproval(id: string, choice: "once" | "deny"): Promise<void> } | null = null;

  constructor(
    private cfg: Config,
    private source: KanbanSource,
    private store: Store,
    private bridge: BridgeClient | null,
    private notifier: Notifier | null,
  ) {
    this.search = new SearchIndex(store.db);
    bridge?.onChange(() => this.changed());
  }

  setApprovals(a: NonNullable<Hub["approvals"]>) {
    this.approvals = a;
  }

  snapshot(): Snapshot {
    return {
      board: this.board,
      boardError: this.boardError,
      cards: this.cards(),
      snoozed: this.cards("only"),
      agents: deriveAgents(this.board, this.cfg.profiles, this.cfg.hubProfile),
      bridgeConnected: this.bridge?.connected ?? false,
      devEnabled: existsSync(this.cfg.bridgeSock),
    };
  }

  /** 判断待ちのカード。snoozed="only" で「あとで」で伏せているものだけ */
  cards(snoozed: "hide" | "only" = "hide"): Card[] {
    return this.withParents(deriveCards(
      this.board,
      [...(this.bridge?.requests() ?? []), ...(this.approvals?.pendingApprovals() ?? [])],
      this.cfg.profiles,
      { snoozedUntil: this.store.snoozedUntil(), decidedAt: this.store.decidedAt(), snoozed },
      Date.now(),
      this.store.openNotes(),
      () => this.tasks?.inbox() ?? [],
      this.cfg.hubProfile,
      this.tasks ? (items) => this.tasks!.mirror(items, this.healthy()) : undefined,
    ));
  }

  /** カードのタスクに親があれば、番号と題を添える */
  private withParents(cards: Card[]): Card[] {
    const tasks = this.tasks;
    if (!tasks) return cards;
    return cards.map((c) => {
      const id = c.appTaskId ?? c.recordTaskId;
      const pid = id ? tasks.get(id)?.parentId : null;
      const p = pid ? tasks.get(pid) : null;
      return p ? { ...c, parent: { id: p.id, ref: p.ref, title: p.title } } : c;
    });
  }

  /**
   * カードにコメントだけ書く（判断はしない）。タスクの記録に残し、カンバンのカードならそちらにも（添付はカンバンだけ）
   */
  async commentCard(key: string, text: string, files: { name: string; data: Uint8Array }[] = []) {
    const card = [...this.cards(), ...this.cards("only")].find((c) => c.key === key);
    if (!card) throw new ActError("このカードはもう判断済みか、無くなっている", 404);
    if (files.length && !card.taskId) throw new ActError("このカードには添付できない（カンバンのカードだけ）");
    const own = card.appTaskId ?? card.recordTaskId;
    const t = text.trim();
    if (own && (t || files.length)) this.tasks?.comment(own, [t, files.map((f) => `📎 ${f.name}`).join("\n")].filter(Boolean).join("\n\n"), "app");
    if (card.taskId) await this.commentTask(card.taskId, `${sign()}: ${t}`.trim(), files);
    else this.changed();
  }

  /** 今ちゃんと読めている元。読めていない元のタスクは、カードが無くても閉じない（つながりが切れただけかもしれない） */
  private healthy(): Set<string> {
    const s = new Set<string>(["note"]);
    if (this.board && !this.boardError) s.add("kanban");
    if (this.bridge?.connected) s.add("perm");
    return s;
  }

  report(now = Date.now()): Report {
    const r = buildReport(this.board, this.cards(), this.cfg.profiles, now);
    const day = localDay(now); // 日付ごとに1件残す
    this.search.upsert("report", day, `レポート ${day}`, reportText(r), now);
    return r;
  }

  addNote(title: string, body: string, source: string | null) {
    const n = this.store.addNote(title.slice(0, 200), body.slice(0, 4000), source);
    this.search.upsert("note", String(n.id), n.title, n.body, n.created_at);
    this.changed();
    return n;
  }

  /** カードを作って添付する */
  async createCard(title: string, body: string, assignee: string, files: { name: string; data: Uint8Array }[]): Promise<string> {
    const id = await this.source.create(title, body, assignee);
    for (const f of files) await this.source.attach(id, f.name, f.data);
    this.search.upsert("task", id, title, body, Date.now());
    await this.refresh();
    return id;
  }

  private tasks: TaskStore | null = null;
  /** アプリのタスク（TASK-173）。判断待ちのものがカードになる */
  setTasks(t: TaskStore | null) {
    this.tasks = t;
  }

  /** カンバンのカードの詳細 */
  task(taskId: string): Promise<TaskDetail> {
    return this.source.task(taskId);
  }

  /**
   * カードの詳細から書いたコメント（author は仲介が owner にする）と、付けたファイル。
   * 添付は先に付け、コメントに「📎 名前」を残す（添付だけでもコメント欄に出て、エージェントにも伝わる）
   */
  async commentTask(taskId: string, body: string, files: { name: string; data: Uint8Array }[] = []) {
    for (const f of files) await this.source.attach(taskId, f.name, f.data);
    const text = [body.trim(), files.map((f) => `📎 ${f.name}`).join("\n")].filter(Boolean).join("\n\n");
    if (text) await this.source.comment(taskId, text.slice(0, 8000));
    await this.refresh();
  }

  /**
   * カード（判断待ち・承認依頼・カードのメモ・カンバンの受信箱）から、オーナーのタスク（やる）を作る。
   * 元のカードの本文・元・カンバンの番号を本文に残す。タスクのカードなら、そのタスクを「やる」にするだけ
   */
  taskFromCard(card: Card, note: string): Task {
    const tasks = this.tasks;
    if (!tasks) throw new ActError("タスクが使えない", 404);
    const own = card.appTaskId ?? card.recordTaskId;
    if (own) return tasks.decide(own, "todo", note, "app", Date.now(), "自分でやる");
    const body = [note, card.body, card.ref ? `元: ${card.ref}` : "", card.url ?? "", card.taskId ? `カンバン: ${card.taskId}` : ""].filter(Boolean).join("\n\n");
    const t = tasks.create({ title: card.title, body }, "app");
    this.search.upsert("decision", `${card.key}:task:${t.id}`, `タスクにした: ${t.ref} ${t.title}`, body, Date.now());
    this.changed();
    return t;
  }

  find(q: string): SearchHit[] {
    const hits = this.search.search(q);
    // 番号（TASK-123）そのものなら、そのタスクを一番上に
    const t = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,6}$/.test(q.trim()) ? this.tasks?.byRef(q.trim().toUpperCase()) : null;
    if (!t) return hits;
    const own = hits.find((h) => h.kind === "apptask" && h.ref === String(t.id));
    const top: SearchHit = own ?? { kind: "apptask", ref: String(t.id), title: t.title, snippet: t.ref ?? "", at: t.updatedAt };
    return [top, ...hits.filter((h) => h !== own)];
  }

  private index(cards: Card[]) {
    for (const t of this.board?.tasks ?? []) {
      const body = [t.body, t.latest_comment?.body, t.result].filter(Boolean).join("\n\n");
      this.search.upsert("task", t.id, t.title, body, (t.completed_at ?? t.latest_comment?.created_at ?? t.created_at) * 1000);
    }
    for (const c of cards) if (c.kind === "permission") this.search.upsert("card", c.key, c.title, c.body, c.createdAt);
  }

  subscribe(fn: (s: Snapshot) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  changed() {
    const s = this.snapshot();
    for (const fn of this.subscribers) fn(s);
    try {
      this.index(s.cards);
    } catch (e) {
      console.error("search index", e);
    }
    // メモはオーナー自身が作ったものなので通知しない
    // 受信箱のカードは届いたときに1回だけ知らせる（再通知はしない）
    const notify = s.cards.filter((c) => c.kind !== "note");
    void this.notifier?.sweep(notify, Date.now(), new Set(notify.filter((c) => isInboxKind(c.kind)).map((c) => c.key)));
  }

  async refresh() {
    try {
      this.board = await this.source.board();
      this.lastEventId = this.board.latest_event_id;
      this.boardError = null;
      // 任せたタスクは、カンバンのカードが終わったら済みにする
      this.tasks?.syncKanban(this.board.tasks);
    } catch (e) {
      this.boardError = e instanceof Error ? e.message : String(e);
    }
    this.changed();
  }

  async poll() {
    try {
      const id = await this.source.latestEventId();
      if (id !== this.lastEventId) await this.refresh();
      else if (this.board) this.board.fetched_at = Date.now(); // 変化なしでも「いつ確かめたか」は更新する
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== this.boardError) {
        this.boardError = msg;
        this.changed();
      }
    }
  }

  start() {
    void this.refresh();
    this.timers.push(setInterval(() => void this.poll(), this.cfg.pollMs));
    // 再通知・スヌーズ明けのため、変化がなくても1分ごとに見直す
    this.timers.push(setInterval(() => this.changed(), 60_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }

  markSeen(key: string) {
    this.store.markSeen(key);
  }

    /**
   * カードの選択肢を実行する。書いたコメントと添付は、どの選択肢でもカード（カンバンのタスク）に届く。
   * 「あとで」でも捨てない（コメントを書いてからカードを伏せる）。
   */
  async act(key: string, optionId: string, text: string, via: string, files: { name: string; data: Uint8Array }[] = [], snooze?: SnoozeKind): Promise<void> {
    // 伏せているカードも、開いて判断できる
    const card = [...this.cards(), ...this.cards("only")].find((c) => c.key === key);
    if (!card) throw new ActError("このカードはもう判断済みか、無くなっている", 404);
    const opt = card.options.find((o) => o.id === optionId);
    if (!opt) throw new ActError(`選択肢 ${optionId} はこのカードに無い`);
    const note = text.trim();
    if (opt.needsText && !note) throw new ActError("この選択肢には返事の文章が要る");
    if (files.length && !card.taskId && !card.appTaskId) throw new ActError("このカードには添付できない");
    // タスクのカードの添付は、任せる先のカンバンのカードに付ける（ほかの選択肢では渡す先が無い）
    if (files.length && card.appTaskId && !["handle", "kanban", "draft"].includes(optionId)) throw new ActError("添付は「任せる」「下書きを頼む」のときだけ渡せる");

    const record = (ok: boolean, error?: string) =>
      this.store.recordDecision({ key, choice: optionId, text: note, cardCreatedAt: card.createdAt, via, ok, error });

    if (optionId === "later") {
      if ((card.appTaskId ?? card.recordTaskId) && note) this.tasks?.comment((card.appTaskId ?? card.recordTaskId)!, note, "app");
      if (card.taskId && (note || files.length)) {
        try {
          if (note) await this.source.comment(card.taskId, `${sign()}: ${note}`);
          for (const f of files) await this.source.attach(card.taskId, f.name, f.data);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          record(false, msg);
          throw new ActError(msg, 500);
        }
      }
      this.store.snooze(key, snooze ? snoozeUntil(snooze) : Date.now() + this.cfg.snoozeMin * 60_000);
      record(true);
      this.store.markSeen(key);
      this.changed();
      return;
    }

    try {
      // 添付は先にカードへ付ける（受信箱の「対応する」などで起こすカードにも付ける）
      if (card.taskId) for (const f of files) await this.source.attach(card.taskId, f.name, f.data);
      await this.apply(card, optionId, note, files);
      record(true);
      this.recordDecision(card, optionId, opt.label, note);
      this.search.upsert("decision", `${key}:${Date.now()}`, `${opt.label}: ${card.title}`, [note, card.body].filter(Boolean).join("\n\n"), Date.now());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      record(false, msg);
      throw new ActError(msg, 500);
    }
    this.store.markSeen(key);
    if (card.taskId) await this.refresh();
    else this.changed();
  }

  /**
   * カンバン・承認依頼・メモのカードの判断を、記録しているタスクに残す。
   * カンバンが続きをやるもの（進めて・やり直し・〇〇に任せる・下書きを頼む）は任せ中、不要は完了（不要）、ほかは完了
   */
  private recordDecision(card: Card, optionId: string, label: string, note: string) {
    if (!card.recordTaskId || !this.tasks) return;
    const t = this.tasks.get(card.recordTaskId);
    // 「自分でやる」はもう「やる」にしてある
    if (!t || t.status !== "inbox") return;
    // 任せ中（カンバンが続きをやる）／完了（不要）／完了
    const status: Task["status"] =
      ["approve", "revise", "changes", "handle", "kanban", "draft"].includes(optionId) || optionId.startsWith("to-")
        ? "doing"
        : optionId === "mine" || optionId === "task"
          ? "todo"
          : optionId === "dismiss" || optionId === "archive"
            ? "dismissed"
            : "done";
    this.tasks.decide(t.id, status, note, "app", Date.now(), label);
  }

  /**
   * 受信箱のカードを閉じる。Hermes の「完了」は running・ready・blocked・review からしか効かないので、
   * triage・todo などはコメントに判断を残してからアーカイブする（完了にしようとすると断られて閉じられない）
   */
  private async closeInbox(id: string, result: string) {
    const status = this.board?.tasks.find((t) => t.id === id)?.status;
    if (status && !COMPLETABLE.includes(status)) {
      await this.source.comment(id, result);
      await this.source.archive(id);
    } else await this.source.complete(id, result);
  }

  /** カンバンのカードの詳細から: 仕分け待ちのカードを片付ける */
  async archiveTask(taskId: string) {
    await this.source.archive(taskId);
    await this.refresh();
  }

  /** カンバンのカードの詳細から: 仕分け待ちのカードの担当を決めて進める（todo に戻り、担当が拾う） */
  async specifyTask(taskId: string, assignee: string) {
    await this.source.specify(taskId, assignee);
    await this.refresh();
  }

  /** 受信箱のカード。完了にするのはこのカード（オーナー宛て）で、「対応する」では実行者向けの新しいカードを起こす */
  private async applyInbox(card: Card, optionId: string, note: string, files: { name: string; data: Uint8Array }[]) {
    const extra = note ? `\n\n${note}` : "";
    const id = card.taskId!;
    switch (optionId) {
      case "dismiss":
        await this.closeInbox(id, `${sign()}: 不要。${extra}`);
        return;
      case "handle": {
        const to = this.cfg.hubProfile;
        const body = [
          note,
          card.body,
          `受信箱のカード: ${id}`,
          "（Plasmod の受信箱で「対応する」を選んだ）",
        ].filter(Boolean).join("\n\n");
        const created = await this.createCard(card.title, body, to, files);
        await this.closeInbox(id, `${sign()}: 対応する → ${created}（${to}）。${extra}`);
        return;
      }
      default:
        throw new Error(`${card.kind} に ${optionId} は使えない`);
    }
  }

  /** アプリのタスクから作ったカード。判断はタスクに残す（同じ元がまた来ても起こし直さない） */
  private async applyAppTask(card: Card, optionId: string, note: string, files: { name: string; data: Uint8Array }[]) {
    const tasks = this.tasks;
    if (!tasks) throw new Error("タスクが使えない");
    const id = card.appTaskId!;
    const t = tasks.get(id);
    if (!t) throw new Error("このタスクは無い");
    const label = card.options.find((o) => o.id === optionId)?.label ?? optionId;
    const ref = [t.url ?? "", `元: ${t.source} ${t.sourceKey ?? ""}`.trim(), `タスク: #${id}（Plasmod）`].filter(Boolean).join("\n");
    switch (optionId) {
      case "ok":
        tasks.decide(id, "done", note, "app", Date.now(), label);
        return;
      case "dismiss":
        // 完了（不要）。元（同じメールのスレッドなど）に新しい動きがあったときだけ、また判断待ちに戻る
        tasks.decide(id, "dismissed", note, "app", Date.now(), label);
        return;
      case "mine":
        tasks.decide(id, "todo", note, "app", Date.now(), label);
        return;
      case "task":
        tasks.decide(id, "todo", note, "app", Date.now(), label);
        return;
      case "draft": {
        const to = this.cfg.hubProfile;
        const body = [
          `このメールへの返信の**下書き**を作ってください。**送信はしない**（送るのは${config.ownerName}）。下書きを作ったら、件名と本文の要点をこのカードのコメントに書いて完了にする。`,
          note ? `${config.ownerName}から: ${note}` : "",
          t.body,
          ref,
        ].filter(Boolean).join("\n\n");
        const created = await this.createCard(`返信の下書き: ${t.title}`, body, to, files);
        tasks.linkKanban(id, created, to, note, "app");
        return;
      }
      case "kanban":
      case "handle": {
        const to = t.agent ?? this.cfg.hubProfile;
        if (INBOX_ASSIGNEES.includes(to.toLowerCase())) throw new Error("任せる先が、オーナー宛てになっている");
        const body = [note, t.body, ref, "（Plasmod のタスクで「任せる」を選んだ）"].filter(Boolean).join("\n\n");
        const created = await this.createCard(t.title, body, to, files);
        tasks.linkKanban(id, created, to, note, "app");
        return;
      }
      default:
        throw new Error(`タスクのカードに ${optionId} は使えない`);
    }
  }

  private async apply(card: Card, optionId: string, note: string, files: { name: string; data: Uint8Array }[] = []) {
    if (card.appTaskId) return this.applyAppTask(card, optionId, note, files);
    if (isInboxKind(card.kind)) return this.applyInbox(card, optionId, note, files);
    const extra = note ? `\n\n${note}` : "";
    // どの種類にもある「自分でやる」「不要」: カンバンのカードは片付け、メモは閉じる（タスクの状態は recordDecision で）
    if ((optionId === "mine" || optionId === "dismiss") && (card.kind === "blocked" || card.kind === "review" || card.kind === "triage")) {
      await this.source.comment(card.taskId!, `${sign()}: ${optionId === "mine" ? "自分でやる（このカードは片付ける）" : "不要"}。${extra}`);
      await this.source.archive(card.taskId!);
      return;
    }
    if (optionId === "mine" && card.kind === "note") return void this.store.finishNote(Number(card.key.slice("note:".length)));
    if (card.kind === "triage") {
      // 仕分け: 担当を決めて進める／不要（アーカイブ）。ひとことはカンバンのカードに残す
      if (note) await this.source.comment(card.taskId!, `${sign()}: ${note}`);
      if (optionId === "archive") return void (await this.source.archive(card.taskId!));
      const to = optionId.startsWith("to-") ? optionId.slice(3) : "";
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(to)) throw new Error(`仕分けに ${optionId} は使えない`);
      return void (await this.source.specify(card.taskId!, to));
    }
    switch (`${card.kind}:${optionId}`) {
      case "blocked:approve":
        await this.source.comment(card.taskId!, `${sign()}: 承認。進めてください。${extra}`);
        await this.source.unblock(card.taskId!);
        return;
      case "blocked:revise":
        await this.source.comment(card.taskId!, `${sign()}: ${note}`);
        await this.source.unblock(card.taskId!);
        return;
      case "review:complete":
        if (note) await this.source.comment(card.taskId!, `${sign()}: ${note}`);
        await this.source.complete(card.taskId!, `${sign()}が確認して完了にした。${extra}`);
        return;
      case "review:changes":
        await this.source.requestChanges(card.taskId!, `${sign()}: ${note}`);
        return;
      case "note:done":
        this.store.finishNote(Number(card.key.slice("note:".length)));
        return;
      case "permission:allow":
      case "permission:deny":
        if (card.key.startsWith("hperm:")) {
          if (!this.approvals) throw new Error("Hermes のセッションがつながっていない");
          return this.approvals.answerApproval(card.requestId!, optionId === "allow" ? "once" : "deny");
        }
        if (!this.bridge) throw new Error("plasmod-bridge が設定されていない");
        this.bridge.verdict(card.thread!, card.requestId!, optionId === "allow" ? "allow" : "deny");
        return;
      default:
        throw new Error(`${card.kind} に ${optionId} は使えない`);
    }
  }
}
