/**
 * 画面の文言（日本語 / 英語）。言語は設定画面で選べ、選んでいなければブラウザの言語で決める。
 * 固定の文言は HTML に data-i18n / data-i18n-title / data-i18n-placeholder を付けて applyI18n で書き換え、
 * あとから描く部分は t() で組み立てて、言語が変わったら描き直す（onLangChange）
 */

export type Lang = 'ja' | 'en';

const ja = {
  empty: '動画のURLを入れるか、キーワードで検索して再生リストに追加してください',
  nowPlaying: '▶ {title}（{name}）',
  prev: '前の動画に戻る',
  next: '次の動画へ',
  settings: '設定',
  showList: '再生リストを表示',
  hideList: '再生リストを隠す',
  resize: 'ドラッグで大きさを変更',
  inputPlaceholder: 'URL・sm番号 または キーワードで検索',
  add: '追加',
  search: '検索',
  playlist: '再生リスト',
  connecting: '接続中…',
  connectingPending: '接続中…（{n}件の操作を待機中）',
  watching: '{n}人で視聴中',
  shuffleOn: 'シャッフル: オン',
  shuffleOff: 'シャッフル: オフ',
  repeatOff: 'リピート: オフ',
  repeatAll: 'リピート: 再生リスト全体',
  repeatOne: 'リピート: 1曲',
  listEmpty: '（空です）',
  dragToReorder: 'ドラッグで並べ替え',
  playingBadge: '▶ 再生中',
  addedBy: '追加: {name}',
  playFromHere: 'ここから再生',
  removeFromList: '再生リストから削除',
  searchClose: '検索を閉じて再生リストに戻る',
  sortTitle: '並び順',
  sortPopular: '再生数',
  sortNew: '新着',
  searchQuery: '「{q}」',
  searchCount: '「{q}」 {n}件',
  searching: '検索中…',
  searchFailed: '検索に失敗しました。時間をおいて試してください',
  searchNone: '見つかりませんでした（投稿されたばかりの動画は、URL を貼ると追加できます）',
  loadMore: 'もっと見る',
  addToList: '再生リストに追加',
  added: '追加しました',
  unplayableBadge: '再生不可',
  unplayable_sensitive_video: 'センシティブな動画のため再生できません',
  unplayable_externally_unwatchable: '権利者の設定でニコニコ動画以外での再生が禁止されているため再生できません',
  unplayable_other: '埋め込みプレイヤーでは再生できない動画です',
  err_invalid_url: '動画のURLまたはIDを入力してください（例: sm9）',
  err_queue_full: '再生リストがいっぱいです',
  err_not_found: '{id} が見つかりません（削除された動画かもしれません）',
  err_unplayable: '「{title}」は{reason}',
  err_not_embeddable: '「{title}」は埋め込みが禁止されているため再生できません',
  startFailed: '起動に失敗しました: {msg}',
  settingsTitle: '設定',
  close: '閉じる',
  theme: 'テーマ',
  themeAuto: 'Discord に合わせる',
  themeLight: 'ライト',
  themeDark: 'ダーク',
  language: '言語',
  presence: 'Discord に視聴中の動画を表示',
  presenceDesc: 'プロフィールやメンバー一覧に、見ている動画のタイトルを表示します',
  settingsNote: 'これらの設定はあなたの画面だけに適用されます',
  about: 'NicoParty について',
  terms: '利用規約',
  privacy: 'プライバシーポリシー',
  presenceChoosing: '動画を選んでいます',
  presencePeople: '👤 {n}人',
  presenceWatching: '👤 {n}人で視聴中',
  presencePaused: '⏸ 一時停止中 · 👤 {n}人',
};

type Key = keyof typeof ja;

const en: Record<Key, string> = {
  empty: 'Paste a video URL or search by keyword to add it to the playlist',
  nowPlaying: '▶ {title} ({name})',
  prev: 'Previous video',
  next: 'Next video',
  settings: 'Settings',
  showList: 'Show playlist',
  hideList: 'Hide playlist',
  resize: 'Drag to resize',
  inputPlaceholder: 'URL, video ID (sm…), or keyword',
  add: 'Add',
  search: 'Search',
  playlist: 'Playlist',
  connecting: 'Connecting…',
  connectingPending: 'Connecting… ({n} pending)',
  watching: '{n} watching',
  shuffleOn: 'Shuffle: on',
  shuffleOff: 'Shuffle: off',
  repeatOff: 'Repeat: off',
  repeatAll: 'Repeat: playlist',
  repeatOne: 'Repeat: one',
  listEmpty: '(Empty)',
  dragToReorder: 'Drag to reorder',
  playingBadge: '▶ Playing',
  addedBy: 'Added by {name}',
  playFromHere: 'Play from here',
  removeFromList: 'Remove from playlist',
  searchClose: 'Close search and go back to the playlist',
  sortTitle: 'Sort',
  sortPopular: 'Views',
  sortNew: 'Newest',
  searchQuery: '"{q}"',
  searchCount: '"{q}" {n} results',
  searching: 'Searching…',
  searchFailed: 'Search failed. Please try again later',
  searchNone: 'No results (videos posted very recently can be added by pasting the URL)',
  loadMore: 'Load more',
  addToList: 'Add to playlist',
  added: 'Added',
  unplayableBadge: 'Unavailable',
  unplayable_sensitive_video: 'cannot be played because it is marked as sensitive',
  unplayable_externally_unwatchable: 'cannot be played outside niconico due to the rights holder’s settings',
  unplayable_other: 'cannot be played in the embedded player',
  err_invalid_url: 'Enter a video URL or ID (e.g. sm9)',
  err_queue_full: 'The playlist is full',
  err_not_found: '{id} was not found (it may have been deleted)',
  err_unplayable: '"{title}" {reason}',
  err_not_embeddable: '"{title}" cannot be played because embedding is disabled',
  startFailed: 'Failed to start: {msg}',
  settingsTitle: 'Settings',
  close: 'Close',
  theme: 'Theme',
  themeAuto: 'Match Discord',
  themeLight: 'Light',
  themeDark: 'Dark',
  language: 'Language',
  presence: 'Show what you’re watching on Discord',
  presenceDesc: 'Shows the video title on your profile and in the member list',
  settingsNote: 'These settings only apply to you',
  about: 'About NicoParty',
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  presenceChoosing: 'Choosing a video',
  presencePeople: '👤 {n}',
  presenceWatching: '👤 {n} watching',
  presencePaused: '⏸ Paused · 👤 {n}',
};

const DICT: Record<Lang, Record<Key, string>> = { ja, en };
const LANG_KEY = 'nico-party:lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch {
    // localStorage が使えなくてもブラウザの言語で決める
  }
  return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

let lang: Lang = initialLang();
document.documentElement.lang = lang;
const listeners: (() => void)[] = [];

export function getLang() {
  return lang;
}

export function setLang(next: Lang) {
  if (next === lang) return;
  lang = next;
  document.documentElement.lang = next;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    // 保存できなくても今回の表示には反映する
  }
  for (const fn of listeners) fn();
}

export function onLangChange(fn: () => void) {
  listeners.push(fn);
}

/** 文言を取り出す。{name} のような部分は params で置き換える */
export function t(key: Key, params: Record<string, string | number> = {}) {
  return DICT[lang][key].replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''));
}

/** 再生できない理由（埋め込みページのエラーコード）の説明 */
export function unplayableReason(code: string) {
  if (code === 'sensitive_video') return t('unplayable_sensitive_video');
  if (code === 'externally_unwatchable') return t('unplayable_externally_unwatchable');
  return t('unplayable_other');
}

/** data-i18n（文字）/ data-i18n-title / data-i18n-placeholder の付いた要素を今の言語に書き換える */
export function applyI18n(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n as Key);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle as Key);
  }
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder as Key);
  }
}

/** 12345 → 1.2万 / 12.3K のように短く表示する */
export function formatCount(n: number) {
  const short = (v: number, unit: string) => `${v.toFixed(1).replace(/\.0$/, '')}${unit}`;
  if (lang === 'ja') {
    if (n >= 100_000_000) return short(n / 100_000_000, '億');
    if (n >= 10_000) return short(n / 10_000, '万');
    return n.toLocaleString('ja-JP');
  }
  if (n >= 1_000_000) return short(n / 1_000_000, 'M');
  if (n >= 1_000) return short(n / 1_000, 'K');
  return n.toLocaleString('en-US');
}

/** 2024-05-01T12:00:00+09:00 → 2024/5/1 / May 1, 2024 */
export function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return lang === 'ja'
    ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
