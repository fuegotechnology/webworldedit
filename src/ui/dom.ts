/**
 * Minimal DOM helpers.
 *
 * WebWorld intentionally ships no UI framework: the editor's hot path is the
 * render loop, and a hand-rolled ~200-line DOM layer keeps the bundle small and
 * the panel updates surgical (no virtual-DOM diffing on every frame).
 */

export type Child = Node | string | number | false | null | undefined;

export interface ElementOptions {
  class?: string;
  id?: string;
  text?: string;
  html?: string;
  title?: string;
  style?: Partial<CSSStyleDeclaration>;
  attrs?: Record<string, string | number | boolean | undefined>;
  data?: Record<string, string | number>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.id) node.id = options.id;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.html !== undefined) node.innerHTML = options.html;
  if (options.title) node.title = options.title;
  if (options.style) Object.assign(node.style, options.style);
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === undefined || value === false) continue;
      node.setAttribute(key, String(value));
    }
  }
  if (options.data) {
    for (const [key, value] of Object.entries(options.data)) node.dataset[key] = String(value);
  }
  if (options.on) {
    for (const [type, handler] of Object.entries(options.on)) {
      node.addEventListener(type, handler as EventListener);
    }
  }
  append(node, children);
  return node;
}

export function append(parent: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: HTMLElement): HTMLElement {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** A labelled slider that reports live values. */
export function slider(options: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  format?: (v: number) => string;
  onInput: (value: number) => void;
}): HTMLElement {
  const format = options.format ?? ((v: number) => String(v));
  const readout = el('span', { class: 'value', text: format(options.value) });
  const input = el('input', {
    attrs: {
      type: 'range',
      min: options.min,
      max: options.max,
      step: options.step ?? 1,
      value: options.value,
    },
    on: {
      input: (e) => {
        const value = Number((e.target as HTMLInputElement).value);
        readout.textContent = format(value);
        options.onInput(value);
      },
    },
  });
  const field = el('div', { class: 'field' }, [
    el('label', {}, [readout, options.label]),
    input,
  ]);
  // Allow external updates to keep the slider in sync.
  (field as HTMLElement & { setValue?: (v: number) => void }).setValue = (v: number) => {
    input.value = String(v);
    readout.textContent = format(v);
  };
  return field;
}

export function field(label: string, control: HTMLElement): HTMLElement {
  return el('div', { class: 'field' }, [el('label', { text: label }), control]);
}

export function select(options: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}): HTMLSelectElement {
  const node = el('select', {
    on: { change: (e) => options.onChange((e.target as HTMLSelectElement).value) },
  });
  for (const option of options.options) {
    node.appendChild(el('option', { text: option.label, attrs: { value: option.value } }));
  }
  node.value = options.value;
  return node;
}

/** Segmented control (radio group styled as buttons). */
export function segmented<T extends string>(options: {
  value: T;
  options: Array<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
}): HTMLElement {
  const wrap = el('div', { class: 'seg' });
  const buttons: HTMLButtonElement[] = [];
  for (const option of options.options) {
    const button = el('button', {
      text: option.label,
      title: option.title,
      class: option.value === options.value ? 'active' : '',
      on: {
        click: () => {
          for (const b of buttons) b.classList.remove('active');
          button.classList.add('active');
          options.onChange(option.value);
        },
      },
    });
    buttons.push(button);
    wrap.appendChild(button);
  }
  return wrap;
}

export function checkbox(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = el('input', {
    attrs: { type: 'checkbox', ...(value ? { checked: 'checked' } : {}) },
    on: { change: (e) => onChange((e.target as HTMLInputElement).checked) },
  });
  return el('label', { class: 'row', style: { cursor: 'pointer', fontSize: '11px', color: 'var(--text-dim)' } }, [
    input,
    label,
  ]);
}

export function section(title: string, children: Child[]): HTMLElement {
  return el('div', { class: 'section' }, [el('h3', { text: title }), ...children]);
}

export function statRow(key: string, value: string): HTMLElement {
  return el('div', { class: 'stat-row' }, [
    el('span', { class: 'k', text: key }),
    el('span', { class: 'v', text: value }),
  ]);
}

/** Makes a panel horizontally resizable via a drag handle on its left edge. */
export function makeResizable(
  panel: HTMLElement,
  handle: HTMLElement,
  options: { min: number; max: number; storageKey?: string },
): void {
  if (options.storageKey) {
    const saved = localStorage.getItem(options.storageKey);
    if (saved) panel.style.width = `${Math.min(options.max, Math.max(options.min, Number(saved)))}px`;
  }

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    startX = event.clientX;
    startWidth = panel.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    document.body.style.cursor = 'ew-resize';
    event.preventDefault();
  });

  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const width = Math.min(options.max, Math.max(options.min, startWidth - (event.clientX - startX)));
    panel.style.width = `${width}px`;
  });

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    if (options.storageKey) {
      localStorage.setItem(options.storageKey, String(Math.round(panel.getBoundingClientRect().width)));
    }
    window.dispatchEvent(new Event('resize'));
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

/** Colour swatch CSS for a block, using the atlas tile if available. */
export function blockSwatchStyle(
  color: number,
  atlas: { url: string; columns: number; rows: number; index: number } | null,
): Partial<CSSStyleDeclaration> {
  if (atlas && atlas.index >= 0) {
    const col = atlas.index % atlas.columns;
    const row = Math.floor(atlas.index / atlas.columns);
    return {
      backgroundImage: `url(${atlas.url})`,
      backgroundSize: `${atlas.columns * 100}% ${atlas.rows * 100}%`,
      backgroundPosition: `${(col / Math.max(1, atlas.columns - 1)) * 100}% ${(row / Math.max(1, atlas.rows - 1)) * 100}%`,
    };
  }
  return { background: `#${color.toString(16).padStart(6, '0')}` };
}
