// 配布用のサーバーパッケージを作る（#32 段階1）。
//   bun scripts/build-release.ts <版 例 3.0.0> <出力先ディレクトリ>
// 前提: `bun install --frozen-lockfile` と `bun run build` が済んでいる。
// 出力: plasmod-<版>.tar.gz（アプリ本体: server・shared・ビルド済み画面・本番の依存）と manifest.json。
// 権限を変える部品（broker・bridge・rootd・sudoers・systemd・autodeploy）はパッケージに入れず、
// manifest の privileged に指紋だけ載せる。更新側は、これが入れてある版と違えば通常の更新とは別に確認を求める。
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** deploy/autodeploy/plasmod-deploy の HOLD_RE と同じ範囲 */
export const PRIVILEGED = ["broker", "bridge", "rootd", "deploy/sudoers", "deploy/systemd", "deploy/tmpfiles", "deploy/autodeploy", "deploy/rootd", "deploy/update"];
export const APP_FILES = ["package.json", "bun.lock", "bunfig.toml", "LICENSE", "CHANGELOG.md", "src/server", "src/shared", "dist/web"];

export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** ディレクトリの中の通常ファイルを、パス順に */
export function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) out.push(...walk(p, base));
    else if (st.isFile()) out.push(relative(base, p));
  }
  return out;
}

/** 中身の指紋。パスと各ファイルの sha256 を順に連ねたものの sha256（置き場所や時刻に左右されない） */
export function treeDigest(root: string, paths: string[]): string {
  const h = createHash("sha256");
  for (const p of paths) {
    const abs = join(root, p);
    if (!existsSync(abs)) continue;
    const files = statSync(abs).isDirectory() ? walk(abs, root) : [p];
    for (const f of files) h.update(`${f}\0${sha256(readFileSync(join(root, f)))}\n`);
  }
  return h.digest("hex");
}

export interface Manifest {
  schema: 1;
  version: string;
  commit: string;
  /** コミットの時刻（ISO）。ビルドの時刻ではない（同じ入力から同じ中身になるように） */
  commitTime: string;
  target: { os: "linux"; arch: "any" };
  runtime: { bun: string };
  package: { name: string; sha256: string; size: number };
  /** 権限を変える部品の指紋。入れてある版と違えば、通常の更新とは別の確認が要る */
  privileged: Record<string, string>;
}

async function run(cmd: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} が失敗: ${err.trim()}`);
  return out.trim();
}

export async function buildRelease(version: string, outDir: string, root = process.cwd()): Promise<Manifest> {
  if (!VERSION_RE.test(version)) throw new Error(`版は 3.0.0 の形で: ${version}`);
  for (const f of ["dist/web/index.html", "node_modules"]) if (!existsSync(join(root, f))) throw new Error(`${f} が無い。先に bun install と bun run build を`);
  const commit = await run(["git", "rev-parse", "HEAD"], root);
  const commitTime = await run(["git", "show", "-s", "--format=%cI", "HEAD"], root);
  const epoch = await run(["git", "show", "-s", "--format=%ct", "HEAD"], root);

  const stage = join(outDir, ".stage", `plasmod-${version}`);
  rmSync(join(outDir, ".stage"), { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const f of APP_FILES) {
    if (!existsSync(join(root, f))) throw new Error(`${f} が無い`);
    cpSync(join(root, f), join(stage, f), { recursive: true });
  }
  // 本番に要る依存だけを、固定の lockfile で（インストールスクリプトは動かさない）
  await run(["bun", "install", "--production", "--frozen-lockfile", "--ignore-scripts"], stage);

  const name = `plasmod-${version}.tar.gz`;
  mkdirSync(outDir, { recursive: true });
  // 順序・持ち主・時刻を固定して、同じ入力から同じ tar.gz ができるようにする
  const tar = ["tar", "--sort=name", `--mtime=@${epoch}`, "--owner=0", "--group=0", "--numeric-owner", "--format=gnu", "-cf", "-", "-C", join(outDir, ".stage"), `plasmod-${version}`];
  const raw = Bun.spawn(tar, { stdout: "pipe", stderr: "pipe" });
  const tarBytes = new Uint8Array(await new Response(raw.stdout).arrayBuffer());
  if ((await raw.exited) !== 0) throw new Error(`tar が失敗: ${await new Response(raw.stderr).text()}`);
  const gz = Bun.gzipSync(tarBytes, { level: 9 });
  writeFileSync(join(outDir, name), gz);
  rmSync(join(outDir, ".stage"), { recursive: true, force: true });

  const privileged: Record<string, string> = {};
  for (const p of PRIVILEGED) if (existsSync(join(root, p))) privileged[p] = treeDigest(root, [p]);

  const manifest: Manifest = {
    schema: 1,
    version,
    commit,
    commitTime,
    target: { os: "linux", arch: "any" },
    runtime: { bun: Bun.version },
    package: { name, sha256: sha256(gz), size: gz.length },
    privileged,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(outDir, "SHA256SUMS"), `${manifest.package.sha256}  ${name}\n`);
  return manifest;
}

if (import.meta.main) {
  const [version, outDir] = process.argv.slice(2);
  if (!version || !outDir) {
    console.error("使い方: bun scripts/build-release.ts <版> <出力先>");
    process.exit(2);
  }
  const m = await buildRelease(version, outDir);
  console.log(`${m.package.name} ${m.package.sha256} (${m.package.size} bytes)`);
}
