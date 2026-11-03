import type { Member, NoticeEvent } from '../../../shared/protocol';
import { formatTime, t } from '../core/i18n';
import { avatarOrInitial } from './avatar';
import { $, announce } from './dom';

/** 通知を出しておく時間と、同時に出す数（古いものから消す） */
const NOTICE_MS = 4000;
const MAX_NOTICES = 3;

function text(ev: NoticeEvent): string {
  switch (ev.k) {
    case 'seek':
      return t('noticeSeek', { time: formatTime(ev.position) });
    case 'switch':
      return t('noticeSwitch', { title: ev.title });
    case 'add':
      return t('noticeAdd', { title: ev.title });
    case 'remove':
      return t('noticeRemove', { title: ev.title });
  }
}

/** 他の人の操作を、動画の左上に重ねて少しの間だけ出す（操作した人のアイコンつき）。読み上げにも流す */
export function showNotice(by: Member, ev: NoticeEvent) {
  const box = $('notices');
  const message = text(ev);
  const item = document.createElement('div');
  item.className = 'notice';
  // 操作した人は、名前ではなくアイコンで示す（アイコンが無い・読み込めないときは名前の頭文字）
  item.append(avatarOrInitial(by.name, by.avatar));
  const span = document.createElement('span');
  span.textContent = message;
  item.append(span);
  box.append(item);
  while (box.childElementCount > MAX_NOTICES) box.firstElementChild?.remove();
  window.setTimeout(() => item.remove(), NOTICE_MS);
  // 読み上げでは、誰の操作かも伝える
  announce(`${by.name} ${message}`);
}
