// Discord の外から開いたときの案内ページ (landing.html)。サーバーが / を振り分けて配信する

/**
 * 自動で切り替わる、またボタンやスワイプでも切り替えられる画像スライド。
 * 端で巻き戻らずに同じ向きへ回り続けるよう、両端に反対側の画像の複製を置き、
 * 複製まで進んだらアニメーションなしで本物の位置へ戻す。
 */
function setupSlider() {
  const AUTO_MS = 8000;
  /** これ以上指を動かしたらスワイプとみなす (px) */
  const SWIPE_PX = 40;
  const root = document.getElementById('slider')!;
  const track = document.getElementById('slides')!;
  const dotsEl = document.getElementById('slide-dots')!;
  const originals = Array.from(track.children) as HTMLElement[];
  const count = originals.length;
  // [最後の複製, 1枚目, ..., 最後, 1枚目の複製]
  const head = originals[count - 1].cloneNode(true) as HTMLElement;
  const tail = originals[0].cloneNode(true) as HTMLElement;
  for (const c of [head, tail]) c.setAttribute('aria-hidden', 'true');
  track.prepend(head);
  track.append(tail);

  /** track 上の位置（1〜count が本物） */
  let pos = 1;
  let moving = false;
  let timer: number | undefined;
  /** 背景タブなどで transitionend が来なかったときの保険 */
  let fallback: number | undefined;

  // 画像ごとに「n / 全体」の名前を付ける（読み上げで、いま何枚目かが分かるように）
  originals.forEach((el, i) => {
    el.setAttribute('role', 'group');
    el.setAttribute('aria-roledescription', 'スライド');
    el.setAttribute('aria-label', `${i + 1} / ${count}`);
  });

  const dots = Array.from({ length: count }, (_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `${i + 1}枚目の画像`);
    b.addEventListener('click', () => go(i + 1));
    dotsEl.append(b);
    return b;
  });

  const place = (animate: boolean) => {
    track.style.transition = animate ? '' : 'none';
    track.style.transform = `translateX(-${pos * 100}%)`;
    const real = (pos - 1 + count) % count;
    dots.forEach((d, j) => {
      d.classList.toggle('active', j === real);
      if (j === real) d.setAttribute('aria-current', 'true');
      else d.removeAttribute('aria-current');
    });
  };

  /** 複製の位置にいたら本物の位置へ瞬間移動する */
  const normalize = () => {
    clearTimeout(fallback);
    moving = false;
    if (pos === 0) pos = count;
    else if (pos === count + 1) pos = 1;
    else return;
    place(false);
    void track.offsetWidth; // 次のアニメーションの前に位置の変更を反映させる
  };

  const go = (target: number) => {
    if (moving || target === pos) return;
    pos = target;
    moving = true;
    place(true);
    // 「動きを減らす」設定などでアニメーションが無いときは transitionend が来ない
    if (parseFloat(getComputedStyle(track).transitionDuration) === 0) normalize();
    else fallback = window.setTimeout(normalize, 1000);
    restart();
  };
  track.addEventListener('transitionend', normalize);

  /** 「動きを減らす」設定のときは、自動で切り替えない */
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  /** 利用者が止めた（止めるボタン） */
  let paused = false;
  /** マウスを乗せている、またはフォーカスが中にある間は、一時的に止める */
  let held = false;
  const autoPlays = () => !paused && !held && !reducedMotion.matches;

  const restart = () => {
    clearInterval(timer);
    // 自動で切り替わっている間は、切り替わるたびに読み上げない。止まっている間は、手動の切り替えを読み上げる
    track.setAttribute('aria-live', autoPlays() ? 'off' : 'polite');
    if (autoPlays()) timer = window.setInterval(() => go(pos + 1), AUTO_MS);
  };

  document.getElementById('slide-prev')!.addEventListener('click', () => go(pos - 1));
  document.getElementById('slide-next')!.addEventListener('click', () => go(pos + 1));
  // マウスを乗せている間、キーボードでフォーカスしている間は自動切り替えを止める
  const hold = (on: boolean) => {
    held = on;
    restart();
  };
  const pause = document.getElementById('slide-pause')!;
  /** マウスが乗っている（マウスのときだけ。タッチでは、タップのあとに離れたことが分からず、止まったままになる） */
  let mouseInside = false;
  /** キーボードで操作している（フォーカスの表示が出るフォーカス）。止める／再開のボタンは含めず、押した結果を優先する */
  let keyboardFocus = false;
  const updateHold = () => hold(mouseInside || keyboardFocus);
  root.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse') return;
    mouseInside = true;
    updateHold();
  });
  root.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    mouseInside = false;
    updateHold();
  });
  root.addEventListener('focusin', (e) => {
    const target = e.target as Element;
    keyboardFocus = target !== pause && target.matches(':focus-visible');
    updateHold();
  });
  root.addEventListener('focusout', () => {
    keyboardFocus = false;
    updateHold();
  });
  pause.addEventListener('click', () => {
    paused = !paused;
    pause.dataset.paused = String(paused);
    pause.textContent = paused ? '自動切り替えを再開' : '自動切り替えを止める';
    restart();
  });
  reducedMotion.addEventListener('change', restart);

  let startX: number | null = null;
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') startX = e.clientX;
  });
  root.addEventListener('pointerup', (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > SWIPE_PX) go(pos + (dx < 0 ? 1 : -1));
  });

  place(false);
  restart();
}

setupSlider();
