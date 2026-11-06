// Выгрузка переписки. Работает на странице чата, в сеть ничего не отправляет.
// Файл запускается в контексте самой страницы: только так видны данные Telegram
// и можно перехватить скачивание файла в WhatsApp, чтобы он лёг в архив.
(() => {
  'use strict';

  const IS_WA = location.hostname === 'web.whatsapp.com';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const safeName = (s) => (s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'чат';

  // ---------- Перехват скачивания в WhatsApp ----------

  // Пока идёт выгрузка, файл из меню "Скачать" не уходит в Загрузки, а отдаётся сюда.
  let catchDownload = null;
  if (IS_WA) {
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (catchDownload && this.hasAttribute('download')) return catchDownload(this.href, this.download);
      return origClick.call(this);
    };
    const origDispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (e) {
      if (catchDownload && e.type === 'click' && this instanceof HTMLAnchorElement && this.hasAttribute('download')) {
        catchDownload(this.href, this.download);
        return true;
      }
      return origDispatch.call(this, e);
    };
  }

  // ---------- Интерфейс ----------

  let running = false;
  let stopAsked = false;

  const plural = (n, one, few, many) => {
    const a = n % 100;
    const b = n % 10;
    return `${n} ${a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many}`;
  };
  const statsText = (messages, files) => `${plural(messages, 'сообщение', 'сообщения', 'сообщений')} · ${plural(files, 'файл', 'файла', 'файлов')}`;

  const ICONS = {
    download: 'M12 3v11m0 0 4.5-4.5M12 14 7.5 9.5M4.5 15.5V18A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-2.5',
    check: 'm5 12.5 4.5 4.5L19 7.5',
    warn: 'M12 8v5m0 3.5v.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
    close: 'M6 6l12 12M18 6 6 18',
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root {
      --bg: #ffffff; --text: #111b21; --muted: #667781; --line: rgba(17, 27, 33, .1); --track: rgba(17, 27, 33, .08);
      --hover: rgba(17, 27, 33, .05); --shadow: 0 2px 6px rgba(11, 20, 26, .1), 0 12px 32px rgba(11, 20, 26, .16);
      --ok: #16a34a; --bad: #dc2626; --warn: #b45309;
      font: 14px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif; color: var(--text);
    }
    .root.dark {
      --bg: #233138; --text: #e9edef; --muted: #9fb0b9; --line: rgba(233, 237, 239, .12); --track: rgba(233, 237, 239, .12);
      --hover: rgba(233, 237, 239, .08); --shadow: 0 2px 6px rgba(0, 0, 0, .3), 0 12px 32px rgba(0, 0, 0, .45);
      --ok: #4ade80; --bad: #f87171; --warn: #fbbf24;
    }
    svg { display: block; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }

    .pick {
      position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px 0 11px;
      background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 19px; box-shadow: var(--shadow);
      font: inherit; font-weight: 600; font-size: 13.5px; white-space: nowrap; cursor: pointer; user-select: none;
      animation: pop .14s cubic-bezier(.2, .9, .3, 1.2);
    }
    .pick svg { color: var(--accent); }
    .pick:hover { background: var(--accent); border-color: var(--accent); color: #fff; }
    .pick:hover svg { color: #fff; }

    .card {
      position: fixed; z-index: 2147483647; right: 20px; bottom: 20px; width: 332px; padding: 14px 16px; background: var(--bg);
      border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); animation: rise .2s ease-out;
    }
    .head { display: flex; align-items: center; gap: 11px; }
    .badge {
      display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; flex: none; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 15%, transparent);
    }
    .names { min-width: 0; flex: 1; }
    .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status { color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .x { display: grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: 50%; background: none; color: var(--muted); cursor: pointer; flex: none; }
    .x:hover { background: var(--hover); color: var(--text); }
    .x svg { width: 14px; height: 14px; }

    .bar { height: 4px; margin: 12px 0 10px; border-radius: 2px; background: var(--track); overflow: hidden; }
    .fill { height: 100%; width: 0; border-radius: 2px; background: var(--accent); transition: width .25s ease; }
    .bar.flow .fill { width: 34%; animation: flow 1.25s ease-in-out infinite; }

    .foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .stats { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .stop { padding: 5px 10px; margin: -5px -10px -5px 0; border: 0; border-radius: 8px; background: none; color: var(--accent); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .stop:hover { background: var(--hover); }
    .stop:disabled { color: var(--muted); background: none; cursor: default; }

    .file { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: var(--hover); font-size: 12.5px; word-break: break-word; }
    .note { margin-top: 8px; color: var(--warn); font-size: 12.5px; }

    @keyframes pop { from { opacity: 0; transform: translateY(5px) scale(.96); } }
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } }
    @keyframes flow { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
    @media (prefers-reduced-motion: reduce) { .pick, .card { animation: none; } .bar.flow .fill { animation: none; width: 100%; opacity: .5; } }
  `;

  let host = null;
  let root = null;
  let pick = null;
  let card = null;
  let hideTimer = null;

  function isDarkPage() {
    if (document.body && document.body.classList.contains('dark')) return true;
    if (document.documentElement.classList.contains('night')) return true;
    const rgb = document.body ? getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) : null;
    if (!rgb || rgb.length < 3 || rgb[3] === '0') return false;
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 110;
  }

  function ensureUi() {
    if (!host || !host.isConnected) {
      host = document.createElement('div');
      const shadow = host.attachShadow({ mode: 'open' });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
      root = document.createElement('div');
      shadow.appendChild(root);
      document.documentElement.appendChild(host);
    }
    root.className = isDarkPage() ? 'root dark' : 'root';
    root.style.setProperty('--accent', IS_WA ? '#00a884' : '#3390ec');
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  // Нажатие обрабатывается сразу: меню самих сайтов закрываются раньше, чем дойдёт click.
  function onPress(node, fn) {
    node.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  }

  function hideMenuBtn() {
    if (pick) pick.remove();
    pick = null;
  }

  function showMenuBtn(x, y, onPick) {
    hideMenuBtn();
    ensureUi();
    pick = el('button', 'pick');
    pick.append(icon('download'), el('span', '', 'Скачать отсюда вниз'));
    pick.style.left = `${Math.max(8, Math.min(x, innerWidth - 210))}px`;
    pick.style.top = `${y > 56 ? y - 48 : y + 12}px`;
    onPress(pick, () => {
      hideMenuBtn();
      onPick();
    });
    root.appendChild(pick);
  }

  const view = {};

  function showCard() {
    ensureUi();
    clearTimeout(hideTimer);
    if (card) card.remove();
    card = el('div', 'card');
    return card;
  }

  function showProgress() {
    const c = showCard();
    const head = el('div', 'head');
    const badge = el('div', 'badge');
    badge.style.setProperty('--tone', 'var(--accent)');
    badge.appendChild(icon('download'));
    const names = el('div', 'names');
    view.title = el('div', 'title', 'Выгрузка переписки');
    view.status = el('div', 'status', 'Начинаю...');
    names.append(view.title, view.status);
    head.append(badge, names);
    view.bar = el('div', 'bar flow');
    view.fill = el('div', 'fill');
    view.bar.appendChild(view.fill);
    const foot = el('div', 'foot');
    view.stats = el('div', 'stats', statsText(0, 0));
    view.stop = el('button', 'stop', 'Остановить и сохранить');
    onPress(view.stop, () => {
      stopAsked = true;
      view.stop.disabled = true;
      view.stop.textContent = 'Останавливаю...';
    });
    foot.append(view.stats, view.stop);
    c.append(head, view.bar, foot);
    root.appendChild(c);
  }

  // part: { title, status, messages, files, frac }. frac не задан: полоса бежит, общий объём не известен.
  function report(part) {
    if (part.title) view.title.textContent = part.title;
    if (part.status) view.status.textContent = part.status;
    if (part.messages !== undefined) view.stats.textContent = statsText(part.messages, part.files);
    if (part.frac === undefined) {
      view.bar.classList.add('flow');
      view.fill.style.width = '';
    } else {
      view.bar.classList.remove('flow');
      view.fill.style.width = `${Math.round(part.frac * 100)}%`;
    }
  }

  function showResult(kind, title, status, fileName, note) {
    const c = showCard();
    const head = el('div', 'head');
    const badge = el('div', 'badge');
    badge.style.setProperty('--tone', kind === 'ok' ? 'var(--ok)' : 'var(--bad)');
    badge.appendChild(icon(kind === 'ok' ? 'check' : 'warn'));
    const names = el('div', 'names');
    names.append(el('div', 'title', title), el('div', 'status', status));
    const x = el('button', 'x');
    x.setAttribute('aria-label', 'Закрыть');
    x.appendChild(icon('close'));
    const close = () => {
      c.remove();
      if (card === c) card = null;
    };
    onPress(x, close);
    head.append(badge, names, x);
    c.appendChild(head);
    if (fileName) c.appendChild(el('div', 'file', fileName));
    if (note) c.appendChild(el('div', 'note', note));
    root.appendChild(c);
    hideTimer = setTimeout(close, kind === 'ok' && !note ? 12000 : 30000);
  }

  // ---------- Архив: ZIP без сжатия, медиа и так сжаты ----------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  async function crc32(blob) {
    let c = 0xffffffff;
    const STEP = 8 * 1024 * 1024;
    for (let pos = 0; pos < blob.size; pos += STEP) {
      const buf = new Uint8Array(await blob.slice(pos, pos + STEP).arrayBuffer());
      for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  async function makeZip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    for (let i = 0; i < files.length; i++) {
      report({ status: `Собираю архив: ${i + 1} из ${files.length}`, frac: (i + 1) / files.length });
      const { name, blob } = files[i];
      const nameBytes = enc.encode(name);
      const crc = await crc32(blob);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 0x0800, true); // имена файлов в UTF-8
      head.setUint16(8, 0, true);
      head.setUint16(10, dosTime, true);
      head.setUint16(12, dosDate, true);
      head.setUint32(14, crc, true);
      head.setUint32(18, blob.size, true);
      head.setUint32(22, blob.size, true);
      head.setUint16(26, nameBytes.length, true);
      head.setUint16(28, 0, true);
      parts.push(head.buffer, nameBytes, blob);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, blob.size, true);
      cd.setUint32(24, blob.size, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd.buffer, nameBytes);
      offset += 30 + nameBytes.length + blob.size;
    }
    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  // ---------- Сборка результата ----------

  // Сообщение: { date: '05.11.2026', time: '17:11', author, reply, forwarded, text, files: [{ path, name }], failed: [{ name, why }] }
  function buildMarkdown(title, source, messages, fileCount, stopped) {
    const failed = messages.reduce((s, m) => s + m.failed.length, 0);
    const now = new Date();
    const lines = [`# ${title}`, '',
      `Источник: ${source}. Выгружено ${fmtDate(now)} ${fmtTime(now)}.`,
      `Сообщений: ${messages.length}, файлов: ${fileCount}, не скачалось: ${failed}.`,
      stopped ? 'Выгрузка остановлена вручную: это не вся переписка до конца чата.' : 'От выбранного сообщения до конца чата.', ''];
    let day = null;
    for (const m of messages) {
      if (m.date && m.date !== day) {
        day = m.date;
        lines.push(`## ${day}`, '');
      }
      lines.push(`**${m.time || '--:--'}, ${m.author || 'неизвестно'}**`);
      if (m.forwarded) lines.push(`Переслано${m.forwarded === true ? '' : ' от ' + m.forwarded}`);
      if (m.reply) lines.push(`> Ответ на: ${m.reply.replace(/\n+/g, ' ')}`);
      if (m.text) lines.push(m.text);
      for (const f of m.files) lines.push(`Файл: ${f.path}`);
      for (const f of m.failed) lines.push(`Файл не скачался: ${f.name}, ${f.why}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  async function saveArchive(title, source, sourceTag, messages, mediaFiles, stopped) {
    const md = buildMarkdown(title, source, messages, mediaFiles.length, stopped);
    const files = [{ name: 'переписка.md', blob: new Blob([md], { type: 'text/markdown' }) }, ...mediaFiles];
    const total = files.reduce((s, f) => s + f.blob.size, 0);
    if (total >= 4e9) throw new Error('больше 4 ГБ не помещается в один архив, выбери сообщение пониже');
    const zip = await makeZip(files);
    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const fname = `${safeName(title)} ${stamp} ${sourceTag}.zip`;
    const a = document.createElement('a');
    const url = URL.createObjectURL(zip);
    a.href = url;
    a.download = fname;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return { fname, messages: messages.length, files: mediaFiles.length, failed: messages.reduce((n, m) => n + m.failed.length, 0), stopped };
  }

  function mediaPath(n, name) {
    return `media/${String(n).padStart(4, '0')} ${safeName(name)}`;
  }

  // ---------- WhatsApp ----------

  const WA_DOWNLOAD = /^(Download|Скачать|Жүктеу|Жүктеп алу)/i;
  const WA_MEDIA = [
    '[data-testid="image-thumb"]', '[data-testid="media-url-provider"]', '[data-testid*="video"]', '[data-testid*="audio"]',
    '[data-testid*="ptt"]', '[data-testid*="document"]', 'audio', 'video', '[data-icon^="document"]', '[data-icon*="audio"]',
    '[data-icon*="ptt"]', '[data-icon*="video"]', '[data-icon*="media-play"]', 'img[src^="blob:"]',
  ].join(',');

  function fire(el, type, x, y) {
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
  }

  function press(el) {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) fire(el, t, x, y);
  }

  async function waitFor(fn, ms) {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await sleep(60);
    }
  }

  // Текст с эмодзи: в WhatsApp они лежат картинками с alt.
  function textOf(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1) {
        if (n.tagName === 'IMG') out += n.alt || '';
        else if (n.tagName === 'BR') out += '\n';
        else out += textOf(n);
      }
    }
    return out;
  }

  // "5:11 PM, 11/5/2026" или "17:11, 05.11.2026"
  function waParseStamp(s) {
    const m = /^(\d{1,2}):(\d{2})(?:\s*([AP])\.?M\.?)?,\s*(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/i.exec(s.trim());
    if (!m) return { date: null, time: null };
    let h = +m[1];
    if (m[3]) {
      const pm = m[3].toUpperCase() === 'P';
      h = (h % 12) + (pm ? 12 : 0);
    }
    let [a, b, c] = [m[4], m[5], m[6]];
    let day, mon, year;
    if (a.length === 4) { year = a; mon = b; day = c; }
    else if (m[3] && s.includes('/')) { mon = a; day = b; year = c; } // 12-часовой формат идёт с датой месяц/день
    else { day = a; mon = b; year = c; }
    return { date: `${pad(+day)}.${pad(+mon)}.${year}`, time: `${pad(h)}:${m[2]}` };
  }

  function waFindScroller(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  }

  function waReadMessage(el, chatTitle) {
    const box = el.querySelector('[data-testid="msg-container"]') || el;
    const msg = { date: null, time: null, author: null, reply: null, forwarded: false, text: '', files: [], failed: [] };

    const quote = box.querySelector('.quoted-mention');
    let quoteBlock = box.querySelector('[aria-label="Quoted message" i], [data-testid*="quoted"]');
    if (quote) {
      // Подпись "кто написал" лежит рядом с текстом цитаты: поднимаемся до родителя, где текста стало больше.
      const body = textOf(quote).trim();
      let p = quote;
      while (p.parentElement && p.parentElement !== box && textOf(p.parentElement).trim() === body) p = p.parentElement;
      const whole = p.parentElement && p.parentElement !== box ? textOf(p.parentElement).trim() : body;
      const who = whole.endsWith(body) ? whole.slice(0, -body.length).trim() : '';
      if (who && who.length <= 80) {
        quoteBlock = p.parentElement;
        msg.reply = `${/^(You|Вы|Сіз)$/i.test(who) ? 'Я' : who}: ${body}`.slice(0, 300);
      } else {
        msg.reply = body.slice(0, 300);
      }
    } else if (quoteBlock) {
      msg.reply = textOf(quoteBlock).trim().slice(0, 300);
    }

    if (box.querySelector('[data-testid="forwarded-header"], [data-icon*="forward"], [aria-label="Forwarded" i], [aria-label="Переслано" i]')) msg.forwarded = true;

    const pre = box.querySelector('[data-pre-plain-text]');
    if (pre) {
      const m = /^\[(.+?)\]\s*(.*?):\s*$/.exec(pre.getAttribute('data-pre-plain-text'));
      if (m) {
        Object.assign(msg, waParseStamp(m[1]));
        msg.author = m[2];
      }
    }
    const textEl = [...box.querySelectorAll('.selectable-text.copyable-text, [data-testid="selectable-text"]')]
      .find((x) => !x.closest('.quoted-mention') && !(quoteBlock && quoteBlock.contains(x)));
    if (textEl) msg.text = textOf(textEl).trim();

    const meta = box.querySelector('[data-testid="msg-meta"] span[dir="auto"]');
    if (!msg.time && meta) {
      const t = /(\d{1,2}):(\d{2})(?:\s*([AP])M)?/i.exec(meta.textContent);
      if (t) {
        let h = +t[1];
        if (t[3]) h = (h % 12) + (t[3].toUpperCase() === 'P' ? 12 : 0);
        msg.time = `${pad(h)}:${t[2]}`;
      }
    }
    // Свои сообщения стоят справа: так не зависит от языка и от подписи в разметке.
    const mainBox = document.querySelector('#main').getBoundingClientRect();
    const own = box.getBoundingClientRect();
    if (own.x + own.width / 2 > mainBox.x + mainBox.width / 2) {
      msg.author = 'Я';
    } else if (!msg.author) {
      const who = [...box.querySelectorAll('span[aria-label]')].map((s) => s.getAttribute('aria-label')).find((a) => /:$/.test(a));
      msg.author = who ? who.slice(0, -1) : chatTitle;
    }
    return msg;
  }

  // Клик мимо закрывает меню. Клавиша Esc, отправленная скриптом, его не закрывает.
  async function waCloseMenu() {
    const r = document.querySelector('#main header').getBoundingClientRect();
    const x = r.x + r.width - 260;
    const y = r.y + r.height / 2;
    const target = document.elementFromPoint(x, y);
    if (target) for (const t of ['pointerdown', 'mousedown']) fire(target, t, x, y);
    await waitFor(() => !document.querySelector('[role="menuitem"]'), 800);
  }

  const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

  // Файл берётся через пункт "Скачать": так не включается воспроизведение
  // голосового и приходит полный файл, а не превью. Меню открывается правым кликом:
  // кнопка меню при наведении подписана по-разному у своих и чужих сообщений.
  async function waFetchMedia(el, hasText) {
    const box = el.querySelector('[data-testid="msg-container"]') || el;
    el.scrollIntoView({ block: 'center' });
    await sleep(120);
    await waitFor(() => !document.querySelector('[role="menuitem"]'), 800);
    const r = box.getBoundingClientRect();
    box.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 2 }));
    const items = await waitFor(() => {
      const list = [...document.querySelectorAll('[role="menuitem"]')];
      return list.length ? list : null;
    }, 1500);
    if (!items) return { why: 'меню сообщения не открылось' };
    const dl = items.find((x) => WA_DOWNLOAD.test((x.getAttribute('aria-label') || x.textContent || '').trim()));
    if (!dl) {
      await waCloseMenu();
      const img = hasText ? null : el.querySelector('img[src^="blob:"]'); // стикер: пункта "Скачать" у него нет
      if (img) {
        try {
          const blob = await fetch(img.src).then((res) => res.blob());
          return { blob, name: `стикер.${MIME_EXT[blob.type] || 'webp'}` };
        } catch (e) { /* ниже общий ответ */ }
      }
      return { none: true };
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        catchDownload = null;
        resolve({ why: 'не дождался файла за 3 минуты' });
      }, 180000);
      catchDownload = (href, name) => {
        catchDownload = null;
        clearTimeout(timer);
        fetch(href).then((res) => res.blob())
          .then((blob) => resolve({ blob, name }))
          .catch((e) => resolve({ why: e.message }));
      };
      press(dl);
    });
  }

  async function runWhatsApp(startEl) {
    const main = document.querySelector('#main');
    const titleEl = main.querySelector('header span[dir="auto"]');
    const title = titleEl ? titleEl.textContent.trim() : 'чат';
    const scroller = waFindScroller(startEl);
    const startId = startEl.getAttribute('data-id');
    report({ title });
    if (document.querySelector('[role="menuitem"]')) await waCloseMenu();
    const seen = new Set();
    const messages = [];
    const mediaFiles = [];
    let idle = 0;
    let last = null;

    while (!stopAsked) {
      const els = [...main.querySelectorAll('[data-id]')].filter((x) => !x.parentElement.closest('[data-id]'));
      const startIdx = els.findIndex((x) => x.getAttribute('data-id') === startId);
      const fresh = (startIdx >= 0 ? els.slice(startIdx) : els).filter((x) => !seen.has(x.getAttribute('data-id')));
      for (const el of fresh) {
        if (stopAsked) break;
        seen.add(el.getAttribute('data-id'));
        const msg = waReadMessage(el, title);
        const box = el.querySelector('[data-testid="msg-container"]');
        if (!box) {
          const sys = textOf(el).trim();
          if (!sys) continue;
          msg.author = 'служебное';
          msg.text = sys;
        } else if (el.querySelector(WA_MEDIA) || !msg.text) {
          report({ status: 'Скачиваю файл...', messages: messages.length, files: mediaFiles.length });
          const r = await waFetchMedia(el, !!msg.text);
          if (r.blob) {
            const path = mediaPath(mediaFiles.length + 1, r.name);
            mediaFiles.push({ name: path, blob: r.blob });
            msg.files.push({ path });
            const d = /(\d{4})-(\d{2})-(\d{2}) at (\d{2})\.(\d{2})/.exec(r.name || '');
            if (d && !msg.date) {
              msg.date = `${d[3]}.${d[2]}.${d[1]}`;
              if (!msg.time) msg.time = `${d[4]}:${d[5]}`;
            }
          } else if (r.none) {
            if (!msg.text) msg.text = '[без текста и файла: удалённое или служебное]';
          } else {
            msg.failed.push({ name: 'вложение', why: r.why });
          }
        }
        messages.push(msg);
        last = el;
        report({ status: 'Читаю сообщения...', messages: messages.length, files: mediaFiles.length });
      }
      const atEnd = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      idle = !fresh.length && atEnd ? idle + 1 : 0;
      if (idle >= 3) break;
      if (scroller) {
        if (fresh.length && last && last.isConnected) last.scrollIntoView({ block: 'start' });
        else scroller.scrollTop += scroller.clientHeight * 0.8;
      }
      await sleep(350);
    }

    // В тексте сообщения с вложением даты нет, берём её у соседей.
    let prev = null;
    for (const m of messages) { if (m.date) prev = m.date; else m.date = prev; }
    let next = null;
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].date) next = messages[i].date; else messages[i].date = next; }

    return saveArchive(title, 'WhatsApp', 'whatsapp', messages, mediaFiles, stopAsked);
  }

  // ---------- Telegram (web.telegram.org/k) ----------

  const TG_EXT = {
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf',
  };

  async function tgName(R, id, cache) {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id);
    let name = String(id);
    try {
      if (id === window.rootScope.myId) name = 'Я';
      else if (id > 0) {
        const u = await R.appUsersManager.getUser(id);
        name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || name;
      } else {
        const c = await R.appChatsManager.getChat(-id);
        name = c.title || name;
      }
    } catch (e) { /* остаётся номер */ }
    cache.set(id, name);
    return name;
  }

  // Скрытые за словом ссылки в тексте иначе потеряются.
  function tgText(m) {
    let text = m.message || '';
    const links = (m.totalEntities || m.entities || []).filter((e) => e._ === 'messageEntityTextUrl' && e.url).sort((a, b) => b.offset - a.offset);
    for (const e of links) {
      const at = e.offset + e.length;
      text = `${text.slice(0, at)} (${e.url})${text.slice(at)}`;
    }
    return text;
  }

  function tgDocName(doc, id) {
    if (doc.file_name) return doc.file_name;
    const ext = TG_EXT[doc.mime_type] || 'bin';
    const kind = { voice: 'голосовое', round: 'кружок', video: 'видео', audio: 'аудио', gif: 'анимация' }[doc.type] || 'файл';
    return `${kind} ${id}.${ext}`;
  }

  async function tgFetchMedia(m, msg, mediaFiles) {
    const media = m.media;
    if (!media) return;
    let target = null;
    let thumb = null;
    let name = null;
    if (media.photo) {
      target = media.photo;
      const sizes = (target.sizes || []).filter((s) => s.w);
      thumb = sizes.sort((a, b) => b.w * b.h - a.w * a.h)[0];
      name = `фото ${m.mid}.jpg`;
    } else if (media.document) {
      target = media.document;
      if (target.type === 'sticker' || target.sticker) {
        const alt = (target.attributes || []).find((a) => a._ === 'documentAttributeSticker');
        msg.text = [msg.text, `[стикер ${alt && alt.alt ? alt.alt : ''}]`.replace(' ]', ']')].filter(Boolean).join('\n');
        return;
      }
      name = tgDocName(target, m.mid);
    } else {
      if (media.poll) {
        const p = media.poll;
        const q = p.question && p.question.text !== undefined ? p.question.text : p.question;
        const opts = (p.answers || []).map((a) => `- ${a.text && a.text.text !== undefined ? a.text.text : a.text}`);
        msg.text = [msg.text, `[опрос] ${q}`, ...opts].filter(Boolean).join('\n');
      } else if (media.geo && media.geo.lat !== undefined) {
        msg.text = [msg.text, `[геопозиция] ${media.geo.lat}, ${media.geo.long}`].filter(Boolean).join('\n');
      } else if (media.phone_number) {
        msg.text = [msg.text, `[контакт] ${media.first_name || ''} ${media.last_name || ''} ${media.phone_number}`].filter(Boolean).join('\n');
      }
      return;
    }
    try {
      const blob = await window.appDownloadManager.downloadMedia(thumb ? { media: target, thumb } : { media: target });
      const path = mediaPath(mediaFiles.length + 1, name);
      mediaFiles.push({ name: path, blob });
      msg.files.push({ path });
    } catch (e) {
      msg.failed.push({ name, why: e && (e.message || e.type) ? e.message || e.type : 'ошибка загрузки' });
    }
  }

  async function runTelegram(startEl) {
    const R = window.rootScope.managers;
    const M = R.appMessagesManager;
    const chat = window.appImManager.chat;
    const { peerId, threadId } = chat;
    const titleEl = document.querySelector('.chat-info .peer-title');
    const title = titleEl ? titleEl.textContent.trim() : 'чат';
    // У альбома в одном пузыре несколько сообщений: начинаем с самого раннего.
    const startMid = Math.min(...[startEl, ...startEl.querySelectorAll('[data-mid]')].map((x) => +x.dataset.mid).filter(Boolean));

    report({ title, status: 'Ищу сообщения...' });
    const mids = [];
    let offsetId = 0;
    for (let reached = false; !reached && !stopAsked;) {
      const h = await M.getHistory({ peerId, threadId, limit: 100, offsetId, addOffset: 0 });
      const batch = h.history || [];
      if (!batch.length) break;
      for (const mid of batch) {
        if (mid < startMid) { reached = true; break; }
        mids.push(mid);
      }
      const oldest = batch[batch.length - 1];
      if (h.isEnd && h.isEnd.top) break;
      if (offsetId && oldest >= offsetId) break;
      offsetId = oldest;
      report({ status: `Нашёл: ${plural(mids.length, 'сообщение', 'сообщения', 'сообщений')}` });
    }
    mids.reverse();

    const names = new Map();
    const messages = [];
    const mediaFiles = [];
    for (const mid of mids) {
      if (stopAsked) break;
      const m = await M.getMessageByPeer(peerId, mid);
      if (!m) continue;
      const when = new Date(m.date * 1000);
      const msg = { date: fmtDate(when), time: fmtTime(when), author: await tgName(R, m.fromId, names), reply: null, forwarded: false, text: tgText(m), files: [], failed: [] };
      if (m._ === 'messageService') {
        msg.text = `[служебное: ${m.action ? m.action._.replace(/^messageAction/, '') : ''}]`;
      }
      if (m.fwd_from) {
        msg.forwarded = m.fwd_from.from_name || (m.fwd_from.fromId ? await tgName(R, m.fwd_from.fromId, names) : true);
      }
      const replyId = m.reply_to && (m.reply_to.reply_to_msg_id || m.reply_to_mid);
      if (replyId) {
        msg.reply = 'сообщение вне выгрузки';
        try {
          const mid2 = m.reply_to_mid || replyId;
          const r = await M.getMessageByPeer(peerId, mid2);
          if (r) msg.reply = `${await tgName(R, r.fromId, names)}: ${(r.message || '[вложение]').slice(0, 300)}`;
        } catch (e) { /* остаётся заглушка */ }
      }
      report({ status: `Сообщение ${messages.length + 1} из ${mids.length}`, messages: messages.length, files: mediaFiles.length, frac: (messages.length + 1) / mids.length });
      await tgFetchMedia(m, msg, mediaFiles);
      messages.push(msg);
    }
    return saveArchive(title, 'Telegram', 'telegram', messages, mediaFiles, stopAsked);
  }

  // ---------- Запуск ----------

  async function start(run, el) {
    if (running) return;
    running = true;
    stopAsked = false;
    showProgress();
    try {
      const r = await run(el);
      const failed = r.failed ? `Не скачалось: ${plural(r.failed, 'файл', 'файла', 'файлов')}, отмечено в переписке` : '';
      const stopped = r.stopped ? 'Остановлено вручную: сохранено не до конца чата' : '';
      showResult('ok', 'Готово, архив в Загрузках', statsText(r.messages, r.files), r.fname, [stopped, failed].filter(Boolean).join('. '));
    } catch (e) {
      console.error('[Выгрузка переписки]', e);
      showResult('bad', 'Не получилось', e.message || String(e));
    } finally {
      running = false;
      catchDownload = null;
    }
  }

  document.addEventListener('contextmenu', (e) => {
    if (running || !(e.target instanceof Element)) return;
    let el = null;
    let run = null;
    if (IS_WA) {
      el = e.target.closest('#main [data-id]');
      while (el && el.parentElement.closest('[data-id]')) el = el.parentElement.closest('[data-id]');
      run = runWhatsApp;
    } else {
      el = e.target.closest('.bubble[data-mid]');
      run = runTelegram;
      if (!el && location.pathname.startsWith('/a') && e.target.closest('.Message')) {
        showResult('bad', 'Нужна другая версия Telegram', 'Выгрузка работает на web.telegram.org/k');
      }
    }
    if (!el) return hideMenuBtn();
    const { clientX: x, clientY: y } = e;
    setTimeout(() => showMenuBtn(x, y, () => start(run, el)), 0);
  }, true);

  document.addEventListener('pointerdown', (e) => {
    if (pick && e.button === 0 && !e.composedPath().includes(pick)) hideMenuBtn();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenuBtn(); }, true);
})();
