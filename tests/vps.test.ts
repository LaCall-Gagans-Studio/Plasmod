import { describe, expect, test } from "bun:test";
import { parseMeminfo, readVps, type HostReader } from "../src/server/vps";
import { parseCpu, parseDiskTicks, parseNetBytes, VpsSeries } from "../src/server/vps-series";

const files: Record<string, string> = {
  "/proc/loadavg": "1.32 0.88 0.62 3/408 3739687\n",
  "/proc/cpuinfo": "processor\t: 0\nmodel name\t: x\n\nprocessor\t: 1\nmodel name\t: x\n",
  "/proc/uptime": "90061.5 1000.0\n",
  "/proc/meminfo": "MemTotal:        8000000 kB\nMemFree:          500000 kB\nMemAvailable:    3000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\nHugePages_Total:       0\n",
  "/var/lib/plasmod-deploy/deployed": "890540bb1a4ee8dca37cb8d9cc66223e4545dce5\n",
};
const host: HostReader = {
  read: (p) => {
    if (p in files) return files[p];
    throw new Error(`ENOENT ${p}`);
  },
  // / と /home は同じ、/var/lib/plasmod は読めない
  statfs: (p) => {
    if (p === "/var/lib/plasmod") throw new Error("EACCES");
    return { blocks: 1000, bfree: 400, bavail: 380, bsize: 4096 };
  },
  hostname: () => "myhost",
};

const SHOW = `Type=simple
Result=success
NRestarts=0
MemoryCurrent=39800832
Id=plasmod.service
ActiveState=active
SubState=running
ActiveEnterTimestamp=@1793251387

Type=oneshot
Result=success
NRestarts=0
MemoryCurrent=[not set]
Id=my-kanban-worker.service
ActiveState=inactive
SubState=dead
ActiveEnterTimestamp=

Type=simple
Result=exit-code
NRestarts=3
MemoryCurrent=18446744073709551615
Id=ntfy.service
ActiveState=failed
SubState=failed
ActiveEnterTimestamp=@1793000000

Type=notify
Result=success
NRestarts=0
MemoryCurrent=[not set]
Id=cloudflared.service
ActiveState=inactive
SubState=dead
UnitFileState=disabled
ActiveEnterTimestamp=
`;

describe("VPS の状態", () => {
  test("meminfo は kB をバイトに", () => {
    expect(parseMeminfo(files["/proc/meminfo"])).toMatchObject({ MemTotal: 8_192_000_000, HugePages_Total: 0 });
  });

  test("負荷・メモリ・ディスク・サービス・失敗を読む", async () => {
    const calls: string[][] = [];
    const systemctl = async (...a: string[]) => {
      calls.push(a);
      if (a[0] === "list-units" && a.includes("--state=failed")) return JSON.stringify([{ unit: "ntfy.service" }]);
      if (a[0] === "list-units") return JSON.stringify([{ unit: "plasmod.service", description: "Plasmod" }, { unit: "my-kanban-worker.service" }, { unit: "ntfy.service" }, { unit: "cloudflared.service" }]);
      return SHOW;
    };
    const v = await readVps(host, systemctl);
    expect(v.hostname).toBe("myhost");
    expect(v.load).toEqual([1.32, 0.88, 0.62]);
    expect(v.cpus).toBe(2);
    expect(v.uptime).toBe(90_061_500);
    expect(v.mem).toEqual({ total: 8_192_000_000, used: 8_192_000_000 - 3_072_000_000 });
    expect(v.swap).toEqual({ total: 2_048_000_000, used: 512_000_000 });
    // 同じファイルシステムは1つ、読めないものはエラーに
    expect(v.disks).toEqual([{ path: "/", total: 4_096_000, used: 2_457_600, avail: 1_556_480 }]);
    expect(v.errors.map((e) => e.source)).toEqual(["ディスク /var/lib/plasmod"]);
    expect(v.deployed).toBe("890540bb1a4ee8dca37cb8d9cc66223e4545dce5");
    // 常駐が先、oneshot は後。無効にして止めたもの（cloudflared）は出さない
    expect(v.services.map((s) => s.unit)).toEqual(["ntfy.service", "plasmod.service", "my-kanban-worker.service"]);
    expect(v.services[1]).toMatchObject({ description: "Plasmod", active: "active", since: 1_793_251_387_000, memory: 39_800_832, oneshot: false });
    expect(v.services[0]).toMatchObject({ active: "failed", restarts: 3, memory: null });
    expect(v.services[2]).toMatchObject({ oneshot: true, since: null, memory: null });
    expect(v.failed).toEqual(["ntfy.service"]);
    // 読むだけ: list-units と show しか呼ばない
    expect(new Set(calls.map((c) => c[0]))).toEqual(new Set(["list-units", "show"]));
  });

  test("systemctl が無くても、読めたところだけ返す", async () => {
    const v = await readVps(host, async () => {
      throw new Error("no systemd");
    });
    expect(v.services).toEqual([]);
    expect(v.load).not.toBeNull();
    expect(v.errors.map((e) => e.source)).toContain("サービス");
  });
});

describe("VPS のグラフ（累計の差から出す）", () => {
  const box = (s: Record<string, string>): HostReader => ({ read: (p) => { if (p in s) return s[p]; throw new Error("ENOENT"); }, statfs: () => ({ blocks: 1, bfree: 1, bavail: 1, bsize: 1 }), hostname: () => "x" });
  test("読み取りの部品", () => {
    expect(parseCpu("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3 4\n")).toEqual({ total: 1000, idle: 800 });
    expect(parseCpu("nonsense")).toBeNull();
    expect(parseDiskTicks(" 8 0 sda 1 2 3 4 5 6 7 8 9 500 11\n 8 1 sda1 1 2 3 4 5 6 7 8 9 400 11\n 7 0 loop0 1 2 3 4 5 6 7 8 9 9 9\n259 0 nvme0n1 1 2 3 4 5 6 7 8 9 20 11\n")).toEqual({ sda: 500, nvme0n1: 20 });
    expect(parseNetBytes("Inter-|\n face |\n lo: 999 0 0 0 0 0 0 0 999 0\n eth0: 100 0 0 0 0 0 0 0 50 0\n tailscale0: 70 0 0 0 0 0 0 0 70 0\n")).toBe(150);
  });

  test("2回目から CPU・ディスク・ネットが出る。読めないものは null で、上限を超えて持たない", () => {
    const s: Record<string, string> = {
      "/proc/stat": "cpu  100 0 100 800 0 0 0 0\n",
      "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 250 kB\n",
      "/proc/diskstats": " 8 0 sda 1 2 3 4 5 6 7 8 9 1000 11\n",
      "/proc/net/dev": " eth0: 1000 0 0 0 0 0 0 0 0 0\n",
    };
    const v = new VpsSeries(box(s), 2);
    const a = v.sample(1000);
    expect(a).toEqual({ at: 1000, cpu: null, mem: 75, disk: null, net: null });
    s["/proc/stat"] = "cpu  200 0 100 900 0 0 0 0\n";
    s["/proc/diskstats"] = " 8 0 sda 1 2 3 4 5 6 7 8 9 3500 11\n";
    s["/proc/net/dev"] = " eth0: 11000 0 0 0 0 0 0 0 0 0\n";
    expect(v.sample(6000)).toEqual({ at: 6000, cpu: 50, mem: 75, disk: 50, net: 2000 });
    delete s["/proc/net/dev"];
    expect(v.sample(11000).net).toBeNull();
    expect(v.all().map((x) => x.at)).toEqual([6000, 11000]);
  });
});
