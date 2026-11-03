import { t } from '../core/i18n';

/* 人（追加した人・操作した人）を、Discord のアイコンで示す部品 */

/** 名前の頭文字（アイコンの代わりに出す） */
export function initialOf(name: string) {
  return Array.from(name)[0] ?? '?';
}

/** アイコンの代わりの、名前の頭文字の丸 */
export function initialEl(name: string) {
  const el = document.createElement('span');
  el.className = 'initial';
  el.setAttribute('aria-hidden', 'true');
  el.textContent = initialOf(name);
  return el;
}

/** アイコンの画像。読み込めなかったら onError を呼ぶ */
function avatarImg(avatar: string, onError: (img: HTMLImageElement) => void, lazy = false) {
  const img = document.createElement('img');
  img.src = avatar;
  img.alt = '';
  if (lazy) img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => onError(img));
  return img;
}

/** アイコンの画像。アイコンが無い・読み込めないときは、名前の頭文字の丸（initialEl） */
export function avatarOrInitial(name: string, avatar: string | undefined): HTMLElement {
  if (!avatar) return initialEl(name);
  return avatarImg(avatar, (img) => img.replaceWith(initialEl(name)));
}

/** 追加した人のアイコン（サムネイルの左下に重ねる）。アイコンが無い・読み込めないときは、名前の頭文字 */
export function adderEl(name: string, avatar: string | undefined) {
  const el = document.createElement('span');
  el.className = 'adder';
  // すぐ出る吹き出し（setupAdderTip）で名前を見せる。ブラウザの title は出るまで遅いので使わない
  el.dataset.name = name;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', t('addedByIcon', { name }));
  // アイコンが無い・読み込めない項目は、サムネイルの上でも誰か分かるよう、名前の頭文字の丸にする
  const fallback = () => {
    el.classList.add('fallback');
    el.textContent = initialOf(name);
  };
  if (avatar) {
    el.append(
      avatarImg(
        avatar,
        (img) => {
          img.remove();
          fallback();
        },
        true,
      ),
    );
  } else fallback();
  return el;
}

/** 追加した人を、アイコンと名前を入れたタグで出す（再生中の動画の横。ポインターを乗せなくても名前が見える） */
export function adderTagEl(name: string, avatar: string | undefined) {
  const tag = document.createElement('span');
  tag.className = 'adder-tag';
  tag.title = t('addedByIcon', { name });
  tag.append(avatarOrInitial(name, avatar));
  const text = document.createElement('span');
  text.className = 'adder-name';
  text.textContent = name;
  tag.append(text);
  return tag;
}

/**
 * 追加した人のアイコン（.adder）にポインターを乗せたら、名前をすぐ出す。
 * サムネイルは overflow: hidden なので、枠の外に出る吹き出しは、画面に固定した 1 つの要素を使う
 */
export function setupAdderTip() {
  const tip = document.createElement('div');
  tip.className = 'adder-tip';
  tip.hidden = true;
  document.body.append(tip);
  const hide = () => (tip.hidden = true);
  document.addEventListener('pointerover', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.adder[data-name]');
    if (!el) return hide();
    tip.textContent = el.dataset.name ?? '';
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    // アイコンの上に出す（上に余白が無ければ下）。画面の外にはみ出さないよう左右を丸める
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = r.top - tip.offsetHeight - 6 >= 4 ? `${r.top - tip.offsetHeight - 6}px` : `${r.bottom + 6}px`;
  });
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}
