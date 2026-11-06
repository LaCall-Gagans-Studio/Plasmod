// 添付つきの送信（multipart）を読む
import type { ShareFile } from "../share";

export const readForm = async (form: FormData) => {
  const files: ShareFile[] = [];
  for (const v of form.getAll("files")) {
    if (typeof v === "string" || !v.size) continue;
    files.push({ name: v.name, type: v.type, data: new Uint8Array(await v.arrayBuffer()) });
  }
  const str = (k: string) => (typeof form.get(k) === "string" ? String(form.get(k)) : "");
  return { meta: { title: str("title"), text: str("text"), url: str("url") }, files };
};
