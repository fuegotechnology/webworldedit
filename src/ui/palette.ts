/**
 * Searchable block palette with category filtering, rendered from the block
 * registry and drawing its swatches from the loaded texture atlas.
 */

import { blockRegistry, type BlockCategory, type BlockDefinition } from '../world/blocks';
import type { Atlas } from '../render/atlas';
import { blockSwatchStyle, clear, el } from './dom';

export interface PaletteOptions {
  atlas: Atlas;
  onPick: (block: BlockDefinition) => void;
  onSecondary?: (block: BlockDefinition) => void;
}

export class BlockPalette {
  readonly root: HTMLElement;
  private grid: HTMLElement;
  private searchInput: HTMLInputElement;
  private chips: HTMLElement;
  private query = '';
  private category: BlockCategory | 'all' = 'all';
  private activeId = -1;
  private options: PaletteOptions;
  private atlasUrl: string;

  constructor(options: PaletteOptions) {
    this.options = options;
    this.atlasUrl = options.atlas.authentic ? 'assets/atlas.png' : this.canvasUrl(options.atlas);

    this.searchInput = el('input', {
      class: 'palette-search',
      attrs: { type: 'search', placeholder: 'Search blocks…', spellcheck: 'false' },
      on: {
        input: (e) => {
          this.query = (e.target as HTMLInputElement).value;
          this.renderGrid();
        },
      },
    });

    this.chips = el('div', { class: 'category-chips' });
    this.grid = el('div', { class: 'block-grid' });
    this.root = el('div', {}, [this.searchInput, this.chips, this.grid]);

    this.renderChips();
    this.renderGrid();
  }

  private canvasUrl(atlas: Atlas): string {
    const image = atlas.texture.image as HTMLCanvasElement | HTMLImageElement;
    if (image instanceof HTMLCanvasElement) return image.toDataURL();
    return (image as HTMLImageElement).src ?? '';
  }

  focusSearch(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  setActive(id: number): void {
    this.activeId = id;
    for (const node of this.grid.children) {
      const element = node as HTMLElement;
      element.classList.toggle('active', Number(element.dataset.id) === id);
    }
  }

  /** Style object for a block, used by the hotbar and active-block card too. */
  styleFor(block: BlockDefinition): Partial<CSSStyleDeclaration> {
    const textureName = block.textures.side ?? block.textures.all ?? block.textures.top;
    const index = this.options.atlas.indexOf(textureName);
    const { columns, height, tile } = this.options.atlas.manifest;
    return blockSwatchStyle(block.color, {
      url: this.atlasUrl,
      columns,
      rows: Math.max(1, Math.round(height / tile)),
      index,
    });
  }

  private renderChips(): void {
    clear(this.chips);
    const categories: Array<BlockCategory | 'all'> = ['all', ...blockRegistry.categories()];
    for (const category of categories) {
      this.chips.appendChild(
        el('button', {
          class: `chip ${category === this.category ? 'active' : ''}`,
          text: category,
          on: {
            click: () => {
              this.category = category;
              this.renderChips();
              this.renderGrid();
            },
          },
        }),
      );
    }
  }

  private renderGrid(): void {
    clear(this.grid);
    const results = blockRegistry.search(this.query, this.category);

    if (results.length === 0) {
      this.grid.appendChild(
        el('div', { class: 'faint', text: 'No blocks match that search.', style: { gridColumn: '1 / -1' } }),
      );
      return;
    }

    for (const block of results.slice(0, 400)) {
      const swatch = el(
        'div',
        {
          class: `block-swatch ${block.id === this.activeId ? 'active' : ''}`,
          title: `${block.name}\nminecraft:${block.mc}`,
          data: { id: block.id },
          style: this.styleFor(block),
          on: {
            click: () => {
              this.setActive(block.id);
              this.options.onPick(block);
            },
            contextmenu: (e) => {
              e.preventDefault();
              this.options.onSecondary?.(block);
            },
          },
        },
        [el('span', { class: 'label', text: block.name })],
      );
      this.grid.appendChild(swatch);
    }
  }
}
