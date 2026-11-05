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
import { HermesApi, parseHermesApi, SessionService } from "./sessions";
import { SessionIndexer } from "./session-index";
import { UsageAlert } from "./usage-alert";
import { AppSettings, ProfileRegistry } from "./profiles";
import { ShareStore } from "./share";
import { MediaService } from "./media";
import { MemoStore } from "./memos";
import { TaskStore } from "./tasks";
import { ProjectStore } from "./projects";
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
const registry = new ProfileRegistry(store.db, config.profiles, () => existsSync(config.bridgeSock));
registry.setDiscovered([...hermes.keys()]);
// PLASMOD_HERMES_API を書いていなければ、Hermes のプロファイルと API キーを仲介から読む
if (!config.hermesApi && source instanceof BrokerSource) {
  void source
    .call("endpoints")
    .then((out) => {
      for (const [id, ep] of parseHermesApi(out)) hermes.set(id, new HermesApi(id, ep));
      registry.setDiscovered([...hermes.keys()]);
      hub.changed();
    })
    .catch((e) => console.warn("Hermes のプロファイルを読めない", e instanceof Error ? e.message : e));
}
hub.setApprovals(sessions);
new SessionIndexer(sessions, hub.search, (agent) => store.sessionMarks(agent)).start();
const dev = new DevService(config.githubToken ? new GitHub(config.githubToken, fetch, config.githubApi) : null, config.githubOwner);
dev.start();
const shares = new ShareStore(join(config.dataDir, "shares"));
setInterval(() => shares.sweep(), 3600_000);
const system = new SystemService(
  bridge,
  source instanceof BrokerSource ? source.call : null,
  parsePlans(config.plans),
  (id) => config.profiles.find((p) => p.id === id)?.name ?? id,
);
const media = new MediaService({ bridge, hermesRead: source instanceof BrokerSource ? (p) => source.readFile(p) : null });
const rootd = new RootClient(config.rootdSock);
const watch = new WatchService(source instanceof BrokerSource ? source.call : null, config.profiles);
const memos = new MemoStore(store.db);
const tasks = new TaskStore(store.db, config.taskRefPrefix);
const projects = new ProjectStore(store.db, memos, tasks);
const habits = new HabitStore(store.db);
hub.setTasks(tasks);
if (config.memoSpool) {
  const agents = agentUids(config.memoAgents, readFileSync("/etc/passwd", "utf8"));
  new MemoSpool(memos, config.memoSpool, agents, tasks, () => hub.changed(), habits).start();
  console.log(`メモの受け渡し: ${config.memoSpool}（${[...agents.values()].join(", ") || "使えるユーザーなし"}）`);
}
const taskSync = new TaskSync(tasks, config.githubToken ? new GitHub(config.githubToken, fetch, config.githubApi) : null, {
  owner: config.githubOwner,
  teamKey: config.taskRefPrefix,
  closeByPr: config.taskCloseByPr,
});
taskSync.start(() => hub.changed());
new UsageAlert(store.db, () => system.credits(), (n) => feed.add({ kind: "system", key: n.key, title: n.title, message: n.message, priority: 4, path: "#/system", actions: [] })).start();
const app = createApp(config, hub, store, webRoot, { registry, sessions, dev, shares, system, media, rootd, watch, memos, tasks, habits, taskSync, projects, feed });

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
