import type { ClientMsg } from '../../shared/protocol';

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const num = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;

/**
 * 届いたメッセージを検証して ClientMsg にする。形や範囲が合わないものは null（握りつぶす）。
 * 型だけを信じて処理すると、細工したクライアントの想定外の値でサーバーが壊れる
 */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'join':
      if (!str(m.name, 200)) return null;
      return {
        t: 'join',
        name: m.name,
        ...(str(m.clientId, 64) && /^[A-Za-z0-9-]{8,64}$/.test(m.clientId) ? { clientId: m.clientId } : {}),
      };
    case 'control':
      if (!str(m.itemId, 64) || typeof m.playing !== 'boolean' || !num(m.position, 86_400)) return null;
      return { t: 'control', itemId: m.itemId, playing: m.playing, position: m.position };
    case 'enqueue':
      return str(m.url, 500) ? { t: 'enqueue', url: m.url } : null;
    case 'remove':
    case 'jump':
      return str(m.id, 64) ? { t: m.t, id: m.id } : null;
    case 'move':
      return str(m.id, 64) && num(m.index, 10_000) ? { t: 'move', id: m.id, index: m.index } : null;
    case 'next':
      if (m.itemId !== null && !str(m.itemId, 64)) return null;
      return { t: 'next', itemId: m.itemId, ...(m.auto === true ? { auto: true } : {}) };
    case 'mode': {
      const repeat = m.repeat === 'off' || m.repeat === 'all' || m.repeat === 'one' ? m.repeat : undefined;
      const shuffle = typeof m.shuffle === 'boolean' ? m.shuffle : undefined;
      return {
        t: 'mode',
        ...(repeat !== undefined ? { repeat } : {}),
        ...(shuffle !== undefined ? { shuffle } : {}),
      };
    }
    case 'prev':
    case 'loadFailed':
    case 'loadOk':
      return str(m.itemId, 64) ? { t: m.t, itemId: m.itemId } : null;
    case 'ping':
      return num(m.clientTime, 1e15) ? { t: 'ping', clientTime: m.clientTime } : null;
    default:
      return null;
  }
}
