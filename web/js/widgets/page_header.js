/**
 * page_header.js —— 二级页面头部
 */
import { h } from '../utils/dom.js';
import { Icons } from './icons.js';

export function PageHeader({ title, sub, onBack, actions = [] }) {
  return h('header', { class: 'page-header' }, [
    onBack ? h('button', {
      class: 'page-header__back',
      html: Icons.back,
      title: '返回',
      'aria-label': '返回',
      onclick: onBack,
    }) : null,
    h('div', { style: { flex: '1', minWidth: '0' } }, [
      h('div', { class: 'page-header__title', text: title }),
      sub ? h('div', { class: 'page-header__sub', text: sub }) : null,
    ]),
    ...actions,
  ]);
}
