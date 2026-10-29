// 各自の設定は localStorage に保存する。プライベートモード等で使えないことがあるので失敗しても無視する

export function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 空文字なら消す（既定値に戻す） */
export function save(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // 保存できなくても今回の表示には反映する
  }
}
