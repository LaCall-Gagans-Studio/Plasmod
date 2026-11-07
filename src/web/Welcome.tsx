// 初回の案内。呼び名、つながっているエージェント、チーム、通知とアプリを順に確かめる。あとからすべて設定で変えられる。
import { useEffect, useState } from "react";
import type { RuntimeKind, Team } from "../shared/types";
import { t, lang, setLang } from "./i18n";
import { finishSetup, getAbout, saveOwner } from "./identity";

interface SetupInfo {
  agents: { id: string; name: string; available: boolean; runtime: RuntimeKind }[];
  teams: Team[];
  github: boolean;
  rootd: boolean;
  publicUrl: string;
}

const STEPS = ["はじめに", "エージェント", "チーム", "通知とアプリ"];

function Row({ ok, title, note }: { ok: boolean | null; title: string; note?: string }) {
  return (
    <li className="flex items-start gap-2.5 rounded-xl border border-line bg-panel px-3 py-2.5 text-[13.5px]">
      <span className={`mt-1 size-2.5 flex-none rounded-full ${ok === null ? "bg-line-2" : ok ? "bg-lime" : "bg-orange"}`} aria-hidden="true" />
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold">{title}</span>
        {note && <span className="text-[12px] text-mute">{note}</span>}
      </span>
    </li>
  );
}

export function Welcome() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(getAbout().ownerIsDefault ? "" : getAbout().owner);
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    fetch("/api/setup")
      .then((r) => r.json())
      .then((b: SetupInfo) => setInfo(b))
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  useEffect(() => void load(), []);

  const next = async () => {
    setError(null);
    try {
      if (step === 0 && name.trim() && name.trim() !== getAbout().owner) await saveOwner(name.trim());
      if (step === STEPS.length - 1) return await finishSetup();
      setStep((x) => x + 1);
      void load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const ready = (info?.agents ?? []).filter((a) => a.available);
  return (
    <main className="mx-auto flex h-full w-full max-w-[520px] flex-col gap-4 overflow-y-auto px-5 pb-[max(env(safe-area-inset-bottom),20px)] pt-[max(env(safe-area-inset-top),24px)]">
      <div className="flex items-center gap-1.5" role="status" aria-label={`${step + 1} / ${STEPS.length}`}>
        {STEPS.map((s, i) => <span key={s} className={`h-1 flex-1 rounded-full ${i <= step ? "bg-ink" : "bg-line"}`} />)}
      </div>
      <h1 className="m-0 text-[26px] font-bold leading-tight">{step === 0 ? t("Plasmod へようこそ") : t(STEPS[step])}</h1>
      {error && <div className="rounded-xl bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}

      {step === 0 && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[14px] leading-relaxed text-ink-2">{t("AI エージェントのチームを、ここから指揮します。最初に少しだけ確かめます。あとからすべて設定で変えられます。")}</p>
          <label className="flex flex-col gap-1.5 text-[13px] text-mute">
            {t("あなたの呼び名")}
            <input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className="h-12 rounded-xl border border-line-2 bg-panel px-3.5 text-[16px] text-ink outline-none focus:border-ink" />
          </label>
          <div className="flex gap-1.5" role="radiogroup" aria-label={t("言語")}>
            {(["ja", "en"] as const).map((l) => (
              <button key={l} role="radio" aria-checked={lang === l} onClick={() => lang !== l && setLang(l)} className={`min-h-10 flex-1 rounded-full text-[13px] ${lang === l ? "bg-ink font-bold text-paper" : "border border-line-2 text-ink-2"}`}>
                {l === "ja" ? "日本語" : "English"}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[14px] leading-relaxed text-ink-2">{t("Hermes のプロファイルが、エージェントとして自動で並びます。名前や顔は設定で変えられます。")}</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {info === null && <Row ok={null} title={t("確かめています…")} />}
            {info?.agents.map((a) => <Row key={a.id} ok={a.available} title={a.name} note={a.runtime === "claude-code" ? "Claude Code" : "Hermes"} />)}
          </ul>
          {info && ready.length === 0 && (
            <div className="rounded-xl border border-line-2 px-3 py-2.5 text-[13px] leading-relaxed text-ink-2">
              {t("エージェントが見つかりません。Hermes の .env に API_SERVER_KEY があるか確かめて、gateway とアプリを再起動してください。あとからでも構いません。")}
              <button onClick={() => void load()} className="mt-2 block rounded-full border border-line-2 px-3 py-1.5 text-[12.5px]">{t("もう一度確かめる")}</button>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[14px] leading-relaxed text-ink-2">{t("エージェントはチームに分けられます。最初から2つの例が入っています。名前を変えても、足しても、消しても構いません。")}</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {info?.teams.map((x) => (
              <li key={x.id} className="flex items-center gap-2.5 rounded-xl border border-line bg-panel px-3 py-2.5 text-[13.5px]">
                <span className="size-3 flex-none rounded-full" style={{ background: x.color }} aria-hidden="true" />
                <span className="flex-1 font-semibold">{x.name}</span>
                <span className="text-[12px] text-mute">{x.delegable ? t("仕事を任せられる") : ""}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 text-[12.5px] text-mute">{t("変えるときは 設定 → エージェント から。")}</p>
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-3">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            <Row ok={info ? !!info.publicUrl : null} title={t("アプリの住所")} note={info?.publicUrl || t("未設定（PLASMOD_PUBLIC_URL）")} />
            <Row ok={info?.rootd ?? null} title={t("root 作業の承認")} note={t("エージェントの root の依頼を、パスワードで承認します")} />
            <Row ok={info?.github ?? null} title="GitHub" note={info?.github ? t("PR がタスクになります") : t("任意。設定すると PR がタスクになります")} />
          </ul>
          <p className="m-0 text-[13px] leading-relaxed text-ink-2">{t("Android では、GitHub の Releases からアプリを入れて、最初の画面に上の住所を入れてください。通知もアプリで受け取ります。スマホの Tailscale をオンにしておいてください。")}</p>
        </div>
      )}

      <div className="mt-auto flex gap-2 pt-2">
        {step > 0 && <button onClick={() => setStep((x) => x - 1)} className="min-h-12 flex-1 rounded-full border border-line-2 text-[14px] text-ink-2">{t("戻る")}</button>}
        <button onClick={() => void next()} disabled={step === 0 && !name.trim()} className="min-h-12 flex-[2] rounded-full bg-ink text-[14px] font-bold text-paper disabled:opacity-40">{step === STEPS.length - 1 ? t("はじめる") : t("次へ")}</button>
      </div>
    </main>
  );
}
