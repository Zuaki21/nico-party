/** 本文が上限を超えた */
export class BodyTooLargeError extends Error {}

/**
 * リクエストの本文を文字列で読む。上限を超えたら BodyTooLargeError。
 * content-length が無い（チャンク転送）場合や嘘の場合でも、実際に読んだ量で止める
 */
export async function readLimited(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > max) throw new BodyTooLargeError();
  if (!req.body) return '';
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
