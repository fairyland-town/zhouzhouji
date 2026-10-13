/**
 * add_event_screen.js —— 添加页面（02 文档第 7 节）
 * 三个入口：粘贴文字识别 / 手动输入 / 截图 OCR
 */
import { h, mount, toast } from '../utils/dom.js';
import { Icons } from '../widgets/icons.js';
import { parseEvent } from '../services/event_parser.js';
import { ocrService } from '../services/ocr_service.js';
import { PageHeader } from '../widgets/page_header.js';
import { CATEGORY_LIST, DEFAULT_CATEGORY, categoryVars } from '../models/categories.js';

/** 识别失败时的兜底 parsed 对象（字段齐全，避免确认页读取时报错） */
function emptyParsed(text, confidence = 0) {
  return {
    title: '', startTime: '', location: '',
    category: DEFAULT_CATEGORY, speaker: '', academic: false,
    rawText: text, confidence,
    missing: ['title', 'startTime', 'location'],
    fieldConfidence: { title: 0, startTime: 0, location: 0, category: 0, speaker: 0 },
  };
}

export function AddEventScreen(ctx) {
  const el = h('div', { class: 'screen screen--add' });
  let tab = ctx.params?.tab || 'paste';
  let ocrText = '';

  function render() {
    const header = PageHeader({
      title: '添加活动',
      sub: '粘贴通知自动识别，或直接手动填写',
      // v1.13.0：用 ctx.back() 而不是 ctx.go('week')。
      // 从「记录」页的快速抽屉深链进来时，back 会回到记录页，而不是把用户甩回周历。
      onBack: () => ctx.back(),
    });

    const body = h('div', { class: 'app-body' });

    // 分段控件
    body.appendChild(h('div', { class: 'segmented' }, [
      h('button', {
        class: `segmented__item${tab === 'paste' ? ' segmented__item--active' : ''}`,
        text: '粘贴文字',
        onclick: () => { tab = 'paste'; render(); },
      }),
      h('button', {
        class: `segmented__item${tab === 'manual' ? ' segmented__item--active' : ''}`,
        text: '手动输入',
        onclick: () => { tab = 'manual'; render(); },
      }),
      h('button', {
        class: `segmented__item${tab === 'ocr' ? ' segmented__item--active' : ''}`,
        text: '截图识别',
        onclick: () => { tab = 'ocr'; render(); },
      }),
    ]));

    if (tab === 'paste') body.appendChild(pastePane());
    if (tab === 'manual') body.appendChild(manualPane());
    if (tab === 'ocr') body.appendChild(ocrPane());

    mount(el, [header, body]);
  }

  /* ---------------- 粘贴文字 ---------------- */
  function pastePane() {
    const ta = h('textarea', {
      class: 'textarea',
      placeholder: '请粘贴完整通知\n\n例如：\n【学术报告】\n报告题目：图论中的均衡染色问题\n报告人：张教授\n时间：9月18日下午3点\n地点：数学学院201报告厅\n欢迎广大师生参加！',
      rows: '10',
    });

    return h('div', {}, [
      h('div', { class: 'form-group' }, [
        h('label', { class: 'form-label' }, ['通知原文', h('span', { class: 'form-label__req', text: '*' })]),
        ta,
        h('div', { class: 'form-hint', text: '支持：9月18日 15:00 / 9月18日下午3点 / 2026年9月18日15时 / 9.18 14:30 等格式。识别后需人工确认才会保存。' }),
      ]),
      h('button', {
        class: 'btn btn--primary btn--block',
        onclick: () => doParse(ta.value),
      }, [h('span', { html: Icons.wand }), h('span', { text: '智能识别' })]),
      h('div', { class: 'form-hint', style: { textAlign: 'center', marginTop: '10px' }, text: '全部在本地完成，不联网、不调用任何收费接口' }),
    ]);
  }

  function doParse(text) {
    if (!text || !text.trim()) {
      toast('请先粘贴通知内容', 'warn');
      return;
    }
    let parsed;
    try {
      parsed = parseEvent(text);
    } catch (err) {
      toast('识别过程出错，请改用手动输入', 'error');
      ctx.go('confirm', { parsed: emptyParsed(text) });
      return;
    }
    ctx.go('confirm', { parsed });
  }

  /* ---------------- 手动输入 ---------------- */
  function manualPane() {
    const titleI = h('input', { class: 'input', placeholder: '例如：人工智能专题讲座' });
    const timeI = h('input', { class: 'input', type: 'datetime-local', step: '60' });
    const locI = h('input', { class: 'input', placeholder: '例如：信息楼A201' });
    let category = DEFAULT_CATEGORY;

    const catWrap = h('div', { class: 'cat-picker' });
    function paintCats() {
      catWrap.replaceChildren(...CATEGORY_LIST.map((c) => h('button', {
        class: `cat-option${category === c.id ? ' cat-option--active' : ''}`,
        style: { '--cat': c.color, '--cat-soft': c.soft, '--cat-border': c.border },
        onclick: () => { category = category === c.id ? DEFAULT_CATEGORY : c.id; paintCats(); },
      }, [
        h('span', { class: 'cat-option__icon', text: c.icon }),
        h('span', { text: c.label }),
      ])));
    }
    paintCats();

    return h('div', {}, [
      h('div', { class: 'form-group' }, [
        h('label', { class: 'form-label' }, ['活动名称', h('span', { class: 'form-label__req', text: '*' })]),
        titleI,
      ]),
      h('div', { class: 'form-group' }, [
        h('label', { class: 'form-label' }, ['活动时间', h('span', { class: 'form-label__req', text: '*' })]),
        timeI,
      ]),
      h('div', { class: 'form-group' }, [
        h('label', { class: 'form-label' }, ['活动地点', h('span', { class: 'form-label__req', text: '*' })]),
        locI,
      ]),
      h('div', { class: 'form-group' }, [
        h('label', { class: 'form-label' }, ['活动分类', h('span', { class: 'field-status field-status--opt', text: '选填' })]),
        catWrap,
      ]),
      h('button', {
        class: 'btn btn--primary btn--block',
        onclick: () => {
          const title = titleI.value.trim();
          const loc = locI.value.trim();
          const time = timeI.value;
          if (!title) { toast('请填写活动名称', 'warn'); titleI.focus(); return; }
          if (!time) { toast('请选择活动时间', 'warn'); timeI.focus(); return; }
          if (!loc) { toast('请填写活动地点', 'warn'); locI.focus(); return; }
          ctx.go('confirm', {
            parsed: {
              ...emptyParsed('', 1),
              title, startTime: time.replace('T', ' '), location: loc,
              category, confidence: 1,
              fieldConfidence: { title: 1, startTime: 1, location: 1, category: 1, speaker: 0 },
              missing: [],
            },
          });
        },
      }, '下一步 · 确认保存'),
    ]);
  }

  /* ---------------- 截图 OCR ---------------- */
  function ocrPane() {
    const fileInput = h('input', {
      type: 'file', accept: 'image/*', style: { display: 'none' },
      onchange: (e) => handleFile(e.target.files[0]),
    });

    const ta = h('textarea', {
      class: 'textarea', rows: '8',
      placeholder: '识别出的文字会出现在这里，可手动修改后再进行字段提取',
      value: ctx.state.ocrDraft || '',
    });
    ta.addEventListener('input', () => { ocrText = ta.value; ctx.state.ocrDraft = ta.value; });

    const pane = h('div', {}, [
      h('div', { class: 'notice notice--info' }, [
        h('span', { class: 'notice__icon', html: Icons.info }),
        h('span', { text: '使用本机 Windows 系统自带的离线 OCR 引擎，图片不会上传到任何服务器。需要先启动 OCR 服务（双击 tools/启动OCR服务.bat）。' }),
      ]),
      h('div', { class: 'ocr-drop', onclick: () => fileInput.click() }, [
        h('div', { class: 'ocr-drop__icon', text: '🖼' }),
        h('div', { class: 'ocr-drop__title', text: '点击选择通知截图' }),
        h('div', { class: 'ocr-drop__desc', text: '支持 PNG / JPG，也可直接把图片拖进来或粘贴（Ctrl+V）' }),
      ]),
      fileInput,
      h('div', { id: 'ocr-preview-slot' }),
      h('div', { class: 'form-group', style: { marginTop: '14px' } }, [
        h('label', { class: 'form-label', text: '识别文字（可编辑）' }),
        ta,
      ]),
      h('div', { class: 'btn-row' }, [
        h('button', {
          class: 'btn btn--ghost',
          onclick: () => { ocrText = ctx.state.ocrDraft || ''; doParse(ocrText); },
        }, '用已有文字识别'),
        h('button', {
          class: 'btn btn--primary',
          onclick: async (e) => {
            const btn = e.currentTarget;
            const text = (ocrText || ta.value || '').trim();
            if (!text) { toast('请先选择截图并完成识别', 'warn'); return; }
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span>';
            setTimeout(() => doParse(text), 60);
          },
        }, '提取字段'),
      ]),
    ]);

    // 粘贴图片支持
    pane._onPaste = (e) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
      if (item) { e.preventDefault(); handleFile(item.getAsFile()); }
    };

    // 拖拽支持
    pane.addEventListener('dragover', (e) => { e.preventDefault(); pane.querySelector('.ocr-drop').classList.add('ocr-drop--over'); });
    pane.addEventListener('dragleave', () => pane.querySelector('.ocr-drop').classList.remove('ocr-drop--over'));
    pane.addEventListener('drop', (e) => {
      e.preventDefault();
      pane.querySelector('.ocr-drop').classList.remove('ocr-drop--over');
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    async function handleFile(file) {
      if (!file) return;
      if (!file.type.startsWith('image/')) { toast('请选择图片文件', 'warn'); return; }

      const slot = pane.querySelector('#ocr-preview-slot');
      const url = URL.createObjectURL(file);
      slot.innerHTML = '';
      slot.appendChild(h('img', { class: 'ocr-preview', src: url, alt: '通知截图' }));

      const busy = h('div', { class: 'notice notice--info' }, [
        h('span', { class: 'spinner spinner--dark' }),
        h('span', { text: '正在识别图片中的文字…' }),
      ]);
      slot.appendChild(busy);

      try {
        const text = await ocrService.recognize(file);
        busy.remove();
        if (!text || !text.trim()) {
          slot.appendChild(h('div', { class: 'notice notice--warn' }, [
            h('span', { class: 'notice__icon', html: Icons.warn }),
            h('span', { text: '未能从图片中识别出文字。请换一张更清晰的截图，或直接使用「粘贴文字」。' }),
          ]));
          return;
        }
        ta.value = text;
        ocrText = text;
        ctx.state.ocrDraft = text;
        toast(`识别完成，共 ${text.length} 个字符`, 'success');
      } catch (err) {
        busy.remove();
        slot.appendChild(h('div', { class: 'notice notice--danger' }, [
          h('span', { class: 'notice__icon', html: Icons.warn }),
          h('span', { text: `识别失败：${err.message}。${ocrService.failureHint}` }),
        ]));
      }
    }

    return pane;
  }

  render();
  return el;
}
