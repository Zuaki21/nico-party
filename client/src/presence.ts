import type { DiscordSDK } from '@discord/embedded-app-sdk';
import type { PlaybackState } from '../../shared/protocol';
import { devlog } from './devlog';

/** Discord への送信をまとめる時間（送信回数の制限に引っかからないように） */
const DEBOUNCE_MS = 1000;
/** 経過時間の表示がこれ以上ずれたら送り直す（シークしたときなど） */
const RESEND_DRIFT_MS = 3000;
/** Discord のアクティビティの種類: 3 = 視聴中 (Watching) */
const ACTIVITY_WATCHING = 3;

type Activity = Parameters<DiscordSDK['commands']['setActivity']>[0]['activity'];

/**
 * 再生中の動画を Discord のアクティビティ（プロフィールやメンバー一覧の「〇〇を視聴中」）に表示する。
 * rpc.activities.write スコープでの認可が必要。失敗しても視聴には影響させない
 */
export function createPresence(sdk: DiscordSDK, serverNow: () => number) {
  let state: PlaybackState | null = null;
  let members = 1;
  let timer: number | undefined;
  let lastKey = '';
  let lastStart = 0;
  /**
   * 受け付けてもらえなかったら項目を減らして送り直す。
   * 0: すべて / 1: 視聴中の種類・リンクなし / 2: さらにサムネイル画像なし
   */
  let level = 0;

  const build = (): { activity: Activity; key: string; start: number } => {
    const people = `👤 ${members}人`;
    const cur = state?.current;
    if (!state || !cur) {
      return { activity: { details: '動画を選んでいます', state: people }, key: 'idle|' + members, start: 0 };
    }
    // 開始待ち（position の基準時刻が未来）の間は 0 秒として扱う
    const position = state.playing
      ? Math.max(0, state.position + (serverNow() - state.updatedAt) / 1000)
      : state.position;
    const start = Date.now() - position * 1000;
    const activity: Activity = {
      details: cur.title.slice(0, 128),
      state: state.playing ? `${people}で視聴中` : `⏸ 一時停止中 · ${people}`,
      assets: cur.thumbnail && level < 2
        ? { large_image: cur.thumbnail, large_text: [cur.title, cur.author].filter(Boolean).join(' - ').slice(0, 128) }
        : undefined,
      // 再生中だけ経過時間のバーを出す
      timestamps: state.playing
        ? { start: Math.round(start), ...(cur.length ? { end: Math.round(start + cur.length * 1000) } : {}) }
        : undefined,
    };
    if (level === 0) {
      activity.type = ACTIVITY_WATCHING;
      activity.details_url = `https://www.nicovideo.jp/watch/${cur.videoId}`;
    }
    return { activity, key: [cur.id, state.playing, members].join('|'), start };
  };

  const send = async () => {
    const { activity, key, start } = build();
    // 中身が同じで、経過時間のずれも小さければ送らない
    if (key === lastKey && Math.abs(start - lastStart) < RESEND_DRIFT_MS) return;
    try {
      await sdk.commands.setActivity({ activity });
      lastKey = key;
      lastStart = start;
    } catch (e) {
      devlog(`setActivity failed: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
      if (level < 2) {
        level++;
        lastKey = '';
        schedule();
      }
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(send, DEBOUNCE_MS);
  };

  return {
    setState(s: PlaybackState) {
      state = s;
      schedule();
    },
    setMembers(n: number) {
      members = Math.max(1, n);
      schedule();
    },
  };
}
