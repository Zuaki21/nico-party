/** 画面まわりのブラウザ設定（キーボード表示への追従・右クリックメニュー） */
export function setupViewport() {
  // キーボードが出たときは、実際に見えている高さに画面を合わせる（iPhone は画面を縮めずに重ねて出すため）。
  // あわせて、入力欄を見せるためにページがずらされたら元の位置に戻す（画面の配置は動かさない）
  const fitViewport = () => {
    const vv = window.visualViewport;
    if (vv) document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };
  window.addEventListener('scroll', fitViewport);
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.visualViewport?.addEventListener('scroll', fitViewport);
  fitViewport();

  // 右クリックのメニュー（「検証」など）は出さない。入力欄では貼り付けに使うので残す
  document.addEventListener('contextmenu', (e) => {
    if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
  });
}
