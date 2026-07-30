/**
 * UI shell: toolbar, hotbar, status bar, toasts and the help modal.
 * Wires every panel to the editor's event bus.
 */

import type { Editor } from '../edit/editor';
import type { CameraController } from '../render/camera-controller';
import type { ChunkRenderer } from '../render/chunk-renderer';
import type { BlockPalette } from './palette';
import { TOOLS } from '../edit/tools';
import { SHORTCUT_REFERENCE } from '../input/shortcuts';
import { blockRegistry } from '../world/blocks';
import { clear, el } from './dom';

export class Toolbar {
  readonly root: HTMLElement;
  private buttons = new Map<string, HTMLElement>();

  constructor(editor: Editor) {
    this.root = el('nav', { id: 'toolbar', class: 'panel' });

    TOOLS.forEach((tool, index) => {
      if (index === 2 || index === 7 || index === 10) {
        this.root.appendChild(el('div', { class: 'toolbar-sep' }));
      }
      const button = el(
        'button',
        {
          class: `tool-btn ${editor.activeTool.id === tool.id ? 'active' : ''}`,
          attrs: { 'data-tip': `${tool.name}${tool.shortcut ? ` (${tool.shortcut})` : ''}` },
          on: { click: () => editor.setTool(tool.id) },
        },
        [tool.icon, tool.shortcut && el('span', { class: 'key', text: tool.shortcut })],
      );
      this.buttons.set(tool.id, button);
      this.root.appendChild(button);
    });

    this.root.appendChild(el('div', { class: 'toolbar-sep' }));
    this.root.appendChild(
      el('button', {
        class: 'tool-btn',
        text: '↶',
        attrs: { 'data-tip': 'Undo (Ctrl+Z)' },
        on: { click: () => editor.undo() },
      }),
    );
    this.root.appendChild(
      el('button', {
        class: 'tool-btn',
        text: '↷',
        attrs: { 'data-tip': 'Redo (Ctrl+Shift+Z)' },
        on: { click: () => editor.redo() },
      }),
    );

    editor.events.on('tool:changed', ({ tool }) => {
      for (const [id, button] of this.buttons) button.classList.toggle('active', id === tool.id);
    });
  }
}

export class Hotbar {
  readonly root: HTMLElement;
  private editor: Editor;
  private palette: BlockPalette;

  constructor(editor: Editor, palette: BlockPalette) {
    this.editor = editor;
    this.palette = palette;
    this.root = el('div', { id: 'hotbar', class: 'panel' });
    this.render();
    editor.events.on('settings:changed', () => this.render());

    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      // Shift+digit selects a hotbar slot (plain digits switch tools).
      if (event.shiftKey && /^[1-9]$/.test(event.key)) {
        editor.selectHotbar(Number(event.key) - 1);
        event.preventDefault();
      }
    });
  }

  private render(): void {
    clear(this.root);
    this.editor.settings.hotbar.forEach((id, index) => {
      const block = blockRegistry.get(id);
      this.root.appendChild(
        el(
          'button',
          {
            class: `hotbar-slot ${index === this.editor.settings.hotbarIndex ? 'active' : ''}`,
            title: `${block.name} (Shift+${index + 1})`,
            style: this.palette.styleFor(block),
            on: {
              click: () => this.editor.selectHotbar(index),
              contextmenu: (e) => {
                e.preventDefault();
                this.editor.assignHotbar(index, this.editor.settings.activeBlock);
              },
            },
          },
          [el('span', { class: 'num', text: String(index + 1) })],
        ),
      );
    });
  }
}

export class StatusBar {
  readonly root: HTMLElement;
  private fpsNode: HTMLElement;
  private posNode: HTMLElement;
  private toolNode: HTMLElement;
  private blockNode: HTMLElement;
  private cursorNode: HTMLElement;

  constructor(editor: Editor) {
    this.fpsNode = el('span', { class: 'mono', text: '— fps' });
    this.posNode = el('span', { class: 'mono', text: '0, 0, 0' });
    this.toolNode = el('b', { text: editor.activeTool.name });
    this.blockNode = el('span', { text: blockRegistry.get(editor.settings.activeBlock).name });
    this.cursorNode = el('span', { class: 'mono muted', text: '—' });

    this.root = el('div', { id: 'statusbar', class: 'panel' }, [
      this.fpsNode,
      el('span', { class: 'sep', text: '│' }),
      this.toolNode,
      el('span', { class: 'sep', text: '│' }),
      this.blockNode,
      el('span', { class: 'sep', text: '│' }),
      el('span', { class: 'muted', text: 'cam' }),
      this.posNode,
      el('span', { class: 'sep', text: '│' }),
      el('span', { class: 'muted', text: 'cursor' }),
      this.cursorNode,
    ]);

    editor.events.on('tool:changed', ({ tool }) => (this.toolNode.textContent = tool.name));
    editor.events.on('settings:changed', (s) => {
      this.blockNode.textContent = blockRegistry.get(s.activeBlock).name;
    });
  }

  update(fps: number, camera: CameraController, cursor: { x: number; y: number; z: number } | null): void {
    this.fpsNode.textContent = `${fps.toFixed(0)} fps`;
    this.fpsNode.className = `mono ${fps >= 55 ? 'fps-good' : fps >= 30 ? 'fps-ok' : 'fps-bad'}`;
    const p = camera.camera.position;
    this.posNode.textContent = `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}`;
    this.cursorNode.textContent = cursor ? `${cursor.x}, ${cursor.y}, ${cursor.z}` : '—';
  }
}

export class Toasts {
  readonly root: HTMLElement;
  private queue: HTMLElement[] = [];

  constructor(editor: Editor) {
    this.root = el('div', { id: 'toasts' });
    editor.events.on('notify', ({ message, kind }) => this.show(message, kind));
  }

  show(message: string, kind: 'info' | 'warn' | 'error' | 'success' = 'info'): void {
    const toast = el('div', { class: `toast ${kind}`, text: message });
    this.root.appendChild(toast);
    this.queue.push(toast);
    while (this.queue.length > 4) this.queue.shift()?.remove();

    const lifetime = kind === 'error' ? 6000 : kind === 'warn' ? 3800 : 2600;
    setTimeout(() => {
      toast.classList.add('fade');
      setTimeout(() => {
        toast.remove();
        this.queue = this.queue.filter((t) => t !== toast);
      }, 380);
    }, lifetime);
  }
}

export class HelpModal {
  readonly root: HTMLElement;
  private open = false;

  constructor() {
    const groups = new Map<string, typeof SHORTCUT_REFERENCE>();
    for (const shortcut of SHORTCUT_REFERENCE) {
      const list = groups.get(shortcut.group) ?? [];
      list.push(shortcut);
      groups.set(shortcut.group, list);
    }

    const grid = el(
      'div',
      { class: 'shortcut-grid' },
      [...groups.entries()].map(([group, items]) =>
        el('div', { class: 'shortcut-group' }, [
          el('h4', { text: group }),
          ...items.map((item) =>
            el('div', { class: 'shortcut-item' }, [
              el('span', { class: 'muted', text: item.label }),
              el('kbd', { text: item.keys }),
            ]),
          ),
        ]),
      ),
    );

    const modal = el('div', { class: 'modal panel' }, [
      el('header', {}, [
        el('h2', { text: 'Keyboard shortcuts' }),
        el('button', { class: 'ghost', text: '✕', on: { click: () => this.hide() } }),
      ]),
      el('div', { class: 'content' }, [grid]),
    ]);

    this.root = el('div', {
      class: 'modal-backdrop',
      style: { display: 'none' },
      on: {
        click: (e) => {
          if (e.target === this.root) this.hide();
        },
      },
    }, [modal]);

    document.addEventListener('webworld:toggle-help', () => this.toggle());
    document.addEventListener('webworld:escape', () => this.hide());
  }

  toggle(): void {
    this.open ? this.hide() : this.show();
  }

  show(): void {
    this.open = true;
    this.root.style.display = 'grid';
  }

  hide(): void {
    this.open = false;
    this.root.style.display = 'none';
  }
}

export function createCrosshair(): HTMLElement {
  return el('div', { id: 'crosshair' });
}

export function bindRendererStats(_renderer: ChunkRenderer): void {
  /* reserved for future GPU-timing hooks */
}
