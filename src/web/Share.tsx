// 共有メニュー（#/share/<id>）から来たもの。宛先は選ばせず、チャットの入力欄に添付として載せて開く。
import { ing, Dots } from "./dots";
import { useEffect, useState } from "react";
import type { ShareInfo } from "../shared/types";
import { offerShared } from "./outbox";

export function Share({ id }: { id: string }) {
  const [error, setError] = useState<string | null>(id === "error" ? new URLSearchParams(location.hash.split("?")[1] ?? "").get("m") || "受け取れなかった" : null);

  useEffect(() => {
    if (id === "error") return;
    let alive = true;
    (async () => {
      const r = await fetch(`/api/shares/${id}`);
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      const info = (await r.json()) as ShareInfo;
      const files: File[] = [];
      for (let i = 0; i < info.files.length; i++) {
        const fr = await fetch(`/api/shares/${id}/files/${i}`);
        if (!fr.ok) throw new Error(`${info.files[i].name} を取り込めなかった`);
        files.push(new File([await fr.blob()], info.files[i].name, { type: info.files[i].type }));
      }
      const text = [info.title, info.text && info.text !== info.url ? info.text : "", info.url].filter(Boolean).join("\n");
      if (!alive) return;
      offerShared(files, text);
      await fetch(`/api/shares/${id}`, { method: "DELETE" }).catch(() => {});
      const agent = localStorage.getItem("gh-last-agent") || "default";
      location.replace(`#/session/${agent}/new`);
    })().catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <div className="mx-auto flex h-full max-w-[520px] flex-col items-center justify-center gap-4 p-6 text-center">
      {error ? (
        <>
          <p className="rounded-xl bg-orange/10 px-3 py-2 text-sm text-orange-ink" role="alert">{error}</p>
          <a href="#/" className="rounded-full border border-line-2 px-5 py-3 text-sm">チャットへ</a>
        </>
      ) : (
        <p className="text-sm text-mute">チャットに取り込んでいます<Dots /></p>
      )}
    </div>
  );
}
