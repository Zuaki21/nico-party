import { inDiscord } from '../core/env';

/**
 * ニコニコの埋め込みプレイヤーの URL。
 * Discord 内では、埋め込み HTML を自前サーバーで書き換えて配信する (server/src/nico/nico.ts)。通行証が要る。
 * Discord の外（ローカル確認用）では、ニコニコの埋め込みをそのまま使う
 */
export function nicoEmbedUrl(videoId: string, playerId: string, nicoPass: string | undefined): string {
  const params = new URLSearchParams({
    jsapi: '1',
    playerId,
    noRelatedVideo: '1',
    noShare: '1',
    persistence: '1',
  });
  // Discord 内（中継経由）では、プレイヤーはこれを元に postMessage の宛先オリジンを決める（無いと 'null//null' になる）。
  // ローカル確認用の直接埋め込みでは逆に付けるとニコニコに 403 で拒否される
  if (inDiscord) params.set('referer', location.href);
  return inDiscord
    ? `/.proxy/nico/${nicoPass ?? 'none'}/nico-embed/${videoId}?${params}`
    : `https://embed.nicovideo.jp/watch/${videoId}?${params}`;
}
