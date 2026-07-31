/**
 * Biome palettes.
 *
 * A biome here is a purely cosmetic surface recipe (layer stack + scatter rules)
 * used by the paint tool and by the AI terrain generators. It deliberately does
 * not model Minecraft's biome registry — it maps onto block operations.
 */

import { blockRegistry } from '../world/blocks';
import type { BlockId } from '../core/types';

export interface BiomeLayer {
  block: string;
  depth: number;
}

export interface BiomeScatter {
  block: string;
  /** Chance per surface column. */
  density: number;
}

export interface BiomeDefinition {
  id: string;
  name: string;
  color: number;
  layers: BiomeLayer[];
  scatter?: BiomeScatter[];
  /** Tree species used by forest generation. */
  tree?: { log: string; leaves: string; minHeight: number; maxHeight: number };
}

export const BIOMES: BiomeDefinition[] = [
  {
    id: 'plains',
    name: 'Plains',
    color: 0x7cb342,
    layers: [
      { block: 'grass_block', depth: 1 },
      { block: 'dirt', depth: 3 },
      { block: 'stone', depth: 8 },
    ],
    tree: { log: 'oak_log', leaves: 'oak_leaves', minHeight: 4, maxHeight: 6 },
  },
  {
    id: 'forest',
    name: 'Forest',
    color: 0x4f8a35,
    layers: [
      { block: 'grass_block', depth: 1 },
      { block: 'dirt', depth: 4 },
      { block: 'stone', depth: 8 },
    ],
    tree: { log: 'oak_log', leaves: 'oak_leaves', minHeight: 5, maxHeight: 8 },
  },
  {
    id: 'taiga',
    name: 'Taiga',
    color: 0x3c6b3c,
    layers: [
      { block: 'podzol', depth: 1 },
      { block: 'dirt', depth: 3 },
      { block: 'stone', depth: 8 },
    ],
    tree: { log: 'spruce_log', leaves: 'spruce_leaves', minHeight: 7, maxHeight: 12 },
  },
  {
    id: 'desert',
    name: 'Desert',
    color: 0xdbcf8f,
    layers: [
      { block: 'sand', depth: 4 },
      { block: 'sandstone', depth: 6 },
      { block: 'stone', depth: 8 },
    ],
  },
  {
    id: 'badlands',
    name: 'Badlands',
    color: 0xbf6a2e,
    layers: [
      { block: 'red_sand', depth: 2 },
      { block: 'terracotta', depth: 8 },
      { block: 'stone', depth: 6 },
    ],
  },
  {
    id: 'snowy',
    name: 'Snowy Peaks',
    color: 0xf2fbfb,
    layers: [
      { block: 'snow_block', depth: 2 },
      { block: 'stone', depth: 6 },
      { block: 'deepslate', depth: 8 },
    ],
    tree: { log: 'spruce_log', leaves: 'spruce_leaves', minHeight: 5, maxHeight: 9 },
  },
  {
    id: 'mountain',
    name: 'Stone Mountain',
    color: 0x8a8a8a,
    layers: [
      { block: 'stone', depth: 6 },
      { block: 'andesite', depth: 4 },
      { block: 'deepslate', depth: 10 },
    ],
  },
  {
    id: 'swamp',
    name: 'Swamp',
    color: 0x596d29,
    layers: [
      { block: 'moss_block', depth: 1 },
      { block: 'dirt', depth: 3 },
      { block: 'clay', depth: 3 },
    ],
    tree: { log: 'dark_oak_log', leaves: 'oak_leaves', minHeight: 4, maxHeight: 7 },
  },
  {
    id: 'jungle',
    name: 'Jungle',
    color: 0x3f8f2c,
    layers: [
      { block: 'grass_block', depth: 1 },
      { block: 'dirt', depth: 5 },
      { block: 'stone', depth: 8 },
    ],
    tree: { log: 'jungle_log', leaves: 'jungle_leaves', minHeight: 8, maxHeight: 14 },
  },
  {
    id: 'volcanic',
    name: 'Volcanic',
    color: 0x2b2427,
    layers: [
      { block: 'basalt', depth: 3 },
      { block: 'blackstone', depth: 5 },
      { block: 'netherrack', depth: 8 },
    ],
  },
];

export const biomeById = (id: string): BiomeDefinition =>
  BIOMES.find((b) => b.id === id) ?? BIOMES[0];

/** Resolves a biome's layer stack to concrete block ids. */
export function resolveLayers(biome: BiomeDefinition): Array<{ id: BlockId; depth: number }> {
  return biome.layers.map((l) => ({
    id: blockRegistry.resolve(l.block)?.id ?? 0,
    depth: l.depth,
  }));
}

/** Fuzzy match a biome from free text (used by the AI command parser). */
export function matchBiome(text: string): BiomeDefinition | undefined {
  const t = text.toLowerCase();
  return (
    BIOMES.find((b) => t.includes(b.id)) ??
    BIOMES.find((b) => t.includes(b.name.toLowerCase())) ??
    (t.includes('snow') || t.includes('arctic') ? biomeById('snowy') : undefined) ??
    (t.includes('sand') || t.includes('dune') ? biomeById('desert') : undefined) ??
    (t.includes('lava') || t.includes('volcano') ? biomeById('volcanic') : undefined) ??
    (t.includes('tree') || t.includes('woods') ? biomeById('forest') : undefined)
  );
}
