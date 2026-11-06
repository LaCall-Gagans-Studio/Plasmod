import { describe, expect, test } from "bun:test";
import { parseMeminfo, readVps, type HostReader } from "../src/server/vps";

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
