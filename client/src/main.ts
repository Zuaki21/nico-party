import { inDiscord } from './env';

/**
 * Discord のアクティビティとして開かれたときだけアプリ本体を読み込む。
 * 通常のブラウザで開かれたら案内ページを出す（開発中はローカルで同期を確認できるよう本体を動かす）
 */
if (inDiscord || import.meta.env.DEV) {
  await import('./app');
} else {
  showLanding();
}

function showLanding() {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/site.css';
  document.head.append(css);
  document.body.classList.add('site');
  document.querySelector<HTMLElement>('#app')!.innerHTML = `
    <div class="page">
      <header class="site-header">
        <a href="/"><img src="/img/icon-256.png" alt="" />NicoParty</a>
      </header>
      <main>
        <section class="slider" id="slider" aria-roledescription="carousel" aria-label="NicoParty の紹介画像">
          <div class="slides" id="slides">
            <img src="/img/cover.webp" width="1376" height="768" alt="NicoParty のロゴ" />
            <img src="/img/demo.webp" width="1376" height="768" alt="Discord のボイスチャンネルで NicoParty を使っている画面" />
          </div>
          <button class="slide-nav prev" id="slide-prev" aria-label="前の画像">‹</button>
          <button class="slide-nav next" id="slide-next" aria-label="次の画像">›</button>
          <div class="slide-dots" id="slide-dots"></div>
        </section>
        <h1 class="tagline">ニコニコ動画を、みんなで同時に。</h1>
        <p class="lead">
          NicoParty は、Discord のボイスチャンネルでニコニコ動画を一緒に視聴できるアクティビティです。
        </p>

        <section class="features">
          <div class="card">
            <h3><span class="dot"></span>ぴったり同時再生</h3>
            <p>再生・一時停止・シークを参加者全員で共有。途中から参加しても今の場面から始まります。</p>
          </div>
          <div class="card">
            <h3><span class="dot"></span>みんなで作るキュー</h3>
            <p>URL を貼るだけで追加。サムネイルや再生数も表示され、ドラッグで順番を入れ替えられます。</p>
          </div>
          <div class="card">
            <h3><span class="dot"></span>コメントもそのまま</h3>
            <p>ニコニコ動画の公式プレイヤーで再生するので、おなじみのコメントも一緒に楽しめます。</p>
          </div>
        </section>

        <h2 class="section-title">はじめかた</h2>
        <ol class="steps">
          <li>Discord でボイスチャンネルに参加します。</li>
          <li>画面下のロケットのアイコン（アクティビティ）から「NicoParty」を選んで起動します。</li>
          <li>ニコニコ動画の URL（または sm から始まる動画 ID）を入力して「追加」を押せば、再生が始まります。</li>
        </ol>

        <div class="note">
          <strong>ご注意</strong>
          <ul>
            <li>NicoParty は非公式のアプリで、ニコニコ動画・Discord とは関係ありません。</li>
            <li>権利者が外部での再生を制限している動画など、再生できない動画があります。</li>
          </ul>
        </div>
      </main>
      <footer class="site-footer">
        <a href="/terms">利用規約</a>
        <a href="/privacy">プライバシーポリシー</a>
        <a href="mailto:contact@zuaki.dev">お問い合わせ</a>
        <span class="copy">© 2026 Zuaki</span>
      </footer>
    </div>
  `;
  setupSlider();
}

/** 自動で切り替わる、またボタンやスワイプでも切り替えられる画像スライド */
function setupSlider() {
  const AUTO_MS = 5000;
  /** これ以上指を動かしたらスワイプとみなす (px) */
  const SWIPE_PX = 40;
  const root = document.getElementById('slider')!;
  const track = document.getElementById('slides')!;
  const dotsEl = document.getElementById('slide-dots')!;
  const count = track.children.length;
  let index = 0;
  let timer: number | undefined;

  const dots = Array.from({ length: count }, (_, i) => {
    const b = document.createElement('button');
    b.setAttribute('aria-label', `${i + 1}枚目の画像`);
    b.addEventListener('click', () => go(i));
    dotsEl.append(b);
    return b;
  });

  const go = (i: number) => {
    index = (i + count) % count;
    track.style.transform = `translateX(-${index * 100}%)`;
    dots.forEach((d, j) => d.classList.toggle('active', j === index));
    restart();
  };
  const restart = () => {
    clearInterval(timer);
    timer = window.setInterval(() => go(index + 1), AUTO_MS);
  };

  document.getElementById('slide-prev')!.addEventListener('click', () => go(index - 1));
  document.getElementById('slide-next')!.addEventListener('click', () => go(index + 1));
  // マウスを乗せている間は自動切り替えを止める
  root.addEventListener('mouseenter', () => clearInterval(timer));
  root.addEventListener('mouseleave', restart);

  let startX: number | null = null;
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') startX = e.clientX;
  });
  root.addEventListener('pointerup', (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > SWIPE_PX) go(index + (dx < 0 ? 1 : -1));
  });

  go(0);
}
