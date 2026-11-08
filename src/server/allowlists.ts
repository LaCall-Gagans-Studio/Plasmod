// 許可リスト（アプリを開けるログイン・切り替えられるモデル）を、画面から root の作業として書き換える。
// 中身はここで厳しく確かめ、決まった形のスクリプトにして、持ち主のパスワードで plasmod-rootd に渡す。
const LOGIN = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PROVIDER = /^[A-Za-z0-9._/-]{1,64}$/;
const MODEL = /^[A-Za-z0-9._:/@+-]{1,128}$/;

export interface ModelChoice {
  provider: string;
  model: string;
  label?: string;
  note?: string;
}
export type ModelAllowlist = Record<string, ModelChoice[]>;

export class AllowlistError extends Error {}

export function cleanLogins(v: unknown, current: string): string[] {
  if (!Array.isArray(v)) throw new AllowlistError("ログインの一覧が要る");
  const out = [...new Set(v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean))];
  if (!out.length) throw new AllowlistError("空にはできない（だれも開けなくなる）");
  if (out.length > 20) throw new AllowlistError("20 件まで");
  for (const x of out) if (x.length > 100 || !LOGIN.test(x)) throw new AllowlistError(`ログインの形が違う: ${x}`);
  if (current && !out.includes(current)) throw new AllowlistError("今のあなたのログインは消せない（開けなくなる）");
  return out;
}

const plain = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");

export function cleanModels(v: unknown): ModelAllowlist {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new AllowlistError("モデルの許可リストの形が違う");
  const out: ModelAllowlist = {};
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 32) throw new AllowlistError("プロファイルは 32 まで");
  for (const [profile, list] of entries) {
    if (!PROFILE.test(profile)) throw new AllowlistError(`プロファイル名の形が違う: ${profile}`);
    if (!Array.isArray(list) || list.length > 20) throw new AllowlistError(`${profile}: モデルは 20 件まで`);
    out[profile] = list.map((c) => {
      const x = (c ?? {}) as Record<string, unknown>;
      const provider = plain(x.provider, 64);
      const model = plain(x.model, 128);
      if (!PROVIDER.test(provider) || !MODEL.test(model)) throw new AllowlistError(`${profile}: プロバイダーかモデルの形が違う（${provider} · ${model}）`);
      const label = plain(x.label, 60);
      const note = plain(x.note, 120);
      return { provider, model, ...(label ? { label } : {}), ...(note ? { note } : {}) };
    });
  }
  return out;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** /etc/plasmod/env の PLASMOD_ALLOWED_LOGINS だけを書き換え、少し後にアプリを再起動する */
export function loginsScript(logins: string[], envFile = "/etc/plasmod/env", restart = true): string {
  const py = `import base64,os,sys
p=${JSON.stringify(envFile)}
v=base64.b64decode(${JSON.stringify(b64(logins.join(",")))}).decode()
lines=open(p,encoding="utf-8").read().split("\\n")
out=[l for l in lines if not l.startswith("PLASMOD_ALLOWED_LOGINS=")]
i=next((k for k,l in enumerate(lines) if l.startswith("PLASMOD_ALLOWED_LOGINS=")),len(out))
out.insert(min(i,len(out)),"PLASMOD_ALLOWED_LOGINS="+v)
st=os.stat(p)
t=p+".plasmod-tmp"
with open(t,"w",encoding="utf-8") as f: f.write("\\n".join(out))
os.chown(t,st.st_uid,st.st_gid); os.chmod(t,st.st_mode)
os.replace(t,p)
print("開けるログイン:",v)`;
  return [`python3 -I - <<'PLASMOD_PY'`, py, "PLASMOD_PY", restart ? "systemd-run --quiet --on-active=3 systemctl restart plasmod && echo 3 秒後にアプリを再起動する" : ""].filter(Boolean).join("\n");
}

const GH_TOKEN = /^(github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{20,255})$/;

/** GitHub のトークンの形か（空は「消す」） */
export function cleanGithubToken(v: unknown): string {
  const t = typeof v === "string" ? v.trim() : "";
  if (t && !GH_TOKEN.test(t)) throw new AllowlistError("GitHub のトークンの形ではない（github_pat_… か ghp_…）");
  return t;
}

/**
 * 秘密の値を /etc/plasmod/env の1行に入れる。値はスクリプトに書かず、アプリだけが読めるファイル（src）から root が読んで、読んだら消す。
 * root 作業の記録・題名・画面に値が残らない。src が無ければ（空の値）その行を消す
 */
export function secretEnvScript(key: string, src: string | null, envFile = "/etc/plasmod/env", restart = true): string {
  if (!/^PLASMOD_[A-Z0-9_]+$/.test(key)) throw new AllowlistError("キーの形が違う");
  const py = `import os
p=${JSON.stringify(envFile)}
k=${JSON.stringify(key)}
s=${src === null ? "None" : JSON.stringify(src)}
v=""
if s:
    with open(s,encoding="utf-8") as f: v=f.read().strip()
    os.unlink(s)
    if not v or "\\n" in v or "\\r" in v: raise SystemExit("値が空か、改行を含む")
lines=open(p,encoding="utf-8").read().split("\\n")
out=[l for l in lines if not l.startswith(k+"=")]
if v:
    i=next((n for n,l in enumerate(lines) if l.startswith(k+"=")),None)
    if i is None:
        i=len(out)-1 if out and out[-1]=="" else len(out)
    out.insert(min(i,len(out)),k+"="+v)
st=os.stat(p)
t=p+".plasmod-tmp"
with open(t,"w",encoding="utf-8") as f: f.write("\\n".join(out))
os.chown(t,st.st_uid,st.st_gid); os.chmod(t,st.st_mode)
os.replace(t,p)
print(k, "を設定した（値は表示しない）" if v else "を消した")`;
  return [`python3 -I - <<'PLASMOD_PY'`, py, "PLASMOD_PY", restart ? "systemd-run --quiet --on-active=3 systemctl restart plasmod && echo 3 秒後にアプリを再起動する" : ""].filter(Boolean).join("\n");
}

/** /etc/plasmod-models.json の、渡したプロファイルの分だけを置き換える（ほかのプロファイルの行は残す。読むのは仲介） */
export function modelsScript(models: ModelAllowlist, file = "/etc/plasmod-models.json"): string {
  const py = `import base64,json,os
p=${JSON.stringify(file)}
n=json.loads(base64.b64decode(${JSON.stringify(b64(JSON.stringify(models)))}).decode())
try:
    d=json.load(open(p,encoding="utf-8"))
    d=d if isinstance(d,dict) else {}
except (OSError,ValueError):
    d={}
d.update(n)
t=p+".plasmod-tmp"
with open(t,"w",encoding="utf-8") as f: json.dump(d,f,ensure_ascii=False,indent=2)
os.chmod(t,0o644)
os.replace(t,p)
print("モデルの許可リスト:", ", ".join(f"{k} {len(v)} 件" for k,v in n.items()) or "変更なし")`;
  return [`python3 -I - <<'PLASMOD_PY'`, py, "PLASMOD_PY"].join("\n");
}
