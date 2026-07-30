/**
 * Local natural-language → operation compiler.
 *
 * This is a deterministic, offline rule engine. It handles the documented
 * command vocabulary without any network access, and it is also the validator
 * for plans returned by a remote LLM, so a hosted model can never make the
 * editor perform an operation this module doesn't understand.
 */

import { blockRegistry } from '../world/blocks';
import { BIOMES, matchBiome } from '../edit/biomes';
import { STYLES } from './structures';
import type { AiOperation, AiPlan, PointRef, RegionRef } from './intents';

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, dozen: 12, twenty: 20, fifty: 50, hundred: 100,
};

const SIZE_WORDS: Record<string, number> = {
  tiny: 0.4, small: 0.6, little: 0.6, modest: 0.8, medium: 1, normal: 1,
  large: 1.5, big: 1.5, huge: 2.2, massive: 2.8, enormous: 3, giant: 3, colossal: 3.5, epic: 2.6,
};

/** Extract a leading number ("build 12 houses", "radius of twenty"). */
function findNumber(text: string, near?: RegExp): number | undefined {
  if (near) {
    const m = near.exec(text);
    if (m) {
      const digits = /(\d+(?:\.\d+)?)/.exec(m[0]);
      if (digits) return Number(digits[1]);
      for (const [word, value] of Object.entries(NUMBER_WORDS))
        if (m[0].includes(word)) return value;
    }
  }
  const m = /\b(\d+(?:\.\d+)?)\b/.exec(text);
  return m ? Number(m[1]) : undefined;
}

function sizeMultiplier(text: string): number {
  for (const [word, mult] of Object.entries(SIZE_WORDS)) if (text.includes(word)) return mult;
  return 1;
}

function findBlock(text: string, fallback: string): string {
  // Prefer explicit "of X" / "with X" / "out of X" phrasing.
  const phrase = /(?:out of|made of|from|with|using|in)\s+([a-z_ ]{3,32})/.exec(text);
  if (phrase) {
    const found = blockRegistry.resolve(phrase[1].trim());
    if (found && found.id !== 0) return found.mc;
  }
  // Otherwise scan for any block name appearing in the text.
  let best: { mc: string; len: number } | null = null;
  for (const block of blockRegistry.blocks) {
    if (!block || block.id === 0) continue;
    const nameForms = [block.name.toLowerCase(), block.mc.replace(/_/g, ' ')];
    for (const form of nameForms) {
      if (form.length < 3) continue;
      if (text.includes(form) && (!best || form.length > best.len)) best = { mc: block.mc, len: form.length };
    }
  }
  return best?.mc ?? fallback;
}

function findStyle(text: string): string | undefined {
  for (const key of Object.keys(STYLES)) if (text.includes(key)) return key;
  if (/\b(stone|castle|keep|fort|knight)\b/.test(text)) return 'medieval';
  if (/\b(wood|cottage|farm|barn|rustic|village)\b/.test(text)) return 'rustic';
  if (/\b(sand|desert|pyramid|dune|oasis)\b/.test(text)) return 'desert';
  if (/\b(modern|glass|city|skyscraper|concrete)\b/.test(text)) return 'modern';
  if (/\b(dark|evil|nether|obsidian|fortress of doom|demon)\b/.test(text)) return 'dark';
  return undefined;
}

/** Where should the operation happen? */
function findRegion(text: string, radiusHint: number): RegionRef {
  if (/\b(selection|selected|this area|here in the selection)\b/.test(text)) return 'selection';
  if (/\b(whole world|entire world|everywhere|all blocks|the world)\b/.test(text)) return 'world';
  return { around: 'cursor', radius: radiusHint };
}

function findPoint(text: string): PointRef {
  if (/\bselection\b/.test(text)) return 'selection-center';
  if (/\b(at the camera|where i am|my position)\b/.test(text)) return 'camera';
  const coords = /\bat\s+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/.exec(text);
  if (coords) return { x: Number(coords[1]), y: Number(coords[2]), z: Number(coords[3]) };
  return 'cursor';
}

interface Rule {
  id: string;
  /** Higher wins when several rules match. */
  weight: number;
  test: RegExp;
  build(text: string, ctx: { size: number; region: RegionRef; point: PointRef; seed: number }): {
    ops: AiOperation[];
    summary: string;
  };
}

const RULES: Rule[] = [
  // ---------------------------------------------------------------- replace
  {
    id: 'replace',
    weight: 10,
    test: /\breplace\b|\bswap\b|\bturn all\b|\bconvert all\b|\bchange all\b/,
    build(text, ctx) {
      const m =
        /replace\s+(?:all\s+|every\s+)?(?:the\s+)?([a-z_ ]+?)\s+(?:with|to|into|for)\s+([a-z_ ]+)/.exec(text) ??
        /(?:turn|change|convert)\s+(?:all\s+)?(?:the\s+)?([a-z_ ]+?)\s+(?:in)?to\s+([a-z_ ]+)/.exec(text);
      const from = m ? blockRegistry.resolve(m[1].trim())?.mc ?? 'stone' : 'stone';
      const to = m ? blockRegistry.resolve(m[2].trim())?.mc ?? 'mossy_cobblestone' : 'mossy_cobblestone';
      const region = /\ball\b|\beverywhere\b|\bwhole\b/.test(text) && !/\bselection\b/.test(text) ? 'world' : ctx.region;
      return {
        ops: [{ op: 'replace', region, from, to }],
        summary: `Replace ${blockRegistry.resolve(from)?.name ?? from} with ${blockRegistry.resolve(to)?.name ?? to}`,
      };
    },
  },

  // ---------------------------------------------------------------- castle
  {
    id: 'castle',
    weight: 9,
    test: /\bcastle\b|\bfortress\b|\bkeep\b|\bcitadel\b|\bstronghold\b|\bfort\b/,
    build(text, ctx) {
      const size = Math.round(
        (findNumber(text, /(\d+)\s*(?:block|wide|across|size)/) ?? 40) * (findNumber(text, /(\d+)/) ? 1 : ctx.size),
      );
      const style = findStyle(text) ?? 'medieval';
      const moat = !/\bno moat\b|\bwithout a moat\b/.test(text);
      return {
        ops: [{ op: 'castle', at: ctx.point, size: Math.max(20, Math.min(140, size)), style, moat, seed: ctx.seed }],
        summary: `Build a ${style} castle (${Math.max(20, Math.min(140, size))} blocks across)${moat ? ' with a moat' : ''}`,
      };
    },
  },

  // ---------------------------------------------------------------- village
  {
    id: 'village',
    weight: 8,
    test: /\bvillage\b|\btown\b|\bsettlement\b|\bhamlet\b/,
    build(text, ctx) {
      const houses = Math.max(3, Math.min(40, Math.round((findNumber(text, /(\d+)\s*(?:houses?|buildings?)/) ?? 8) * (findNumber(text) ? 1 : ctx.size))));
      const style = findStyle(text) ?? 'rustic';
      return {
        ops: [{ op: 'village', at: ctx.point, houses, radius: Math.round(28 + houses * 3), style, seed: ctx.seed }],
        summary: `Build a ${style} village of ${houses} houses`,
      };
    },
  },

  // ---------------------------------------------------------------- tower
  {
    id: 'tower',
    weight: 7,
    test: /\btower\b|\bspire\b|\bwatchtower\b|\bobelisk\b|\blighthouse\b/,
    build(text, ctx) {
      const height = Math.round((findNumber(text, /(\d+)\s*(?:block|tall|high)/) ?? 24) * (findNumber(text) ? 1 : ctx.size));
      const radius = Math.max(2, Math.round(4 * ctx.size));
      return {
        ops: [{ op: 'tower', at: ctx.point, radius, height: Math.max(6, Math.min(180, height)), style: findStyle(text) ?? 'medieval' }],
        summary: `Build a ${Math.max(6, Math.min(180, height))}-block tower`,
      };
    },
  },

  // ---------------------------------------------------------------- house
  {
    id: 'house',
    weight: 6,
    test: /\bhouse\b|\bcottage\b|\bcabin\b|\bhut\b|\bhome\b|\bshack\b|\bbarn\b/,
    build(text, ctx) {
      const w = Math.max(5, Math.round(9 * ctx.size));
      return {
        ops: [{ op: 'house', at: ctx.point, width: w, depth: Math.max(5, Math.round(w * 0.8)), height: Math.max(4, Math.round(5 * ctx.size)), style: findStyle(text) ?? 'rustic' }],
        summary: `Build a ${findStyle(text) ?? 'rustic'} house`,
      };
    },
  },

  // ---------------------------------------------------------------- pyramid
  {
    id: 'pyramid',
    weight: 7,
    test: /\bpyramid\b|\bziggurat\b/,
    build(text, ctx) {
      const size = Math.max(6, Math.round((findNumber(text) ?? 24) * (findNumber(text) ? 1 : ctx.size)));
      return {
        ops: [{ op: 'pyramid', at: ctx.point, size, style: findStyle(text) ?? 'desert', hollow: /\bhollow\b/.test(text) }],
        summary: `Build a ${size}-block pyramid`,
      };
    },
  },

  // ---------------------------------------------------------------- bridge
  {
    id: 'bridge',
    weight: 7,
    test: /\bbridge\b|\bviaduct\b|\baqueduct\b/,
    build(text, ctx) {
      const length = Math.round((findNumber(text, /(\d+)\s*(?:block|long)/) ?? 48) * (findNumber(text) ? 1 : ctx.size));
      return {
        ops: [
          {
            op: 'bridge',
            from: ctx.point,
            to: typeof ctx.point === 'object' ? { x: ctx.point.x + length, y: ctx.point.y, z: ctx.point.z } : 'cursor-offset-x' as unknown as PointRef,
            width: Math.max(3, Math.round(5 * ctx.size)),
            style: findStyle(text) ?? 'medieval',
          },
        ],
        summary: `Build a ${length}-block bridge`,
      };
    },
  },

  // ---------------------------------------------------------------- great wall
  {
    id: 'wall',
    weight: 6,
    test: /\bgreat wall\b|\bdefensive wall\b|\brampart\b|\bcity wall\b|\bbuild a wall\b/,
    build(text, ctx) {
      const length = Math.round((findNumber(text, /(\d+)\s*(?:block|long)/) ?? 80) * (findNumber(text) ? 1 : ctx.size));
      const height = Math.round((findNumber(text, /(\d+)\s*(?:tall|high)/) ?? 10) * ctx.size);
      return {
        ops: [
          {
            op: 'wall',
            from: ctx.point,
            to: typeof ctx.point === 'object' ? { x: ctx.point.x + length, y: ctx.point.y, z: ctx.point.z } : ctx.point,
            height: Math.max(3, height),
            thickness: 3,
            style: findStyle(text) ?? 'medieval',
          },
        ],
        summary: `Build a ${length}-block defensive wall`,
      };
    },
  },

  // ---------------------------------------------------------------- mountain
  {
    id: 'mountain',
    weight: 9,
    test: /\bmountain\b|\bpeak\b|\bmassif\b|\bvolcano\b|\bmesa\b|\bcliff\b/,
    build(text, ctx) {
      const height = Math.round((findNumber(text, /(\d+)\s*(?:block|tall|high)/) ?? 70) * (findNumber(text) ? 1 : ctx.size));
      const radius = Math.round((findNumber(text, /(\d+)\s*(?:wide|radius|across)/) ?? 52) * (findNumber(text) ? 1 : ctx.size));
      const biome = /\bvolcano\b|\blava\b/.test(text) ? 'volcanic' : /\bsnow\b|\bice\b|\balpine\b/.test(text) ? 'snowy' : 'mountain';
      return {
        ops: [{ op: 'mountain', at: ctx.point, radius: Math.min(220, radius), height: Math.min(200, height), biome, seed: ctx.seed }],
        summary: `Raise a ${Math.min(200, height)}-block mountain (radius ${Math.min(220, radius)})`,
      };
    },
  },

  // ---------------------------------------------------------------- hills
  {
    id: 'hills',
    weight: 8,
    test: /\brolling hills\b|\bhills\b|\bterraform\b|\bhilly\b|\bundulating\b/,
    build(text, ctx) {
      const amplitude = Math.round((findNumber(text, /(\d+)\s*(?:block|tall|high)/) ?? 10) * ctx.size);
      const biome = matchBiome(text)?.id ?? 'plains';
      return {
        ops: [
          { op: 'hills', region: ctx.region, amplitude: Math.max(2, amplitude), scale: Math.round(40 * ctx.size), biome, seed: ctx.seed },
          { op: 'smooth', region: ctx.region, iterations: 2 },
        ],
        summary: `Terraform into rolling hills (±${Math.max(2, amplitude)} blocks, ${biome})`,
      };
    },
  },

  // ---------------------------------------------------------------- terrain
  {
    id: 'terrain',
    weight: 6,
    test: /\bterrain\b|\bgenerate (?:a )?(?:land|ground|island)\b|\bmake (?:some )?ground\b|\bisland\b/,
    build(text, ctx) {
      const biome = matchBiome(text)?.id ?? 'plains';
      return {
        ops: [{ op: 'terrain', region: ctx.region, biome, amplitude: Math.round(16 * ctx.size), scale: Math.round(70 * ctx.size), seed: ctx.seed, water: /\bwater\b|\bocean\b|\bsea\b|\bisland\b/.test(text), seaLevel: 60 }],
        summary: `Generate ${biome} terrain`,
      };
    },
  },

  // ---------------------------------------------------------------- forest
  {
    id: 'forest',
    weight: 9,
    test: /\bforest\b|\btrees\b|\bwoods\b|\bjungle\b|\bplant\b|\borchard\b|\btaiga\b/,
    build(text, ctx) {
      const dense = /\bdense\b|\bthick\b|\bheavy\b|\blush\b/.test(text);
      const sparse = /\bsparse\b|\bfew\b|\bscattered\b|\blight\b/.test(text);
      const density = dense ? 0.1 : sparse ? 0.015 : 0.045;
      const biome = matchBiome(text)?.id ?? 'forest';
      if (/\ba tree\b|\bone tree\b|\bsingle tree\b/.test(text)) {
        return { ops: [{ op: 'tree', at: ctx.point, biome, seed: ctx.seed }], summary: 'Plant a tree' };
      }
      return {
        ops: [{ op: 'forest', region: ctx.region, density, biome, seed: ctx.seed }],
        summary: `Plant a ${dense ? 'dense ' : sparse ? 'sparse ' : ''}${biome} forest`,
      };
    },
  },

  // ---------------------------------------------------------------- river
  {
    id: 'river',
    weight: 9,
    test: /\briver\b|\bstream\b|\bcreek\b|\bcanal\b/,
    build(text, ctx) {
      const width = Math.round((findNumber(text, /(\d+)\s*(?:block)?\s*wide/) ?? 7) * (findNumber(text) ? 1 : ctx.size));
      return {
        ops: [{ op: 'river', region: ctx.region, width: Math.max(2, Math.min(60, width)), depth: Math.max(2, Math.round(4 * ctx.size)), seed: ctx.seed }],
        summary: `Carve a river ${Math.max(2, Math.min(60, width))} blocks wide`,
      };
    },
  },

  // ---------------------------------------------------------------- lake
  {
    id: 'lake',
    weight: 8,
    test: /\blake\b|\bpond\b|\bpool\b|\breservoir\b|\boasis\b/,
    build(text, ctx) {
      const radius = Math.round((findNumber(text) ?? 18) * (findNumber(text) ? 1 : ctx.size));
      return {
        ops: [{ op: 'lake', at: ctx.point, radius: Math.max(3, Math.min(160, radius)), depth: Math.max(2, Math.round(5 * ctx.size)) }],
        summary: `Dig a lake with radius ${Math.max(3, Math.min(160, radius))}`,
      };
    },
  },

  // ---------------------------------------------------------------- biome paint
  {
    id: 'paintBiome',
    weight: 7,
    test: /\bpaint\b.*\bbiome\b|\bmake (?:this|it) (?:a )?(?:snowy|desert|jungle|swamp|taiga)\b|\bturn (?:this|it) into (?:a )?(?:snowy|desert|jungle|swamp)\b|\bbiome\b/,
    build(text, ctx) {
      const biome = matchBiome(text)?.id ?? 'plains';
      return {
        ops: [{ op: 'paintBiome', region: ctx.region, biome }],
        summary: `Repaint the surface as ${BIOMES.find((b) => b.id === biome)?.name ?? biome}`,
      };
    },
  },

  // ---------------------------------------------------------------- sphere/dome
  {
    id: 'dome',
    weight: 6,
    test: /\bdome\b|\bsphere\b|\bball\b|\borb\b/,
    build(text, ctx) {
      const radius = Math.max(2, Math.round((findNumber(text) ?? 12) * (findNumber(text) ? 1 : ctx.size)));
      const block = findBlock(text, /\bdome\b/.test(text) ? 'glass' : 'stone');
      if (/\bdome\b/.test(text)) {
        return { ops: [{ op: 'dome', at: ctx.point, radius, block, hollow: !/\bsolid\b/.test(text) }], summary: `Build a ${block} dome (radius ${radius})` };
      }
      return {
        ops: [{ op: 'brush', at: ctx.point, shape: 'sphere', radius, block, hollow: /\bhollow\b/.test(text) }],
        summary: `Create a ${block} sphere (radius ${radius})`,
      };
    },
  },

  // ---------------------------------------------------------------- flatten
  {
    id: 'flatten',
    weight: 8,
    test: /\bflatten\b|\blevel (?:this|the ground|it)\b|\bmake (?:this|it) flat\b/,
    build(text, ctx) {
      return {
        ops: [{ op: 'flatten', region: ctx.region, block: findBlock(text, 'grass_block') }],
        summary: 'Flatten the terrain',
      };
    },
  },

  // ---------------------------------------------------------------- smooth
  {
    id: 'smooth',
    weight: 7,
    test: /\bsmooth\b|\bsoften\b|\berode\b/,
    build(_text, ctx) {
      return { ops: [{ op: 'smooth', region: ctx.region, iterations: 3 }], summary: 'Smooth the terrain' };
    },
  },

  // ---------------------------------------------------------------- clear
  {
    id: 'clear',
    weight: 8,
    test: /\bclear\b|\bdelete\b|\berase\b|\bremove everything\b|\bempty\b|\bdemolish\b/,
    build(_text, ctx) {
      return { ops: [{ op: 'clear', region: ctx.region }], summary: 'Clear the area to air' };
    },
  },

  // ---------------------------------------------------------------- fill
  {
    id: 'fill',
    weight: 5,
    test: /\bfill\b|\bmake (?:it|this) (?:all )?[a-z_ ]+\b|\bset (?:the )?(?:selection|area)\b/,
    build(text, ctx) {
      const block = findBlock(text, 'stone');
      const hollowish = /\bwalls?\b/.test(text);
      if (hollowish) return { ops: [{ op: 'walls', region: ctx.region, block, thickness: 1 }], summary: `Build ${block} walls` };
      return { ops: [{ op: 'fill', region: ctx.region, block }], summary: `Fill with ${blockRegistry.resolve(block)?.name ?? block}` };
    },
  },
];

/** Compiles a natural-language prompt into a plan. */
export function parsePrompt(prompt: string, options: { seed?: number } = {}): AiPlan {
  const text = prompt.toLowerCase().trim();
  const seed = options.seed ?? Math.floor(Math.random() * 1e9);
  const size = sizeMultiplier(text);
  const point = findPoint(text);
  const radiusHint = Math.round(64 * size);
  const region = findRegion(text, radiusHint);
  const ctx = { size, region, point, seed };

  const matches = RULES.filter((r) => r.test.test(text)).sort((a, b) => b.weight - a.weight);

  if (matches.length === 0) {
    return {
      summary: 'Could not understand that request',
      operations: [],
      source: 'local',
      confidence: 0,
      warnings: [
        'Try phrasing it like: "build a medieval castle here", "create a mountain",',
        '"plant a dense forest", "replace all stone with mossy cobblestone",',
        '"generate a river", or "terraform this into rolling hills".',
      ],
    };
  }

  // Compose: a primary rule plus any strongly-matching secondary rules
  // ("build a castle on a mountain surrounded by forest").
  const primary = matches[0];
  const built = primary.build(text, ctx);
  const operations = [...built.ops];
  const summaries = [built.summary];

  for (const rule of matches.slice(1, 3)) {
    if (rule.weight < 6) continue;
    // Avoid contradictory pairs.
    if (rule.id === 'clear' || primary.id === 'clear') continue;
    if (rule.id === 'fill') continue;
    const extra = rule.build(text, ctx);
    operations.push(...extra.ops);
    summaries.push(extra.summary);
  }

  return {
    summary: summaries.join(', then '),
    operations,
    source: 'local',
    confidence: Math.min(1, 0.55 + matches.length * 0.15),
  };
}

/** Example prompts surfaced in the UI. */
export const EXAMPLE_PROMPTS = [
  'Build a medieval castle here',
  'Create a mountain',
  'Plant a dense forest',
  'Replace all stone with mossy cobblestone',
  'Generate a river',
  'Terraform this into rolling hills',
  'Build a rustic village of 10 houses',
  'Make a huge snowy mountain',
  'Dig a large lake here',
  'Build a glass dome radius 20',
  'Flatten this area',
  'Paint this as desert biome',
];
