import type { DiscordSDK } from '@discord/embedded-app-sdk';
import type { PlaybackState } from '../../shared/protocol';
import { describeError, devlog } from './devlog';
import { getLang, onLangChange, t } from './i18n';

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
export function createPresence(sdk: DiscordSDK, serverNow: () => number, initiallyEnabled: boolean) {
  let enabled = initiallyEnabled;
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
    const cur = state?.current;
    if (!state || !cur) {
      return {
        activity: { details: t('presenceChoosing'), state: t('presencePeople', { n: members }) },
        key: ['idle', members, getLang()].join('|'),
        start: 0,
      };
    }
    // 開始待ち（position の基準時刻が未来）の間は 0 秒として扱う
    const position = state.playing
      ? Math.max(0, state.position + (serverNow() - state.updatedAt) / 1000)
      : state.position;
    const start = Date.now() - position * 1000;
    const activity: Activity = {
      details: cur.title.slice(0, 128),
      state: t(state.playing ? 'presenceWatching' : 'presencePaused', { n: members }),
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
    return { activity, key: [cur.id, state.playing, members, getLang()].join('|'), start };
  };

  const send = async () => {
    if (!enabled) return;
    const { activity, key, start } = build();
    // 中身が同じで、経過時間のずれも小さければ送らない
    if (key === lastKey && Math.abs(start - lastStart) < RESEND_DRIFT_MS) return;
    try {
      await sdk.commands.setActivity({ activity });
      // 送信中にオフにされた。遅れて完了した送信で、消したはずの表示が戻ってしまうので、もう一度消す
      if (!enabled) {
        sdk.commands.setActivity({ activity: {} }).catch(() => {});
        return;
      }
      lastKey = key;
      lastStart = start;
    } catch (e) {
      devlog(`setActivity failed: ${describeError(e)}`);
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

  // 言語が変わったら表示し直す（key に言語を含めているので送り直される）
  onLangChange(schedule);

  return {
    /** 設定画面のスイッチ。オフにしたら表示を消す */
    setEnabled(next: boolean) {
      enabled = next;
      if (next) {
        lastKey = '';
        schedule();
        return;
      }
      clearTimeout(timer);
      lastKey = '';
      // 空のアクティビティを送って、タイトルなどの表示を消す
      sdk.commands.setActivity({ activity: {} }).catch((e) => {
        devlog(`clear activity failed: ${describeError(e)}`);
      });
    },
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
