// 音声メモの本文を失わずに保存する。話した分は先に端末へ書き、つながっているときにサーバーへ送る。
export interface VoiceSaved {
  id: number;
  updatedAt: number;
}

export interface VoiceApi {
  create(title: string, body: string): Promise<VoiceSaved>;
  update(id: number, body: string, baseUpdatedAt: number): Promise<VoiceSaved>;
}

export interface DraftState {
  title: string;
  body: string;
  memoId: number | null;
  base: number | null;
  /** サーバーに届いた本文の長さ */
  savedLength: number;
}

export interface DraftStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const KEY = "gh-voice-draft";

export class VoiceDraft {
  state: DraftState;
  private saving = false;

  constructor(private api: VoiceApi, private storage: DraftStorage, title: string) {
    this.state = this.restore() ?? { title, body: "", memoId: null, base: null, savedLength: 0 };
  }

  private restore(): DraftState | null {
    try {
      const s = this.storage.getItem(KEY);
      return s ? (JSON.parse(s) as DraftState) : null;
    } catch {
      return null;
    }
  }

  private persist() {
    try {
      this.storage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* 端末に書けなくても、画面の中とサーバーには残る */
    }
  }

  append(text: string) {
    const t = text.trim();
    if (!t) return;
    this.state.body = this.state.body ? `${this.state.body}\n${t}` : t;
    this.persist();
  }

  get dirty() {
    return this.state.body.length !== this.state.savedLength;
  }

  /** サーバーへ送る。失敗したら false（本文は端末に残り、次にまた送る） */
  async save(): Promise<boolean> {
    if (this.saving || !this.dirty) return !this.dirty;
    this.saving = true;
    const body = this.state.body;
    try {
      let saved: VoiceSaved;
      if (this.state.memoId === null) saved = await this.api.create(this.state.title, body);
      else {
        try {
          saved = await this.api.update(this.state.memoId, body, this.state.base!);
        } catch (e) {
          // ほかで書き換えられていたら、上書きせず、続きを別のメモとして残す
          if ((e as { status?: number }).status !== 409) throw e;
          this.state.title = `${this.state.title}（続き）`;
          saved = await this.api.create(this.state.title, body);
        }
      }
      this.state.memoId = saved.id;
      this.state.base = saved.updatedAt;
      this.state.savedLength = body.length;
      this.persist();
      return !this.dirty;
    } catch {
      return false;
    } finally {
      this.saving = false;
    }
  }

  /** 全部届いたら端末の控えを消す。届いていなければ残す（次に開いたとき続きになる） */
  finish(): boolean {
    if (this.dirty) return false;
    try {
      this.storage.removeItem(KEY);
    } catch {
      /* 消せなくても害はない */
    }
    return true;
  }
}
