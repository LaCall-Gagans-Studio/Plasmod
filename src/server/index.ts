import { join, relative } from "node:path";
import { createApp } from "./app";
import { tailscaleEnv } from "./auth";
import { BridgeClient } from "./bridge";
import { findProfile } from "../shared/types";
import { config } from "./config";
import { Hub } from "./hub";
import { BrokerSource, FixtureSource } from "./kanban";
import { Notifier } from "./notify";
import { NotifyFeed } from "./notify-feed";
import { DevService, GitHub } from "./dev";
import { MergeDesk } from "./merge";
import { HermesApi, parseHermesApi, SessionService } from "./sessions";
import { SessionIndexer } from "./session-index";
import { ConnectionWatch } from "./connections";
import { UsageAlert } from "./usage-alert";
import { AppSettings, ProfileRegistry } from "./profiles";
import { ShareStore } from "./share";
import { MediaService } from "./media";
import { MemoStore } from "./memos";
import { TaskStore } from "./tasks";
import { ProjectStore } from "./projects";
import { TeamStore } from "./teams";
import { WebPush } from "./webpush";
import { HabitStore } from "./habits";
import { TaskSync } from "./task-sync";
import { agentUids, MemoSpool } from "./memo-spool";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { parsePlans, SystemService } from "./system";
import { WatchService } from "./watch";
import { RootClient } from "./root";
import { Store } from "./store";

const store = new Store(join(config.dataDir, "plasmod.db"));
const source = config.kanbanSource === "fixture" ? new FixtureSource(config.fixturePath) : new BrokerSource(config.brokerCmd);
const bridge = new BridgeClient(config.bridgeSock);
const feed = new NotifyFeed(store.db);
const notifier = new Notifier(config, store, feed);
// Web Push の差出人は住所が要る（Apple は localhost を断る）
const webPush = new WebPush(store.db, config.publicUrl || config.repoUrl || "https://github.com/LaCall-Gagans-Studio/Plasmod");
webPush.attach(feed);
const hub = new Hub(config, source, store, bridge, notifier);

// 認証なしの開発モードを、外に出さない
if (config.devNoAuth && (!["127.0.0.1", "localhost", "::1"].includes(config.host) || config.tailscaleSock)) {
  console.error("PLASMOD_DEV_NO_AUTH は 127.0.0.1 でだけ使える（Tailscale の入口とは併用しない）");
  process.exit(1);
}

if (!config.devNoAuth && config.allowedLogins.length === 0) {
  console.warn("PLASMOD_ALLOWED_LOGINS が空なので、tailnet からのアクセスはすべて 403 になる");
}

bridge.start();
hub.start();

// serveStatic は cwd からの相対パスを取る
const webRoot = relative(process.cwd(), join(import.meta.dir, "../../dist/web")) || ".";
const hermes = new Map([...parseHermesApi(config.hermesApi)].map(([id, ep]) => [id, new HermesApi(id, ep)]));
const sessions = new SessionService(bridge, hermes, () => hub.changed(), (id) => {
  const p = findProfile(config.profiles, id);
  return p ? config.profiles.indexOf(p) : config.profiles.length;
}, source instanceof BrokerSource ? (files) => source.putFiles(files) : null, () => existsSync(config.bridgeSock));
sessions.onReply((agent, id, text) => notifier.reply(agent, id, text));
config.ownerName = new AppSettings(store.db).get("owner") ?? config.ownerName;
const teams = new TeamStore(store.db, config.teams);
const registry = new ProfileRegistry(store.db, config.profiles, () => existsSync(config.bridgeSock));
// API の窓口があるプロファイルだけでなく、Hermes のプロファイル全部を見つける。
// 設定画面のカードは全部に出るのに、チームなどを保存できるのが窓口のあるものだけだった（#29）
let hermesProfiles: string[] = [];
const discover = () => registry.setDiscovered([...new Set([...hermes.keys(), ...hermesProfiles])]);
discover();
// PLASMOD_HERMES_API を書いていなければ、Hermes のプロファイルと API キーを仲介から読む。
// 起動時と、設定画面の「再検出」で同じ処理を使う（#35）。読めなかったときは今の一覧をそのまま残す
if (source instanceof BrokerSource) {
  const broker = source;
  const load = async () => {
    const found = Object.keys(JSON.parse(await broker.call("models")) as Record<string, unknown>);
    const eps = config.hermesApi ? null : parseHermesApi(await broker.call("endpoints"));
    hermesProfiles = found;
    if (eps) for (const [id, ep] of eps) if (!hermes.has(id)) hermes.set(id, new HermesApi(id, ep));
    discover();
    hub.changed();
  };
  registry.setRefresher(load);
  // 起動直後に仲介がまだ起きていないことがあるので、失敗したら少し待って数回やり直す
  const boot = (n: number) =>
    load().catch((e) => {
      console.warn("Hermes のプロファイルの一覧を読めない", e instanceof Error ? e.message : e);
      if (n < 3) setTimeout(() => boot(n + 1), 15_000 * 2 ** n).unref?.();
    });
  void boot(0);
}
new SessionIndexer(sessions, hub.search, (agent) => store.sessionMarks(agent)).start();
const dev = new DevService(config.githubToken ? new GitHub(config.githubToken, fetch, config.githubApi) : null, config.githubOwner);
const shares = new ShareStore(join(config.dataDir, "shares"));
setInterval(() => shares.sweep(), 3600_000);
const system = new SystemService(
  bridge,
  source instanceof BrokerSource ? source.call : null,
  parsePlans(config.plans),
  (id) => config.profiles.find((p) => p.id === id)?.name ?? id,
);
system.claudeEnabled = () => existsSync(config.bridgeSock);
system.startSeries();
const media = new MediaService({ bridge, hermesRead: source instanceof BrokerSource ? (p) => source.readFile(p) : null });
const rootd = new RootClient(config.rootdSock);
const watch = new WatchService(source instanceof BrokerSource ? source.call : null, config.profiles);
const memos = new MemoStore(store.db);
const tasks = new TaskStore(store.db, config.taskRefPrefix);
const projects = new ProjectStore(store.db, memos, tasks);
const habits = new HabitStore(store.db);
hub.setTasks(tasks);
dev.onPrs = (prs, complete) => {
  if (tasks.syncPrs(prs, complete)) hub.changed();
};
dev.start();
const merge = new MergeDesk(store.db, () => dev.snapshot().prs, tasks, config.githubMergeToken ? new GitHub(config.githubMergeToken, fetch, config.githubApi) : null, config.mergeMethod);
// マージの依頼は、Hermes の承認と同じ承認カードに出す（許可＝マージ・拒否＝取り下げ）
hub.setApprovals({
  pendingApprovals: () => [...sessions.pendingApprovals(), ...merge.approvals()],
  answerApproval: (id, choice) => (id.startsWith("merge:") ? merge.answer(id, choice) : sessions.answerApproval(id, choice)),
});
merge.onRequest = () => hub.changed();
merge.onMerged = () => {
  void dev.refresh();
  hub.changed();
};
if (config.memoSpool) {
  const agents = agentUids(config.memoAgents, readFileSync("/etc/passwd", "utf8"));
  new MemoSpool(memos, config.memoSpool, agents, tasks, () => hub.changed(), habits, merge).start();
  console.log(`メモの受け渡し: ${config.memoSpool}（${[...agents.values()].join(", ") || "使えるユーザーなし"}）`);
}
const taskSync = new TaskSync(tasks, config.githubToken ? new GitHub(config.githubToken, fetch, config.githubApi) : null, {
  owner: config.githubOwner,
  teamKey: config.taskRefPrefix,
  closeByPr: config.taskCloseByPr,
});
taskSync.start(() => hub.changed());
new UsageAlert(store.db, () => system.credits(), (n) => feed.add({ kind: "system", key: n.key, title: n.title, message: n.message, priority: 4, path: "#/system", actions: [] })).start();
const connections = new ConnectionWatch(store.db, () => system.connectionsRaw(), (n) => feed.add({ kind: "system", key: n.key, title: n.title, message: n.message, priority: 4, path: "#/settings?tab=connections", actions: [] }));
connections.start();
const app = createApp(config, hub, store, webRoot, { registry, sessions, dev, merge, shares, system, media, rootd, watch, memos, tasks, habits, teams, webPush, taskSync, projects, feed, connections });

export default {
  hostname: config.host,
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 0,
};

console.log(`plasmod: http://${config.host}:${config.port} (kanban=${config.kanbanSource})`);

// Tailscale の入口（tailscale serve --https=8443 unix:<ソケット>）。ソケットは 0660・持ち主はアプリ（tailscaled は root なので開ける）
if (config.tailscaleSock) {
  // VPS 自身の tailnet の住所。読めなければ Tailscale の入口は全部断る（fail closed）
  const ips = Bun.spawnSync(["tailscale", "ip"], { stdout: "pipe", stderr: "pipe" });
  const self = ips.exitCode === 0 ? ips.stdout.toString().split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  config.tailscaleSelfIps = self.length ? self : ["*"];
  if (!self.length) console.error("tailscale ip が読めない: Tailscale の入口はすべて断る");
  rmSync(config.tailscaleSock, { force: true });
  // SSE（/api/stream）を切らないよう idleTimeout は 0（TCP と同じ）。Bun の型は unix のとき idleTimeout を許さないが、実際には効く
  // （server.timeout(req, 0) では切れた。2026-11-04 に curl --unix-socket で 35 秒以上つながることを確認）
  const tsOptions = { unix: config.tailscaleSock, fetch: (req: Request) => app.fetch(req, tailscaleEnv()), idleTimeout: 0 };
  Bun.serve(tsOptions as unknown as Parameters<typeof Bun.serve>[0]);
  chmodSync(config.tailscaleSock, 0o660);
  console.log(`Tailscale の入口: ${config.tailscaleSock}`);
}
