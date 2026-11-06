import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentProfile, CLAUDE_AGENT, DEFAULT_TEAMS, type Team } from "../shared/types";

const env = (k: string, d = "") => process.env[k] ?? d;

// エージェントの名前・並び・顔は PLASMOD_PROFILES で決める（例: deploy/profiles.example.json）。無ければこの2つ
const DEFAULT_PROFILES: AgentProfile[] = [
  { id: "default", name: "アシスタント", initial: "ア", color: "#8FB8FF", role: "WINGMAN", osUser: "hermes" },
  { id: CLAUDE_AGENT, name: "開発", initial: "開", color: "#E8A27C", role: "DEVELOPER", runtime: "claude-code", osUser: "cc" },
];

/** PLASMOD_PROFILES に別名・顔の画像が書かれていなければ、同じ id の既定のものを足す（別名で来ても同じ名前で出すため） */
export function withDefaults(list: AgentProfile[]): AgentProfile[] {
  return list.map((p) => {
    const d = DEFAULT_PROFILES.find((x) => x.id === p.id);
    return { ...p, aliases: p.aliases ?? d?.aliases, avatar: p.avatar ?? d?.avatar, team: p.team ?? d?.team, runtime: p.runtime ?? d?.runtime, osUser: p.osUser ?? d?.osUser, role: p.role ?? d?.role };
  });
}

function profiles(): AgentProfile[] {
  const raw = env("PLASMOD_PROFILES");
  if (!raw) return DEFAULT_PROFILES;
  try {
    return withDefaults(JSON.parse(raw) as AgentProfile[]);
  } catch {
    console.warn("PLASMOD_PROFILES が JSON として読めないので既定値を使う");
    return DEFAULT_PROFILES;
  }
}

export const config = {
  /** アプリで呼ぶときの持ち主の名前 */
  ownerName: env("PLASMOD_OWNER_NAME", "オーナー") as string,
  /** 設定の VPS に出す追加のサービス（カンマ区切りの glob）。例: my-*.service */
  extraUnits: env("PLASMOD_EXTRA_UNITS").split(",").map((s) => s.trim()).filter(Boolean),
  /** カンバンでオーナー宛てとして扱う担当（owner・me のほかに） */
  ownerAssignees: env("PLASMOD_OWNER_ASSIGNEES").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** 設定の「このアプリについて」に出す: 開発者とリポジトリ */
  developer: env("PLASMOD_DEVELOPER"),
  repoUrl: env("PLASMOD_REPO_URL"),
  port: Number(env("PLASMOD_PORT", "8790")),
  host: env("PLASMOD_HOST", "127.0.0.1"),
  dataDir: env("PLASMOD_DATA_DIR", join(homedir(), ".plasmod")),
  /** 通してよいログイン（Tailscale のログイン名） */
  allowedLogins: env("PLASMOD_ALLOWED_LOGINS").split(",").map((s) => s.trim()).filter(Boolean),
  /**
   * Tailscale の入口の unix ソケット（tailscale serve の転送先）。空なら開かない。
   * ここから来たリクエストだけ Tailscale-User-Login を信用する（ソケットは tailscaled とアプリしか開けない）
   */
  tailscaleSock: env("PLASMOD_TAILSCALE_SOCK"),
  /** VPS 自身の tailnet の住所（ここから来たものは通さない）。起動のとき `tailscale ip` で埋める。"*" は「分からない＝全部断る」 */
  tailscaleSelfIps: ["*"] as string[],
  /** 開発用: 認証を切る（127.0.0.1 からのアクセスだけ） */
  devNoAuth: env("PLASMOD_DEV_NO_AUTH") === "1",
  /** カンバンの取得元: "broker"（本番）か "fixture"（開発） */
  kanbanSource: env("PLASMOD_KANBAN_SOURCE", "broker") as "broker" | "fixture",
  brokerCmd: env("PLASMOD_BROKER_CMD", "sudo -n -u hermes /usr/local/bin/plasmod-broker").split(" "),
  fixturePath: env("PLASMOD_FIXTURE", join(import.meta.dir, "../../fixtures/board.json")),
  pollMs: Number(env("PLASMOD_POLL_MS", "5000")),
  bridgeSock: env("PLASMOD_BRIDGE_SOCK", join(homedir(), ".plasmod-bridge", "app.sock")),
  /** 外の送り手（自動デプロイ・plasmod-rootd）が知らせの受け口（/notify-relay）に付けるトークン */
  relayToken: env("PLASMOD_NOTIFY_TOKEN"),
  /** 既読にならないときの再通知の間隔（分）と回数 */
  renotifyMin: Number(env("PLASMOD_RENOTIFY_MIN", "15")),
  renotifyMax: Number(env("PLASMOD_RENOTIFY_MAX", "3")),
  /** 「あとで」で隠す時間（分） */
  snoozeMin: Number(env("PLASMOD_SNOOZE_MIN", "180")),
  profiles: profiles(),
  /** チーム。TeamStore が保存した内容に入れ替える */
  teams: [...DEFAULT_TEAMS] as Team[],
  /** Hermes の API サーバー（プロファイルごとの URL とキー）。JSON。例は deploy/env.example */
  hermesApi: env("PLASMOD_HERMES_API"),
  /** Dev ページ: GitHub の読み取り専用トークン、対象の org、デプロイの状況を見るリポジトリ（カンマ区切り） */
  githubToken: env("PLASMOD_GITHUB_TOKEN"),
  githubOwner: env("PLASMOD_GITHUB_OWNER"),
  githubApi: env("PLASMOD_GITHUB_API", "https://api.github.com"),
  /** システム画面の月額の内訳。JSON: [{"name":"Claude Pro","usd":20},{"name":"Nous","usd":100}] */
  plans: env("PLASMOD_PLANS"),
  /** タスクの番号の頭（TASK-123 の TASK） */
  taskRefPrefix: env("PLASMOD_TASK_PREFIX", "TASK"),
  /** root 作業の承認（plasmod-rootd）の承認用ソケット */
  rootdSock: env("PLASMOD_ROOTD_SOCK", "/run/plasmod-rootd/app.sock"),
  hubProfile: env("PLASMOD_HUB_PROFILE", "default"),
  /** AI からメモを読み書きする受け渡しのフォルダ（空なら使わない）。例: /var/lib/plasmod-spool/memo */
  memoSpool: env("PLASMOD_MEMO_SPOOL"),
  /** 受け渡しを使ってよい OS のユーザーと、記録に残す名前（user=名前,…） */
  memoAgents: env("PLASMOD_MEMO_AGENTS", "cc=dev,hermes=hermes"),
  /** マージされた PR の「Closes TASK-N」で、取り込んだタスクを済みにする（PLASMOD_GITHUB_TOKEN があるときだけ）。止めるなら 0 */
  taskCloseByPr: env("PLASMOD_TASK_CLOSE_BY_PR", "1") === "1",
};

export type Config = typeof config;
