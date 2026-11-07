// 通知の設定（ブラウザ・PWA）。Android の APK は自分で受け取るので出さない。
// iPhone は、ホーム画面に追加したアプリの中でだけ通知を使える。
import { useEffect, useState } from "react";
import { t } from "./i18n";

const isApk = () => /; wv\)/.test(navigator.userAgent);
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

type State = "loading" | "unsupported" | "ios-install" | "denied" | "off" | "on";

function toKey(b64: string): Uint8Array<ArrayBuffer> {
  const raw = atob(b64.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function PushSection() {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (isIos() && !standalone()) return setState("ios-install");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return setState("unsupported");
      if (Notification.permission === "denied") return setState("denied");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return setState("off");
      const r = await fetch(`/api/push?endpoint=${encodeURIComponent(sub.endpoint)}`).then((x) => x.json() as Promise<{ subscribed: boolean }>);
      // 端末にはあるがサーバーが忘れていたら、もう一度知らせる
      if (!r.subscribed) await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
      setState("on");
    })().catch((e) => {
      setError(String(e instanceof Error ? e.message : e));
      setState("off");
    });
  }, []);

  if (isApk()) return null;

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return setState(perm === "denied" ? "denied" : "off");
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = (await (await fetch("/api/push")).json()) as { publicKey: string };
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
      const r = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setState("on");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setState("off");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const note: Record<State, string> = {
    loading: "",
    unsupported: t("このブラウザは通知に対応していません"),
    "ios-install": t("iPhone では、共有メニューの「ホーム画面に追加」から開くと通知を使えます（iOS 16.4 以降）"),
    denied: t("通知がブロックされています。端末の設定から許可してください"),
    off: t("カードや返事が来たら、この端末に通知します"),
    on: t("この端末に通知します"),
  };
  return (
    <div className="mx-4 mb-3 flex flex-col gap-1.5 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-[13px]">
      <div className="flex min-h-8 items-center gap-2">
        <span>{t("通知")}</span>
        {state === "off" && <button onClick={() => void turnOn()} disabled={busy} className="ml-auto min-h-8 rounded-full bg-ink px-3 text-[12px] font-bold text-paper disabled:opacity-50">{t("オンにする")}</button>}
        {state === "on" && <button onClick={() => void turnOff()} disabled={busy} className="ml-auto min-h-8 rounded-full border border-line-2 px-3 text-[12px] text-ink-2 disabled:opacity-50">{t("オフにする")}</button>}
      </div>
      <div className="text-[12px] text-mute">{note[state]}</div>
      {error && <div className="text-[12px] text-orange-ink" role="alert">{error}</div>}
    </div>
  );
}
