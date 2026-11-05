// 長押しで下から出るメニューの共通の部品。チャットの一覧とタスクで同じ見た目にする。
// 浮いたカード（スマホは下、広い画面は真ん中）に、見出し・大きなボタンの列・行を並べ、消す操作は別のかたまりに分ける。
import type { ReactNode } from "react";

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
  undo: <path d="M8 5L4 9l4 4M4 9h10a6 6 0 010 12h-3" />,
  skip: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M6 6l12 12" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
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
export function ConfirmDelete({ text, busy, onCancel, onConfirm }: { text: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <p className="m-0 px-0.5 text-[13.5px] leading-relaxed text-ink-2">{text}</p>
      <div className="flex gap-2">
        <button onClick={onCancel} className="h-11 flex-1 rounded-2xl bg-chip/70 text-[14px] font-medium text-ink">キャンセル</button>
        <button onClick={onConfirm} disabled={busy} className="h-11 flex-1 rounded-2xl bg-[#c2410c] text-[14px] font-semibold text-white disabled:opacity-50">削除する</button>
      </div>
    </div>
  );
}
