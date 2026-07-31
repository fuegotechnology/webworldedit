/**
 * Block registry.
 *
 * Every block has a stable numeric runtime id (used in chunk storage), a Minecraft
 * resource name (used for `.schem` interop), a palette colour (used as a tint and as
 * a fallback when no client.jar atlas has been fetched), and per-face texture names
 * that map into the atlas produced by `scripts/fetch-assets.mjs`.
 */

import type { BlockId } from '../core/types';

export type BlockCategory =
  | 'natural'
  | 'stone'
  | 'wood'
  | 'building'
  | 'decoration'
  | 'ore'
  | 'liquid'
  | 'utility';

export interface FaceTextures {
  /** Texture name (atlas key) used for all faces unless overridden. */
  all?: string;
  top?: string;
  bottom?: string;
  side?: string;
}

export interface BlockDefinition {
  id: BlockId;
  name: string;
  /** Minecraft resource location without the namespace, e.g. `stone`. */
  mc: string;
  category: BlockCategory;
  /** sRGB hex tint used for fallback rendering and minimap colours. */
  color: number;
  textures: FaceTextures;
  transparent?: boolean;
  liquid?: boolean;
  /** Excluded from "solid" queries used by terrain/sculpt tools. */
  nonSolid?: boolean;
  tags?: string[];
}

export const AIR: BlockId = 0;

type Def = Omit<BlockDefinition, 'id'>;

const DEFS: Def[] = [
  { name: 'Air', mc: 'air', category: 'utility', color: 0x000000, textures: {}, transparent: true, nonSolid: true },

  // Natural
  { name: 'Grass Block', mc: 'grass_block', category: 'natural', color: 0x7cb342, textures: { top: 'grass_block_top', side: 'grass_block_side', bottom: 'dirt' }, tags: ['ground', 'green'] },
  { name: 'Dirt', mc: 'dirt', category: 'natural', color: 0x8b6144, textures: { all: 'dirt' }, tags: ['ground'] },
  { name: 'Coarse Dirt', mc: 'coarse_dirt', category: 'natural', color: 0x795a41, textures: { all: 'coarse_dirt' } },
  { name: 'Podzol', mc: 'podzol', category: 'natural', color: 0x5c4020, textures: { top: 'podzol_top', side: 'podzol_side', bottom: 'dirt' } },
  { name: 'Mycelium', mc: 'mycelium', category: 'natural', color: 0x6f6265, textures: { top: 'mycelium_top', side: 'mycelium_side', bottom: 'dirt' } },
  { name: 'Sand', mc: 'sand', category: 'natural', color: 0xdbcf8f, textures: { all: 'sand' }, tags: ['desert'] },
  { name: 'Red Sand', mc: 'red_sand', category: 'natural', color: 0xbf6a2e, textures: { all: 'red_sand' } },
  { name: 'Gravel', mc: 'gravel', category: 'natural', color: 0x82807e, textures: { all: 'gravel' } },
  { name: 'Clay', mc: 'clay', category: 'natural', color: 0x9fa5b3, textures: { all: 'clay' } },
  { name: 'Snow Block', mc: 'snow_block', category: 'natural', color: 0xf2fbfb, textures: { all: 'snow' }, tags: ['cold'] },
  { name: 'Ice', mc: 'ice', category: 'natural', color: 0x7ab5ff, textures: { all: 'ice' }, transparent: true },
  { name: 'Packed Ice', mc: 'packed_ice', category: 'natural', color: 0x8cb6f0, textures: { all: 'packed_ice' } },
  { name: 'Moss Block', mc: 'moss_block', category: 'natural', color: 0x596d29, textures: { all: 'moss_block' } },
  { name: 'Soul Sand', mc: 'soul_sand', category: 'natural', color: 0x51413a, textures: { all: 'soul_sand' } },

  // Stone
  { name: 'Stone', mc: 'stone', category: 'stone', color: 0x7d7d7d, textures: { all: 'stone' }, tags: ['grey'] },
  { name: 'Cobblestone', mc: 'cobblestone', category: 'stone', color: 0x7a7a7a, textures: { all: 'cobblestone' } },
  { name: 'Mossy Cobblestone', mc: 'mossy_cobblestone', category: 'stone', color: 0x6b7a5c, textures: { all: 'mossy_cobblestone' }, tags: ['mossy'] },
  { name: 'Stone Bricks', mc: 'stone_bricks', category: 'stone', color: 0x7a7a7a, textures: { all: 'stone_bricks' }, tags: ['castle'] },
  { name: 'Mossy Stone Bricks', mc: 'mossy_stone_bricks', category: 'stone', color: 0x6f7a63, textures: { all: 'mossy_stone_bricks' }, tags: ['mossy', 'castle'] },
  { name: 'Cracked Stone Bricks', mc: 'cracked_stone_bricks', category: 'stone', color: 0x767676, textures: { all: 'cracked_stone_bricks' }, tags: ['castle', 'ruin'] },
  { name: 'Chiseled Stone Bricks', mc: 'chiseled_stone_bricks', category: 'stone', color: 0x787878, textures: { all: 'chiseled_stone_bricks' } },
  { name: 'Smooth Stone', mc: 'smooth_stone', category: 'stone', color: 0x9e9e9e, textures: { all: 'smooth_stone' } },
  { name: 'Andesite', mc: 'andesite', category: 'stone', color: 0x8a8a8a, textures: { all: 'andesite' } },
  { name: 'Diorite', mc: 'diorite', category: 'stone', color: 0xbfbfbd, textures: { all: 'diorite' } },
  { name: 'Granite', mc: 'granite', category: 'stone', color: 0x9a6b58, textures: { all: 'granite' } },
  { name: 'Deepslate', mc: 'deepslate', category: 'stone', color: 0x4f4f53, textures: { all: 'deepslate', top: 'deepslate_top' } },
  { name: 'Cobbled Deepslate', mc: 'cobbled_deepslate', category: 'stone', color: 0x4c4c50, textures: { all: 'cobbled_deepslate' } },
  { name: 'Deepslate Bricks', mc: 'deepslate_bricks', category: 'stone', color: 0x484849, textures: { all: 'deepslate_bricks' } },
  { name: 'Blackstone', mc: 'blackstone', category: 'stone', color: 0x2b2427, textures: { all: 'blackstone' } },
  { name: 'Basalt', mc: 'basalt', category: 'stone', color: 0x4c4a4f, textures: { all: 'basalt_side', top: 'basalt_top' } },
  { name: 'Calcite', mc: 'calcite', category: 'stone', color: 0xdfdfd4, textures: { all: 'calcite' } },
  { name: 'Tuff', mc: 'tuff', category: 'stone', color: 0x6c6e66, textures: { all: 'tuff' } },
  { name: 'Sandstone', mc: 'sandstone', category: 'stone', color: 0xd8cea1, textures: { top: 'sandstone_top', side: 'sandstone', bottom: 'sandstone_bottom' } },
  { name: 'Obsidian', mc: 'obsidian', category: 'stone', color: 0x1b1229, textures: { all: 'obsidian' } },
  { name: 'Bedrock', mc: 'bedrock', category: 'stone', color: 0x555555, textures: { all: 'bedrock' } },
  { name: 'Netherrack', mc: 'netherrack', category: 'stone', color: 0x6f3a38, textures: { all: 'netherrack' } },
  { name: 'End Stone', mc: 'end_stone', category: 'stone', color: 0xdadca4, textures: { all: 'end_stone' } },
  { name: 'Prismarine', mc: 'prismarine', category: 'stone', color: 0x5f9e91, textures: { all: 'prismarine' } },

  // Wood
  { name: 'Oak Log', mc: 'oak_log', category: 'wood', color: 0x9c7f4e, textures: { side: 'oak_log', top: 'oak_log_top', bottom: 'oak_log_top' }, tags: ['tree'] },
  { name: 'Spruce Log', mc: 'spruce_log', category: 'wood', color: 0x6b5334, textures: { side: 'spruce_log', top: 'spruce_log_top', bottom: 'spruce_log_top' }, tags: ['tree'] },
  { name: 'Birch Log', mc: 'birch_log', category: 'wood', color: 0xcfc9a5, textures: { side: 'birch_log', top: 'birch_log_top', bottom: 'birch_log_top' }, tags: ['tree'] },
  { name: 'Jungle Log', mc: 'jungle_log', category: 'wood', color: 0x8f6d43, textures: { side: 'jungle_log', top: 'jungle_log_top', bottom: 'jungle_log_top' } },
  { name: 'Dark Oak Log', mc: 'dark_oak_log', category: 'wood', color: 0x53411f, textures: { side: 'dark_oak_log', top: 'dark_oak_log_top', bottom: 'dark_oak_log_top' } },
  { name: 'Oak Planks', mc: 'oak_planks', category: 'wood', color: 0xa9843f, textures: { all: 'oak_planks' }, tags: ['build'] },
  { name: 'Spruce Planks', mc: 'spruce_planks', category: 'wood', color: 0x7a5a34, textures: { all: 'spruce_planks' } },
  { name: 'Birch Planks', mc: 'birch_planks', category: 'wood', color: 0xc7b481, textures: { all: 'birch_planks' } },
  { name: 'Dark Oak Planks', mc: 'dark_oak_planks', category: 'wood', color: 0x4b3218, textures: { all: 'dark_oak_planks' } },
  { name: 'Oak Leaves', mc: 'oak_leaves', category: 'wood', color: 0x4f8a35, textures: { all: 'oak_leaves' }, transparent: true, tags: ['tree', 'foliage'] },
  { name: 'Spruce Leaves', mc: 'spruce_leaves', category: 'wood', color: 0x3c6b3c, textures: { all: 'spruce_leaves' }, transparent: true, tags: ['tree', 'foliage'] },
  { name: 'Birch Leaves', mc: 'birch_leaves', category: 'wood', color: 0x699b40, textures: { all: 'birch_leaves' }, transparent: true, tags: ['foliage'] },
  { name: 'Jungle Leaves', mc: 'jungle_leaves', category: 'wood', color: 0x3f8f2c, textures: { all: 'jungle_leaves' }, transparent: true, tags: ['foliage'] },

  // Building
  { name: 'Bricks', mc: 'bricks', category: 'building', color: 0x9a5a4a, textures: { all: 'bricks' } },
  { name: 'Nether Bricks', mc: 'nether_bricks', category: 'building', color: 0x2f171b, textures: { all: 'nether_bricks' } },
  { name: 'Quartz Block', mc: 'quartz_block', category: 'building', color: 0xeae5dd, textures: { all: 'quartz_block_side', top: 'quartz_block_top' } },
  { name: 'White Concrete', mc: 'white_concrete', category: 'building', color: 0xcfd5d6, textures: { all: 'white_concrete' } },
  { name: 'Grey Concrete', mc: 'gray_concrete', category: 'building', color: 0x3a3d43, textures: { all: 'gray_concrete' } },
  { name: 'Black Concrete', mc: 'black_concrete', category: 'building', color: 0x080a0f, textures: { all: 'black_concrete' } },
  { name: 'Terracotta', mc: 'terracotta', category: 'building', color: 0x9a6650, textures: { all: 'terracotta' } },
  { name: 'White Wool', mc: 'white_wool', category: 'building', color: 0xe9ecec, textures: { all: 'white_wool' } },
  { name: 'Red Wool', mc: 'red_wool', category: 'building', color: 0xa02722, textures: { all: 'red_wool' } },
  { name: 'Blue Wool', mc: 'blue_wool', category: 'building', color: 0x35399d, textures: { all: 'blue_wool' } },
  { name: 'Glass', mc: 'glass', category: 'building', color: 0xd6f4ff, textures: { all: 'glass' }, transparent: true },
  { name: 'Glowstone', mc: 'glowstone', category: 'building', color: 0xf9d99b, textures: { all: 'glowstone' }, tags: ['light'] },
  { name: 'Sea Lantern', mc: 'sea_lantern', category: 'building', color: 0xc6d6cf, textures: { all: 'sea_lantern' }, tags: ['light'] },
  { name: 'Bookshelf', mc: 'bookshelf', category: 'decoration', color: 0x846a3f, textures: { side: 'bookshelf', top: 'oak_planks', bottom: 'oak_planks' } },
  { name: 'Hay Bale', mc: 'hay_block', category: 'decoration', color: 0xb8991b, textures: { side: 'hay_block_side', top: 'hay_block_top', bottom: 'hay_block_top' } },
  { name: 'Pumpkin', mc: 'pumpkin', category: 'decoration', color: 0xc07615, textures: { side: 'pumpkin_side', top: 'pumpkin_top', bottom: 'pumpkin_top' } },

  // Ore
  { name: 'Coal Ore', mc: 'coal_ore', category: 'ore', color: 0x50504e, textures: { all: 'coal_ore' } },
  { name: 'Iron Ore', mc: 'iron_ore', category: 'ore', color: 0xa08b7c, textures: { all: 'iron_ore' } },
  { name: 'Gold Ore', mc: 'gold_ore', category: 'ore', color: 0xa4924f, textures: { all: 'gold_ore' } },
  { name: 'Diamond Ore', mc: 'diamond_ore', category: 'ore', color: 0x6c9e9a, textures: { all: 'diamond_ore' } },
  { name: 'Redstone Ore', mc: 'redstone_ore', category: 'ore', color: 0x8a5050, textures: { all: 'redstone_ore' } },
  { name: 'Emerald Ore', mc: 'emerald_ore', category: 'ore', color: 0x6d9271, textures: { all: 'emerald_ore' } },
  { name: 'Lapis Ore', mc: 'lapis_ore', category: 'ore', color: 0x6379a0, textures: { all: 'lapis_ore' } },
  { name: 'Iron Block', mc: 'iron_block', category: 'ore', color: 0xd8d8d8, textures: { all: 'iron_block' } },
  { name: 'Gold Block', mc: 'gold_block', category: 'ore', color: 0xf9ec4e, textures: { all: 'gold_block' } },
  { name: 'Diamond Block', mc: 'diamond_block', category: 'ore', color: 0x62e8e0, textures: { all: 'diamond_block' } },

  // Liquid
  { name: 'Water', mc: 'water', category: 'liquid', color: 0x3b6fd6, textures: { all: 'water_still' }, transparent: true, liquid: true, nonSolid: true, tags: ['river', 'sea'] },
  { name: 'Lava', mc: 'lava', category: 'liquid', color: 0xe06b12, textures: { all: 'lava_still' }, liquid: true, nonSolid: true, tags: ['light'] },
];

export class BlockRegistry {
  readonly blocks: BlockDefinition[] = [];
  private byMc = new Map<string, BlockDefinition>();
  private byName = new Map<string, BlockDefinition>();

  constructor(defs: Def[] = DEFS) {
    defs.forEach((def, id) => this.register({ ...def, id }));
  }

  register(def: BlockDefinition): BlockDefinition {
    this.blocks[def.id] = def;
    this.byMc.set(def.mc, def);
    this.byName.set(def.name.toLowerCase(), def);
    return def;
  }

  get(id: BlockId): BlockDefinition {
    return this.blocks[id] ?? this.blocks[AIR];
  }

  byMinecraftName(mc: string): BlockDefinition | undefined {
    return this.byMc.get(mc.replace(/^minecraft:/, '').replace(/\[.*$/, ''));
  }

  /** Resolve loose user/AI input: "mossy stone", "minecraft:oak_log", "Stone". */
  resolve(query: string): BlockDefinition | undefined {
    const q = query.trim().toLowerCase().replace(/^minecraft:/, '');
    return (
      this.byMc.get(q) ??
      this.byName.get(q) ??
      this.byMc.get(q.replace(/\s+/g, '_')) ??
      this.blocks.find((b) => b && b.name.toLowerCase() === q) ??
      this.blocks.find((b) => b && (b.name.toLowerCase().includes(q) || b.mc.includes(q.replace(/\s+/g, '_'))))
    );
  }

  search(query: string, category?: BlockCategory | 'all'): BlockDefinition[] {
    const q = query.trim().toLowerCase();
    return this.blocks.filter((b) => {
      if (!b || b.id === AIR) return false;
      if (category && category !== 'all' && b.category !== category) return false;
      if (!q) return true;
      return (
        b.name.toLowerCase().includes(q) ||
        b.mc.includes(q.replace(/\s+/g, '_')) ||
        (b.tags ?? []).some((t) => t.includes(q))
      );
    });
  }

  categories(): BlockCategory[] {
    return [...new Set(this.blocks.filter(Boolean).map((b) => b.category))];
  }

  isSolid(id: BlockId): boolean {
    const b = this.get(id);
    return id !== AIR && !b.nonSolid;
  }

  isOpaque(id: BlockId): boolean {
    const b = this.get(id);
    return id !== AIR && !b.transparent && !b.liquid;
  }
}

export const blockRegistry = new BlockRegistry();
