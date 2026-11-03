import { Common, type DiscordSDK } from '@discord/embedded-app-sdk';
import { describeError, devlog } from '../core/devlog';
import { exchangeToken, type Passes } from './api';

/**
 * Discord にログインしてもらい、表示名を取得する。
 * @param interactive false なら、確認画面は出さない（許可済みでなければ失敗する。開きっぱなしの間の取り直し用）
 * @returns 表示名と、サーバーが発行した通行証。通行証が得られなければ例外（参加者でなければ NotInActivityError）
 */
export async function authenticate(sdk: DiscordSDK, interactive = true): Promise<Passes & { name: string }> {
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
  const { code } = await (interactive ? authorize('none').catch(() => authorize()) : authorize('none'));
  const { accessToken, pass, nicoPass } = await exchangeToken(code, sdk.instanceId);
  const { user } = await sdk.commands.authenticate({ access_token: accessToken });
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
