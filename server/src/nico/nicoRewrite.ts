/**
 * ニコニコの応答の書き換えルール（中の URL を、Discord のプロキシと自前の中継を通す形にする）。
 * 中継の全体は nico.ts。
 *
 * Activity 内では Discord のプロキシ (/.proxy/...) 以外への通信が CSP でブロックされる。
 * そこで埋め込み HTML・プレイヤー JS・API の JSON・m3u8 を取得し、中の URL を
 * `/.proxy/external/<host を -- で連結>`（Discord の URL Mapping）に書き換えて返す。
 * 動画セグメント本体は Discord のプロキシが直接ニコニコから取得するので、ここは通らない。
 *
 * 書き換えルールは kikoune (https://github.com/sevenc-nanashi/kikoune) の
 * packages/backend/src/routes/nicoEdit.ts を移植したもの。
 * Copyright (c) 2024 sevenc7c — MIT License（THIRD_PARTY_NOTICES.md）
 */

/**
 * 中継のパスは /nico/<通行証>/... の形にする。書き換えで作る中継の URL にも、必ず同じ通行証を入れる
 * （通行証のない呼び出しは受け付けないため。通行証は英数字と - _ . だけなので、置換文字列の中でそのまま使える）
 */
export function rewriter(host: string, pass: string) {
  const nico = `nico/${pass}`;
  const replace = (src: string) =>
    src
      .replace(
        /https?:\/\/delivery\.domand\.nicovideo\.jp\/hlsext\/(.+?)\.m3u8/g,
        `${host}/.proxy/${nico}/delivery-domand-nicovideo-jp/hlsext/$1.m3u8`,
      )
      .replace(/https?:\/\/assets\.embed\.res\.nimg\.jp\/js\/(.+?)\.js/g, `/${nico}/watch/$1`)
      .replace('https://stella.nicovideo.jp', `/.proxy/${nico}/stella`)
      .replace(/\/users/g, `/../../${nico}/users`)
      .replace(/\/v1\/watch\/(?!non)/g, `/../../${nico}/v1-watch/`)
      .replace(/\/v4\/watch\/(?!non)/g, `/../../${nico}/v4-watch/`)
      .replace(
        /https?:(?:\/\/|\\\/\\\/)([^/]+?(?:\.nicovideo\.jp|\.nimg\.jp))/g,
        (_m, p1: string) => host + '/.proxy/external/' + p1.replaceAll('.', '--'),
      );
  // プレイヤーの JS だけにある、API の呼び先の書き換え（同じ通行証の入った中継の URL にする）
  const replaceJs = (src: string) =>
    replace(src)
      .replace(/\/api\/watch/g, `/.proxy/${nico}/api-watch`)
      .replace(/\/v1\/recommend\?/g, `/../../${nico}/nvapi-recommend?`);
  return { replace, replaceJs };
}
