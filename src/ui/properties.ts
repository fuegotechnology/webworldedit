/**
 * Right-hand properties panel.
 *
 * Three tabs: Tool (contextual settings for the active tool), Blocks (palette),
 * and World (stats, selection, IO, camera and AI provider settings). The panel
 * rebuilds only the visible tab, and only when something relevant changes.
 */

import type { Editor } from '../edit/editor';
import type { CameraController } from '../render/camera-controller';
import type { ChunkRenderer } from '../render/chunk-renderer';
import type { AiAssistant } from '../ai/assistant';
import type { BlockPalette } from './palette';
import { BIOMES } from '../edit/biomes';
import { blockRegistry } from '../world/blocks';
import { regionSize, regionVolume, vec3 } from '../core/types';
import { checkbox, clear, el, field, makeResizable, section, segmented, select, slider, statRow } from './dom';

export type PanelTab = 'tool' | 'blocks' | 'world';

export interface PropertiesOptions {
  editor: Editor;
  camera: CameraController;
  renderer: ChunkRenderer;
  assistant: AiAssistant;
  palette: BlockPalette;
  onSave: () => void;
  onLoad: () => void;
  onExportSchem: () => void;
  onImportSchem: () => void;
  onNewWorld: () => void;
  onShowHelp: () => void;
}

export class PropertiesPanel {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private tabs: HTMLElement;
  private tab: PanelTab = 'tool';
  private o: PropertiesOptions;
  private statsNode: HTMLElement | null = null;
  private rafPending = false;

  constructor(options: PropertiesOptions) {
    this.o = options;
    this.body = el('div', { class: 'panel-body' });
    this.tabs = el('div', { class: 'panel-tabs' });
    const handle = el('div', { class: 'resize-handle' });

    this.root = el('aside', { id: 'properties', class: 'panel' }, [handle, this.tabs, this.body]);
    makeResizable(this.root, handle, { min: 220, max: 520, storageKey: 'webworld.panel.width' });

    this.renderTabs();
    this.render();

    options.editor.events.on('settings:changed', () => this.scheduleRender());
    options.editor.events.on('tool:changed', () => {
      this.tab = 'tool';
      this.renderTabs();
      this.render();
    });
    options.editor.selection.events.on('changed', () => this.scheduleRender());
    options.editor.events.on('clipboard:changed', () => this.scheduleRender());
  }

  private scheduleRender(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.render();
    });
  }

  private renderTabs(): void {
    clear(this.tabs);
    for (const tab of ['tool', 'blocks', 'world'] as PanelTab[]) {
      this.tabs.appendChild(
        el('button', {
          class: `panel-tab ${tab === this.tab ? 'active' : ''}`,
          text: tab,
          on: {
            click: () => {
              this.tab = tab;
              this.renderTabs();
              this.render();
            },
          },
        }),
      );
    }
  }

  render(): void {
    const scroll = this.body.scrollTop;
    clear(this.body);
    if (this.tab === 'tool') this.renderToolTab();
    else if (this.tab === 'blocks') this.renderBlocksTab();
    else this.renderWorldTab();
    this.body.scrollTop = scroll;
  }

  // ------------------------------------------------------------- tool tab

  private renderToolTab(): void {
    const { editor } = this.o;
    const s = editor.settings;
    const tool = editor.activeTool;

    this.body.appendChild(
      section(`${tool.icon} ${tool.name}`, [
        el('p', { class: 'faint', text: tool.description, style: { margin: '0 0 4px', lineHeight: '1.5' } }),
      ]),
    );

    this.body.appendChild(this.activeBlockCard());

    // Brush-family settings.
    if (['brush', 'sculpt', 'paint'].includes(tool.id)) {
      this.body.appendChild(
        section('Brush', [
          slider({
            label: 'Radius',
            min: 1,
            max: 64,
            value: s.brushRadius,
            format: (v) => `${v}`,
            onInput: (v) => editor.update({ brushRadius: v }),
          }),
          tool.id === 'brush' &&
            field(
              'Shape',
              segmented({
                value: s.brushShape,
                options: [
                  { value: 'sphere', label: 'Sphere' },
                  { value: 'cube', label: 'Cube' },
                  { value: 'cylinder', label: 'Cylinder' },
                ],
                onChange: (v) => editor.update({ brushShape: v }),
              }),
            ),
          tool.id === 'brush' && checkbox('Hollow', s.brushHollow, (v) => editor.update({ brushHollow: v })),
          tool.id === 'brush' && checkbox('Only replace air', s.maskAirOnly, (v) => editor.update({ maskAirOnly: v })),
          tool.id === 'sculpt' &&
            slider({
              label: 'Strength',
              min: 1,
              max: 24,
              value: s.sculptStrength,
              onInput: (v) => editor.update({ sculptStrength: v }),
            }),
        ]),
      );
    }

    if (tool.id === 'paint') {
      this.body.appendChild(
        section('Biome', [
          field(
            'Palette',
            select({
              value: s.biome,
              options: BIOMES.map((b) => ({ value: b.id, label: b.name })),
              onChange: (v) => editor.update({ biome: v }),
            }),
          ),
          el('button', { class: 'primary', text: 'Paint selection', on: { click: () => editor.paintBiomeSelection() } }),
        ]),
      );
    }

    if (tool.id === 'shape') {
      this.body.appendChild(
        section('Shape', [
          field(
            'Kind',
            select({
              value: s.shapeKind,
              options: [
                { value: 'sphere', label: 'Sphere' },
                { value: 'cylinder', label: 'Cylinder' },
                { value: 'pyramid', label: 'Pyramid' },
                { value: 'box', label: 'Box' },
              ],
              onChange: (v) => editor.update({ shapeKind: v as typeof s.shapeKind }),
            }),
          ),
          slider({ label: 'Size', min: 1, max: 96, value: s.shapeSize, onInput: (v) => editor.update({ shapeSize: v }) }),
          checkbox('Hollow', s.shapeHollow, (v) => editor.update({ shapeHollow: v })),
        ]),
      );
    }

    if (tool.id === 'replace') {
      const from = blockRegistry.get(s.replaceFrom);
      this.body.appendChild(
        section('Replace', [
          el('div', { class: 'faint', style: { marginBottom: '6px' } }, [
            `From: ${from.name} — right-click a block in the world to change this.`,
          ]),
          el('button', { class: 'primary', text: 'Replace in selection', on: { click: () => editor.replaceInSelection() } }),
          el('button', {
            text: 'Replace all non-air',
            style: { marginTop: '6px' },
            on: { click: () => editor.replaceInSelection('any-solid') },
          }),
        ]),
      );
    }

    // Selection operations are always useful.
    this.body.appendChild(this.selectionSection());
    this.body.appendChild(this.clipboardSection());
  }

  private activeBlockCard(): HTMLElement {
    const { editor, palette } = this.o;
    const block = blockRegistry.get(editor.settings.activeBlock);
    return el('div', { class: 'active-block-card' }, [
      el('div', { class: 'preview', style: palette.styleFor(block) }),
      el('div', { class: 'grow' }, [
        el('div', { text: block.name, style: { fontWeight: '500' } }),
        el('div', { class: 'faint mono truncate', text: `minecraft:${block.mc}` }),
      ]),
      el('button', {
        class: 'ghost',
        text: '▸',
        title: 'Open block palette',
        on: {
          click: () => {
            this.tab = 'blocks';
            this.renderTabs();
            this.render();
          },
        },
      }),
    ]);
  }

  private selectionSection(): HTMLElement {
    const { editor } = this.o;
    const region = editor.selection.primary;
    const children: HTMLElement[] = [];

    if (region) {
      const size = regionSize(region);
      children.push(
        el('div', { class: 'faint mono', style: { marginBottom: '8px' } }, [
          `${size.x} × ${size.y} × ${size.z} = ${regionVolume(region).toLocaleString()} blocks`,
          el('br'),
          `min ${region.min.x}, ${region.min.y}, ${region.min.z}`,
          el('br'),
          `max ${region.max.x}, ${region.max.y}, ${region.max.z}`,
        ]),
      );
    } else {
      children.push(el('div', { class: 'faint', style: { marginBottom: '8px' }, text: 'No selection. Use the Select tool (1): left-click sets pos 1, right-click sets pos 2.' }));
    }

    children.push(
      el('div', { class: 'btn-grid' }, [
        el('button', { text: 'Fill', on: { click: () => editor.fillSelection() } }),
        el('button', { text: 'Clear', on: { click: () => editor.fillSelection(0) } }),
        el('button', { text: 'Walls', on: { click: () => editor.wallsInSelection() } }),
        el('button', { text: 'Hollow', on: { click: () => editor.hollowSelection() } }),
        el('button', { text: 'Smooth', on: { click: () => editor.smoothSelection() } }),
        el('button', { text: 'Focus', on: { click: () => editor.focusSelection() } }),
      ]),
    );
    children.push(
      el('div', { class: 'btn-grid three', style: { marginTop: '6px' } }, [
        el('button', { text: 'Expand', on: { click: () => editor.expandSelection(1) } }),
        el('button', { text: 'Contract', on: { click: () => editor.expandSelection(-1) } }),
        el('button', { text: 'Select all', on: { click: () => editor.selectAll() } }),
        el('button', { text: 'Rotate 90°', on: { click: () => editor.rotateSelection(1) } }),
        el('button', { text: 'Mirror X', on: { click: () => editor.mirrorSelection('x') } }),
        el('button', { text: 'Mirror Z', on: { click: () => editor.mirrorSelection('z') } }),
      ]),
    );
    children.push(
      el('div', { class: 'btn-grid', style: { marginTop: '6px' } }, [
        el('button', { text: 'Add region', title: 'Multi-selection', on: { click: () => editor.selection.pushRegion() } }),
        el('button', { class: 'danger', text: 'Deselect', on: { click: () => editor.selection.clear() } }),
      ]),
    );
    children.push(
      el('button', {
        text: 'Stack ×3 (+X)',
        style: { marginTop: '6px' },
        on: { click: () => editor.stackSelection(vec3(1, 0, 0), 3) },
      }),
    );

    if (region && regionVolume(region) < 2_000_000) {
      const counts = editor.analyzeSelection();
      if (counts.length > 0) {
        children.push(
          el('div', { style: { marginTop: '10px' } }, [
            el('h3', { text: 'Contents', style: { fontSize: '10px', letterSpacing: '0.1em', color: 'var(--text-faint)', textTransform: 'uppercase', margin: '0 0 4px' } }),
            ...counts.map((line) => el('div', { class: 'faint mono', text: line })),
          ]),
        );
      }
    }

    return section('Selection', children);
  }

  private clipboardSection(): HTMLElement {
    const { editor } = this.o;
    const clip = editor.clipboard;
    return section('Clipboard', [
      el('div', {
        class: 'faint mono',
        style: { marginBottom: '8px' },
        text: clip ? `${clip.size.x} × ${clip.size.y} × ${clip.size.z}` : 'Empty',
      }),
      el('div', { class: 'btn-grid three' }, [
        el('button', { text: 'Copy', on: { click: () => editor.copySelection() } }),
        el('button', { text: 'Cut', on: { click: () => editor.cutSelection() } }),
        el('button', { text: 'Paste', on: { click: () => editor.pasteAtSelection() } }),
        el('button', { text: 'Rotate', on: { click: () => editor.rotateClipboard(1) } }),
        el('button', { text: 'Flip X', on: { click: () => editor.mirrorClipboard('x') } }),
        el('button', { text: 'Flip Z', on: { click: () => editor.mirrorClipboard('z') } }),
      ]),
    ]);
  }

  // ------------------------------------------------------------ blocks tab

  private renderBlocksTab(): void {
    this.body.appendChild(this.activeBlockCard());
    this.body.appendChild(section('Palette', [this.o.palette.root]));
    this.body.appendChild(
      el('div', { class: 'faint', text: 'Click a block to make it active. Right-click to assign it to the current hotbar slot.' }),
    );
  }

  // ------------------------------------------------------------- world tab

  private renderWorldTab(): void {
    const { editor, camera, renderer, assistant } = this.o;
    const s = editor.settings;

    this.statsNode = el('div');
    this.body.appendChild(section('Statistics', [this.statsNode]));
    this.updateStats();

    this.body.appendChild(
      section('Camera', [
        field(
          'Mode',
          segmented({
            value: camera.mode,
            options: [
              { value: 'fly' as const, label: 'Fly' },
              { value: 'orbit' as const, label: 'Orbit' },
            ],
            onChange: (v) => camera.setMode(v),
          }),
        ),
        slider({
          label: 'Move speed',
          min: 1,
          max: 200,
          value: Math.round(camera.moveSpeed),
          format: (v) => `${v} b/s`,
          onInput: (v) => (camera.moveSpeed = v),
        }),
        slider({
          label: 'View distance',
          min: 4,
          max: 32,
          value: renderer.viewDistance,
          format: (v) => `${v} chunks`,
          onInput: (v) => (renderer.viewDistance = v),
        }),
        slider({
          label: 'Grid snap',
          min: 1,
          max: 16,
          value: s.gridSnap,
          onInput: (v) => editor.update({ gridSnap: v }),
        }),
        checkbox('Show grid', s.showGrid, (v) => editor.update({ showGrid: v })),
        el('button', { text: 'Focus selection (F)', style: { marginTop: '6px' }, on: { click: () => editor.focusSelection() } }),
      ]),
    );

    this.body.appendChild(
      section('Project', [
        el('div', { class: 'btn-grid' }, [
          el('button', { text: '💾 Save JSON', on: { click: this.o.onSave } }),
          el('button', { text: '📂 Open JSON', on: { click: this.o.onLoad } }),
          el('button', { text: '⬇ Export .schem', on: { click: this.o.onExportSchem } }),
          el('button', { text: '⬆ Import .schem', on: { click: this.o.onImportSchem } }),
        ]),
        el('button', { class: 'danger', text: 'New world', style: { marginTop: '6px' }, on: { click: this.o.onNewWorld } }),
      ]),
    );

    this.body.appendChild(
      section('AI assistant', [
        el('p', { class: 'faint', style: { margin: '0 0 8px', lineHeight: '1.5' } }, [
          'The built-in planner works offline and turns prompts into editor operations. Optionally connect an OpenAI-compatible model for broader language understanding — its output is validated against the same operation schema.',
        ]),
        checkbox('Use remote model', assistant.provider.enabled, (v) => {
          assistant.setProvider({ enabled: v });
          this.render();
        }),
        assistant.provider.enabled &&
          field(
            'Endpoint',
            el('input', {
              attrs: { type: 'text', value: assistant.provider.endpoint, placeholder: 'https://…/v1/chat/completions' },
              on: { change: (e) => assistant.setProvider({ endpoint: (e.target as HTMLInputElement).value }) },
            }),
          ),
        assistant.provider.enabled &&
          field(
            'Model',
            el('input', {
              attrs: { type: 'text', value: assistant.provider.model },
              on: { change: (e) => assistant.setProvider({ model: (e.target as HTMLInputElement).value }) },
            }),
          ),
        assistant.provider.enabled &&
          field(
            'API key',
            el('input', {
              attrs: { type: 'password', value: assistant.provider.apiKey, placeholder: 'stored in localStorage only' },
              on: { change: (e) => assistant.setProvider({ apiKey: (e.target as HTMLInputElement).value }) },
            }),
          ),
      ]),
    );

    this.body.appendChild(
      section('Help', [
        el('button', { text: '⌨ Keyboard shortcuts (?)', on: { click: this.o.onShowHelp } }),
      ]),
    );
  }

  /** Cheap per-second refresh of the stats block without rebuilding the tab. */
  updateStats(): void {
    if (!this.statsNode || this.tab !== 'world') return;
    const { editor, renderer } = this.o;
    clear(this.statsNode);
    const stats = renderer.stats;
    this.statsNode.appendChild(statRow('Chunks loaded', String(editor.world.chunkCount)));
    this.statsNode.appendChild(statRow('Chunk meshes', String(stats.chunks)));
    this.statsNode.appendChild(statRow('Visible meshes', String(stats.visibleChunks)));
    this.statsNode.appendChild(statRow('Triangles', Math.round(stats.triangles).toLocaleString()));
    this.statsNode.appendChild(statRow('Blocks placed', editor.world.blockCount.toLocaleString()));
    this.statsNode.appendChild(statRow('Mesh queue', String(stats.pendingJobs)));
    this.statsNode.appendChild(statRow('Mesh workers', String(stats.workers)));
    this.statsNode.appendChild(statRow('Undo steps', String(editor.history.entries.length)));
  }
}
