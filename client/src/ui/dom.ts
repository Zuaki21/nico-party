/** id から要素を取る。無ければすぐ分かるよう例外にする（id の付け間違いが、あとで別の場所で壊れる形で出ないように） */
export const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

/** 切り替えボタン（.seg）のうち、data-<key> が value のボタンを選択中の見た目にする */
export function markSeg(id: string, key: string, value: string) {
  for (const b of $(id).querySelectorAll<HTMLButtonElement>('button')) {
    const selected = b.dataset[key] === value;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-pressed', String(selected));
  }
}

/** 切り替えボタン（.seg）が押されたら、そのボタンの data-<key> を渡す */
export function onSeg(id: string, key: string, fn: (value: string) => void) {
  $(id).addEventListener('click', (e) => {
    const value = (e.target as HTMLElement).closest<HTMLElement>(`[data-${key}]`)?.dataset[key];
    if (value !== undefined) fn(value);
  });
}

/** リストの中の、薄い文字の1行（「空です」「検索中…」など） */
export function noteEl(text: string) {
  const li = document.createElement('li');
  li.className = 'muted';
  li.textContent = text;
  return li;
}

/**
 * 画面には出さず、読み上げだけする（ui.ts が置く sr-status）。
 * 同じ文言が続いても読み上げられるよう、いったん空にしてから入れる
 */
export function announce(message: string) {
  const el = document.getElementById('sr-status');
  if (!el) return;
  el.textContent = '';
  requestAnimationFrame(() => (el.textContent = message));
}
