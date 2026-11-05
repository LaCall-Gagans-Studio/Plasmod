// Dev ページ（TASK-160）: GitHub の開いている PR・チェック・デプロイを、読み取り専用のトークンで集める。
// 書き込み（マージ・差し戻し）はしない。開発エージェントに依頼として送り、マージは従来どおり承認ボタンを通す。
import type { DevPr, DevSnapshot } from "../shared/types";
import { config } from "./config";

type Json = Record<string, unknown>;

const TASK_REF_RE = new RegExp(`\\b(?:P-)?${config.taskRefPrefix}-\\d+\\b`, "g");

/** PR 本文の「変更点」の最初の数行（なければ本文の頭）を要約として使う */
export function summarize(body: string | null | undefined): string {
  const text = (body ?? "").replace(/\r/g, "");
  const sec = text.match(/##\s*変更点\s*\n([\s\S]*?)(?:\n##\s|$)/);
  const src = (sec ? sec[1] : text).split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").replace(/\*\*/g, "").trim()).filter(Boolean);
  const s = src.slice(0, 2).join(" / ");
  return s.length > 140 ? `${s.slice(0, 139)}…` : s;
}

export function taskRefs(...texts: (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(TASK_REF_RE)) set.add(m[0]);
  return [...set];
}

export class GitHub {
  constructor(
    private token: string,
    private fetchFn: typeof fetch = fetch,
    private base = "https://api.github.com",
  ) {}

  async get(path: string): Promise<Json> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "plasmod" },
    });
    if (!res.ok) throw new Error(`GitHub ${path.split("?")[0]}: HTTP ${res.status}`);
    return (await res.json()) as Json;
  }
}

type ChecksState = DevPr["checks"]["state"];

export function checksState(runs: Json[], combined: Json | null): DevPr["checks"] {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const r of runs) {
    if (r.status !== "completed") pending++;
    else if (["success", "neutral", "skipped"].includes(String(r.conclusion))) passed++;
    else failed++;
  }
  for (const s of (combined?.statuses as Json[] | undefined) ?? []) {
    if (s.state === "success") passed++;
    else if (s.state === "pending") pending++;
    else failed++;
  }
  const state: ChecksState = failed ? "failure" : pending ? "pending" : passed ? "success" : "none";
  return { state, passed, failed, pending };
}

export class DevService {
  private cache: DevSnapshot = { prs: [], fetchedAt: 0, error: null };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private gh: GitHub | null,
    private owner: string,
    private intervalMs = 120_000,
  ) {}

  snapshot(): DevSnapshot {
    if (!this.gh) return { ...this.cache, error: "GitHub のトークン（PLASMOD_GITHUB_TOKEN）が設定されていない" };
    return this.cache;
  }

  start() {
    if (!this.gh) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<DevSnapshot> {
    if (!this.gh) return this.snapshot();
    try {
      const search = await this.gh.get(`/search/issues?q=${encodeURIComponent(`org:${this.owner} is:pr is:open archived:false`)}&per_page=30&sort=updated`);
      const items = (search.items as Json[]) ?? [];
      const prs = await Promise.all(items.map((it) => this.pr(it)));
      this.cache = { prs: prs.filter((p): p is DevPr => !!p), fetchedAt: Date.now(), error: null };
    } catch (e) {
      this.cache = { ...this.cache, error: e instanceof Error ? e.message : String(e) };
    }
    return this.cache;
  }

  private async pr(it: Json): Promise<DevPr | null> {
    const m = String(it.repository_url ?? "").match(/repos\/([^/]+\/[^/]+)$/);
    if (!m) return null;
    const repo = m[1];
    const n = Number(it.number);
    const gh = this.gh!;
    const pr = await gh.get(`/repos/${repo}/pulls/${n}`);
    const sha = String((pr.head as Json)?.sha ?? "");
    const [runs, combined] = await Promise.all([
      gh.get(`/repos/${repo}/commits/${sha}/check-runs?per_page=50`).then((r) => (r.check_runs as Json[]) ?? []).catch(() => []),
      gh.get(`/repos/${repo}/commits/${sha}/status`).catch(() => null),
    ]);
    const preview = await this.previewUrl(repo, sha);
    return {
      repo,
      number: n,
      title: String(pr.title ?? ""),
      url: String(pr.html_url ?? ""),
      author: String((pr.user as Json)?.login ?? ""),
      draft: !!pr.draft,
      updatedAt: Date.parse(String(pr.updated_at ?? "")) || 0,
      additions: Number(pr.additions ?? 0),
      deletions: Number(pr.deletions ?? 0),
      files: Number(pr.changed_files ?? 0),
      summary: summarize(pr.body as string),
      refs: taskRefs(String(pr.title ?? ""), pr.body as string, String((pr.head as Json)?.ref ?? "")),
      checks: checksState(runs, combined),
      previewUrl: preview,
    };
  }

  /** その commit のデプロイ（Vercel のプレビューなど）の URL */
  private async previewUrl(repo: string, sha: string): Promise<string | null> {
    try {
      const ds = (await this.gh!.get(`/repos/${repo}/deployments?sha=${sha}&per_page=1`)) as unknown as Json[];
      const d = Array.isArray(ds) ? ds[0] : null;
      if (!d) return null;
      const sts = (await this.gh!.get(`/repos/${repo}/deployments/${d.id}/statuses?per_page=1`)) as unknown as Json[];
      const s = Array.isArray(sts) ? sts[0] : null;
      return (s?.environment_url as string) || (s?.target_url as string) || null;
    } catch {
      return null;
    }
  }

}

/** 開発エージェントへの依頼文（マージ・差し戻し）。マージの実行は承認ボタンを通す */
export function devRequestText(action: "merge" | "revise", prs: { repo: string; number: number; url?: string }[], note: string): string {
  const list = prs.map((p) => `- ${p.repo}#${p.number}${p.url ? ` ${p.url}` : ""}`).join("\n");
  if (action === "merge")
    return `次の PR をマージしてほしい（Plasmod の Dev ページから）。CI が通っていることを確かめてから、1件ずつ承認を求めて進めて。\n${list}${note ? `\n\nメモ: ${note}` : ""}`;
  return `次の PR を差し戻し。指摘に対応して、PR を更新して。\n${list}\n\n指摘: ${note}`;
}
