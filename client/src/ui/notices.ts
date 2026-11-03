import type { Member, NoticeEvent } from '../../../shared/protocol';
import { t } from '../core/i18n';
import { $, announce, formatTime } from './dom';

/** 通知を出しておく時間と、同時に出す数（古いものから消す） */
const NOTICE_MS = 4000;
const MAX_NOTICES = 3;

function text(by: Member, ev: NoticeEvent): string {
  switch (ev.k) {
    case 'seek':
      return t('noticeSeek', { name: by.name, time: formatTime(ev.position) });
    case 'switch':
      return t('noticeSwitch', { name: by.name, title: ev.title });
    case 'add':
      return t('noticeAdd', { name: by.name, title: ev.title });
    case 'remove':
      return t('noticeRemove', { name: by.name, title: ev.title });
  }
}

/** 他の人の操作を、動画の左上に重ねて少しの間だけ出す（操作した人のアイコンつき）。読み上げにも流す */
export function showNotice(by: Member, ev: NoticeEvent) {
  const box = $('notices');
  const message = text(by, ev);
  const item = document.createElement('div');
  item.className = 'notice';
  if (by.avatar) {
    const img = document.createElement('img');
    img.src = by.avatar;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove());
    item.append(img);
  }
  const span = document.createElement('span');
  span.textContent = message;
  item.append(span);
  box.append(item);
  while (box.childElementCount > MAX_NOTICES) box.firstElementChild?.remove();
  window.setTimeout(() => item.remove(), NOTICE_MS);
  announce(message);
}
