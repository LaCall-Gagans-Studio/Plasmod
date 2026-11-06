// 新しい版が出たら、古い画面を使い続けない。インストールしたアプリ（PWA）は裏に回っても生きていて、
// 戻ってきたときに前の版の JS のまま動き続けるので、版（/api/version）を確かめて読み込み直す。
//   - アプリに戻ってきたとき（visibilitychange）に新しければ、すぐ読み込み直す（書きかけは各画面が裏に回るときに保存している）
//   - 開いたまま新しい版が出たら、上に「新しい版があります」を出す（押すと読み込み直す）
import { useSyncExternalStore } from "react";

let loaded: string | null = null;
let stale = false;
const listeners = new Set<() => void>();

async function current(): Promise<string | null> {
  try {
    const r = await fetch("/api/version", { cache: "no-store" });
    return r.ok ? ((await r.json()) as { id: string }).id : null;
  } catch {
    return null;
  }
}

async function check(reloadIfNew: boolean) {
  const id = await current();
  if (!id) return;
  if (loaded === null) {
    loaded = id;
    return;
  }
  if (id === loaded) return;
  if (reloadIfNew) return location.reload();
  if (!stale) {
    stale = true;
    for (const fn of listeners) fn();
  }
}

export function startVersionWatch() {
  void check(false);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void check(true);
      void navigator.serviceWorker?.getRegistration().then((r) => r?.update());
    }
  });
  addEventListener("online", () => void check(false));
  setInterval(() => document.visibilityState === "visible" && void check(false), 5 * 60_000);
}

/** 開いている間に新しい版が出たか */
export function useStale(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => stale,
  );
}
