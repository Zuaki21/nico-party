import { Common, type DiscordSDK } from '@discord/embedded-app-sdk';
import { describeError, devlog } from '../core/devlog';
import { proxied } from '../core/env';

/**
 * Discord にログインしてもらい、表示名を取得する。
 * @returns 表示名と、サーバーが発行した通行証（WebSocket 用・ニコニコの中継と検索用。取得できなかったときは undefined）
 */
export async function authenticate(sdk: DiscordSDK): Promise<{ name: string; pass?: string; nicoPass?: string }> {
  const authorize = (prompt?: 'none') =>
    sdk.commands.authorize({
      client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
      response_type: 'code',
      state: '',
      ...(prompt ? { prompt } : {}),
      // rpc.activities.write: 見ている動画を Discord のアクティビティ（〇〇を視聴中）に表示するため
      scope: ['identify', 'rpc.activities.write'],
    });
  // 許可済みなら確認画面なしで通る。未許可・権限が増えた人は失敗するので、確認画面を出して取り直す
  const { code } = await authorize('none').catch(() => authorize());
  const res = await fetch(proxied('/api/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // room: 通行証は、この部屋（Activity の instanceId）のものとして発行してもらう（別の部屋への使い回しを防ぐ）
    body: JSON.stringify({ code, room: sdk.instanceId }),
  });
  const { access_token, pass, nicoPass } = (await res.json()) as {
    access_token?: string;
    pass?: string;
    nicoPass?: string;
  };
  if (!access_token) throw new Error('token exchange failed');
  const { user } = await sdk.commands.authenticate({ access_token });
  return { name: user.global_name ?? user.username, pass, nicoPass };
}

/** PiP（チャットを開いて小さく表示されている状態）やグリッド表示では動画だけを表示する */
export function watchLayout(sdk: DiscordSDK, setCompact: (compact: boolean) => void) {
  sdk
    .subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', ({ layout_mode }) => {
      devlog(`layout mode ${layout_mode}`);
      // PiP と、参加者がタイル状に並ぶグリッド表示では、動画だけを枠いっぱいに出す
      setCompact(
        layout_mode === Common.LayoutModeTypeObject.PIP ||
          layout_mode === Common.LayoutModeTypeObject.GRID,
      );
    })
    .catch((e) => devlog(`layout subscribe failed: ${describeError(e)}`));
}

/**
 * 外部のページを開く。Discord 内では iframe から外のページへ移れないので、Discord の「外部リンクを開く」を使う
 * （Discord の外で開いたときは sdk が null で、普通に新しいタブで開く）
 */
export function openExternal(sdk: DiscordSDK | null, url: string) {
  if (sdk) sdk.commands.openExternalLink({ url }).catch(() => {});
  else window.open(url, '_blank', 'noopener');
}
