// タスクをすぐ足す欄。スマホのキーボードの確定キーは keydown で Enter と分からないことがあるので、
// フォームの送信で受ける。キーボードに頼らなくても足せるように、＋は押せるボタンにする。
import type { Ref } from "react";

export function AddField({ value, onChange, onAdd, placeholder, className, inputClassName, inputRef }: { value: string; onChange: (v: string) => void; onAdd: () => void; placeholder: string; className: string; inputClassName: string; inputRef?: Ref<HTMLInputElement> }) {
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        onAdd();
      }}
    >
      {/* 押してもキーボードを閉じない（続けて足せるように） */}
      <button type="submit" aria-label={placeholder} onPointerDown={(e) => e.preventDefault()} className="-my-1 -ml-2 flex size-9 flex-none items-center justify-center text-[18px] leading-none text-mute">
        <span aria-hidden="true">＋</span>
      </button>
      <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} enterKeyHint="done" aria-label={placeholder} placeholder={placeholder} className={inputClassName} />
    </form>
  );
}
