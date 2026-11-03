/** 本文が上限を超えた */
export class BodyTooLargeError extends Error {}

/**
 * 本文を文字列で読む。上限を超えたら BodyTooLargeError。
 * content-length が無い（チャンク転送）場合や嘘の場合でも、実際に読んだ量で止める
 * @param message リクエストか、上流からの応答
 */
export async function readLimited(message: Request | Response, max: number): Promise<string> {
  const declared = Number(message.headers.get('content-length') ?? 0);
  if (declared > max) {
    await message.body?.cancel().catch(() => {});
    throw new BodyTooLargeError();
  }
  if (!message.body) return '';
  const reader = message.body.getReader();
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

/**
 * リクエストの本文を JSON として読む。大きすぎれば 413、JSON でなければ 400 の Response
 * （空の本文も 400。中身の形は呼び出し側で確かめる）
 */
export async function readJson(req: Request, max: number): Promise<{ value: unknown } | Response> {
  try {
    return { value: JSON.parse(await readLimited(req, max)) as unknown };
  } catch (e) {
    if (e instanceof BodyTooLargeError) return Response.json({ error: 'too large' }, { status: 413 });
    return Response.json({ error: 'bad request' }, { status: 400 });
  }
}

/** JSON のオブジェクトなら、そのまま。それ以外（配列・null・数など）は空のオブジェクト */
export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
