// マージの承認（3.0）。エージェントは「この PR をマージしたい」と頼むだけで、書き込みの鍵は持たない。
// オーナーが画面で承認すると、アプリがマージ用のトークン（PLASMOD_GITHUB_MERGE_TOKEN）でマージする。
// マージするのは頼まれた（画面で見た）commit だけ。後から push されていたら、CI が通っていなければ止める。
import type { Database } from "bun:sqlite";
import type { DevPr, MergeRequest } from "../shared/types";
import { checksState, type GitHub } from "./dev";
import type { TaskStore } from "./tasks";

export class MergeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Row = { id: number; repo: string; number: number; sha: string; by: string; note: string; status: MergeRequest["status"]; created_at: number; decided_at: number | null; result: string };
const toReq = (r: Row): MergeRequest => ({ id: r.id, repo: r.repo, number: r.number, sha: r.sha, by: r.by, note: r.note, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, result: r.result });
const PR_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const METHODS = ["merge", "squash", "rebase"] as const;
type Json = Record<string, unknown>;

export class MergeDesk {
  /** 依頼が来たとき（通知に使う） */
  onRequest: (r: MergeRequest, pr: DevPr) => void = () => {};
  /** マージしたとき（PR の一覧を読み直すのに使う） */
  onMerged: (r: MergeRequest) => void = () => {};
  readonly method: (typeof METHODS)[number];

  constructor(
    private db: Database,
    /** いま開いている PR（読み取りのトークンで2分ごとに集めたもの） */
    private openPrs: () => DevPr[],
    private tasks: TaskStore | null,
    /** マージ用のトークンの GitHub。無ければ承認はできない（依頼と表示だけ） */
    private writer: GitHub | null,
    method = "merge",
  ) {
    this.method = (METHODS as readonly string[]).includes(method) ? (method as (typeof METHODS)[number]) : "merge";
    db.exec(`CREATE TABLE IF NOT EXISTS merge_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, number INTEGER NOT NULL, sha TEXT NOT NULL,
      by TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at INTEGER NOT NULL,
      decided_at INTEGER, result TEXT NOT NULL DEFAULT '')`);
    db.exec("CREATE INDEX IF NOT EXISTS merge_requests_pr ON merge_requests (repo, number, status)");
  }

  get enabled(): boolean {
    return !!this.writer;
  }

  pending(): MergeRequest[] {
    return (this.db.query("SELECT * FROM merge_requests WHERE status = 'pending' ORDER BY created_at DESC").all() as Row[]).map(toReq);
  }

  /** その PR のいちばん新しい依頼（済んだものも） */
  latest(repo: string, number: number): MergeRequest | null {
    const r = this.db.query("SELECT * FROM merge_requests WHERE repo = ? AND number = ? ORDER BY id DESC LIMIT 1").get(repo, number) as Row | null;
    return r ? toReq(r) : null;
  }

  private find(pr: string): DevPr {
    const m = pr.trim().match(PR_RE);
    if (!m) throw new MergeError("PR は owner/repo#番号 の形で");
    const hit = this.openPrs().find((p) => p.repo.toLowerCase() === m[1].toLowerCase() && p.number === Number(m[2]));
    if (!hit) throw new MergeError(`開いている PR の中に無い: ${pr}（一覧は2分ごとに読み直す。作ったばかりなら少し待って）`, 404);
    return hit;
  }

  private taskOf(p: { repo: string; number: number }) {
    return this.tasks?.bySource("github", `${p.repo}#${p.number}`) ?? null;
  }

  /** エージェントからの依頼。同じ PR の古い依頼は置き換える。PR のタスクを BackLog に上げて、ホームに出す */
  request(input: { pr: string; sha?: string; note?: string }, by: string, now = Date.now()): MergeRequest {
    const pr = this.find(input.pr);
    if (pr.draft) throw new MergeError("下書きの PR はマージを頼めない");
    const sha = (input.sha ?? "").trim().toLowerCase();
    if (sha && (!SHA_RE.test(sha) || !pr.sha.startsWith(sha))) throw new MergeError(`PR の head（${pr.sha.slice(0, 7)}）と違う commit。push の後なら少し待って頼み直して`, 409);
    const note = (input.note ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, 1000);
    const req = this.db.transaction(() => {
      this.db.query("UPDATE merge_requests SET status = 'rejected', decided_at = ?, result = '新しい依頼で置き換えた' WHERE repo = ? AND number = ? AND status = 'pending'").run(now, pr.repo, pr.number);
      const r = this.db.query("INSERT INTO merge_requests (repo, number, sha, by, note, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)").run(pr.repo, pr.number, pr.sha, by, note, now);
      return toReq(this.db.query("SELECT * FROM merge_requests WHERE id = ?").get(Number(r.lastInsertRowid)) as Row);
    })();
    const t = this.taskOf(pr);
    if (t && t.status !== "done") {
      this.tasks!.setStatusBy(t.id, "inbox", `マージの承認待ち（${pr.sha.slice(0, 7)}）`, by, now);
      if (note) this.tasks!.comment(t.id, `マージの依頼: ${note}`, by, now);
    }
    this.onRequest(req, pr);
    return req;
  }

  /** 差し戻しなど。待っている依頼を閉じる */
  reject(repo: string, number: number, by: string, why: string, now = Date.now()): number {
    return this.db.query("UPDATE merge_requests SET status = 'rejected', decided_at = ?, result = ? WHERE repo = ? AND number = ? AND status = 'pending'").run(now, `${by}: ${why}`.slice(0, 500), repo, number).changes;
  }

  /**
   * オーナーの承認でマージする。sha は画面に出していた commit（依頼があればその commit）。
   * GitHub から読み直して、開いている・下書きでない・head が同じ・CI が落ちていない・走っていないことを確かめる
   */
  async approve(repo: string, number: number, sha: string, by: string, now = Date.now()): Promise<MergeRequest> {
    if (!this.writer) throw new MergeError("マージ用のトークン（PLASMOD_GITHUB_MERGE_TOKEN）が設定されていない", 404);
    if (!PR_RE.test(`${repo}#${number}`) || !SHA_RE.test(sha)) throw new MergeError("PR か commit の形が違う");
    const gh = this.writer;
    const pr = await gh.get(`/repos/${repo}/pulls/${number}`).catch(() => {
      throw new MergeError("PR を読めない（トークンの権限かリポジトリを確かめて）", 502);
    });
    const head = String((pr.head as Json)?.sha ?? "");
    if (pr.merged) throw new MergeError("もうマージされている", 409);
    if (pr.state !== "open") throw new MergeError("閉じている PR", 409);
    if (pr.draft) throw new MergeError("下書きの PR", 409);
    if (!head.startsWith(sha)) throw new MergeError(`承認のあとに新しい commit がある（${head.slice(0, 7)}）。中身を見直してから`, 409);
    if (pr.mergeable === false) throw new MergeError("コンフリクトがある", 409);
    const [runs, combined] = await Promise.all([
      gh.get(`/repos/${repo}/commits/${head}/check-runs?per_page=100`).then((r) => (r.check_runs as Json[]) ?? []).catch(() => null),
      gh.get(`/repos/${repo}/commits/${head}/status`).catch(() => null),
    ]);
    if (runs === null) throw new MergeError("CI の結果を読めない", 502);
    const checks = checksState(runs, combined);
    if (checks.state === "failure") throw new MergeError(`CI が落ちている（${checks.failed} 件）`, 409);
    if (checks.state === "pending") throw new MergeError(`CI がまだ走っている（${checks.pending} 件）`, 409);
    const res = await gh.send("PUT", `/repos/${repo}/pulls/${number}/merge`, { sha: head, merge_method: this.method });
    const pending = this.db.query("SELECT * FROM merge_requests WHERE repo = ? AND number = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(repo, number) as Row | null;
    const result = res.ok ? `${by} が承認してマージ（${String(res.body.sha ?? "").slice(0, 7)}）` : `マージできなかった: ${String(res.body.message ?? `HTTP ${res.status}`)}`;
    const status: MergeRequest["status"] = res.ok ? "merged" : "failed";
    let id: number;
    if (pending && head.startsWith(pending.sha)) {
      this.db.query("UPDATE merge_requests SET status = ?, decided_at = ?, result = ? WHERE id = ?").run(status, now, result, pending.id);
      id = pending.id;
    } else {
      // 依頼なしで、オーナーが自分で押したとき（記録だけ残す）
      if (pending && res.ok) this.db.query("UPDATE merge_requests SET status = 'rejected', decided_at = ?, result = '別の commit がマージされた' WHERE id = ?").run(now, pending.id);
      id = Number(this.db.query("INSERT INTO merge_requests (repo, number, sha, by, note, status, created_at, decided_at, result) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)").run(repo, number, head, by, status, now, now, result).lastInsertRowid);
    }
    const req = toReq(this.db.query("SELECT * FROM merge_requests WHERE id = ?").get(id) as Row);
    if (!res.ok) throw new MergeError(result, res.status === 405 || res.status === 409 ? 409 : 502);
    const t = this.taskOf({ repo, number });
    if (t && t.status !== "done") this.tasks!.setStatusBy(t.id, "done", result, by, now);
    this.onMerged(req);
    return req;
  }
}
