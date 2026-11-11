// 長押しで下から出るメニューの共通の部品。チャットの一覧とタスクで同じ見た目にする。
// 浮いたカード（スマホは下、広い画面は真ん中）に、見出し・大きなボタンの列・行を並べ、消す操作は別のかたまりに分ける。
import { type ReactNode, useState } from "react";

const PATHS: Record<string, ReactNode> = {
  open: <path d="M5 12h14M13 6l6 6-6 6" />,
  pin: <path d="M15 3l6 6-3 1-4 4 1 5-2 2-4.5-4.5L4 21l-1-1 4.5-4.5L3 11l2-2 5 1 4-4z" />,
  rename: <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  archive: (
    <>
      <rect x="3.5" y="4.5" width="17" height="4" rx="1" />
      <path d="M5.5 8.5V19a1 1 0 001 1h11a1 1 0 001-1V8.5M10 12.5h4" />
    </>
  ),
  undo: <path d="M8 5L4 9l4 4M4 9h10a6 6 0 010 12h-3" />,
  skip: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M6 6l12 12" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  download: <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />,
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M5 18l5-5 3 3 3-3 3 3" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  pause: <path d="M9 5v14M15 5v14" />,
  play: <path d="M8 5l11 7-11 7z" />,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  retry: <path d="M20 5v5h-5M4 19v-5h5M5.6 9A7 7 0 0118 7.5L20 10M18.4 15A7 7 0 016 16.5L4 14" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
};

export function Glyph({ name, size = 20 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="gh-sheet-back absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={label} className="gh-sheet relative mx-2 mb-[max(env(safe-area-inset-bottom),8px)] flex w-full max-w-[420px] flex-col gap-2 sm:mb-0">
        {children}
      </div>
    </div>
  );
}

/** 白いかたまり1つ */
export function SheetCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`overflow-hidden rounded-[22px] bg-panel shadow-[0_12px_40px_rgba(0,0,0,0.18)] ${className}`}>{children}</div>;
}

const TILE = "flex min-h-[68px] min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-2xl bg-chip/70 px-1 py-2 text-[11.5px] font-medium text-ink no-underline active:scale-[.97] transition-transform disabled:opacity-40";

/** 大きなボタンの列 */
export function Tiles({ children }: { children: ReactNode }) {
  return <div className="flex gap-1.5 p-2.5">{children}</div>;
}

export function TileButton({ icon, label, on, disabled, onClick }: { icon: keyof typeof PATHS; label: string; on?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button disabled={disabled} onClick={onClick} className={`${TILE} ${on ? "bg-lime-soft text-lime-ink" : ""}`}>
      <Glyph name={icon} />
      <span className="truncate">{label}</span>
    </button>
  );
}

export function TileLink({ icon, label, href }: { icon: keyof typeof PATHS; label: string; href: string }) {
  return (
    <a href={href} className={TILE}>
      <Glyph name={icon} />
      <span className="truncate">{label}</span>
    </a>
  );
}

/** 消す操作。ほかから離して置く */
export function DangerButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <SheetCard>
      <button disabled={disabled} onClick={onClick} className="flex min-h-[52px] w-full items-center justify-center gap-2 text-[14.5px] font-semibold text-red-ink hover:bg-chip/70 disabled:opacity-40">
        <Glyph name="trash" size={18} />
        {label}
      </button>
    </SheetCard>
  );
}

/** 消す前の確かめ */
export function ConfirmDelete({ text, busy, label = "削除する", onCancel, onConfirm }: { text: string; busy: boolean; label?: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <p className="m-0 px-0.5 text-[13.5px] leading-relaxed text-ink-2">{text}</p>
      <div className="flex gap-2">
        <button onClick={onCancel} className="h-11 flex-1 rounded-2xl bg-chip/70 text-[14px] font-medium text-ink">キャンセル</button>
        <button onClick={onConfirm} disabled={busy} className="h-11 flex-1 rounded-2xl bg-[#c2410c] text-[14px] font-semibold text-white disabled:opacity-50">{label}</button>
      </div>
    </div>
  );
}

/** 文字の代わりに絵で出すボタン（href があればリンク）。説明（aria-label と title）は必ず付ける */
export function IconButton({
  name,
  label,
  onClick,
  href,
  tone = "plain",
  size = 18,
  disabled,
  className = "",
  download,
  external,
}: {
  name: keyof typeof PATHS;
  label: string;
  onClick?: () => void;
  href?: string;
  tone?: "plain" | "chip" | "danger" | "solid";
  size?: number;
  disabled?: boolean;
  className?: string;
  download?: boolean;
  external?: boolean;
}) {
  const look = {
    plain: "text-mute hover:text-ink",
    chip: "bg-chip text-ink-2 hover:bg-line/60",
    danger: "text-mute hover:text-red-ink",
    solid: "bg-ink text-paper",
  }[tone];
  const cls = `inline-flex size-9 flex-none items-center justify-center rounded-full no-underline transition-colors disabled:opacity-40 ${look} ${className}`;
  const icon = <Glyph name={name} size={size} />;
  if (href !== undefined)
    return (
      <a href={href} aria-label={label} title={label} className={cls} {...(download ? { download: "" } : {})} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {icon}
      </a>
    );
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className={cls}>
      {icon}
    </button>
  );
}

/** 取り返しのつかない操作の前に出す警告。ask(文, 実行する関数) で開き、node を画面のどこかに置く */
export function useConfirm() {
  const [req, setReq] = useState<{ text: string; run: () => void; label?: string } | null>(null);
  const node = req && (
    <Sheet label="確認" onClose={() => setReq(null)}>
      <SheetCard>
        <ConfirmDelete
          text={req.text}
          label={req.label}
          busy={false}
          onCancel={() => setReq(null)}
          onConfirm={() => {
            const run = req.run;
            setReq(null);
            run();
          }}
        />
      </SheetCard>
    </Sheet>
  );
  return { ask: (text: string, run: () => void, label?: string) => setReq({ text, run, label }), node };
}
