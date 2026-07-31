/**
 * Intent schema.
 *
 * The AI assistant's contract: a prompt is compiled into a list of `AiOperation`
 * objects. These are *declarative descriptions of editor operations*, not
 * geometry — which is what makes AI edits reviewable, previewable, deterministic
 * and undoable.
 *
 * A remote LLM (see `provider.ts`) is asked to emit exactly this JSON shape, so
 * the local rule-based parser and a hosted model are interchangeable.
 */

import type { Vec3 } from '../core/types';

export type AiOperation =
  | { op: 'fill'; region?: RegionRef; block: string }
  | { op: 'replace'; region?: RegionRef; from: string; to: string }
  | { op: 'brush'; at?: PointRef; shape: 'sphere' | 'cube' | 'cylinder'; radius: number; block: string; hollow?: boolean }
  | { op: 'walls'; region?: RegionRef; block: string; thickness?: number }
  | { op: 'hollow'; region?: RegionRef; block: string }
  | { op: 'line'; from: PointRef; to: PointRef; block: string; thickness?: number }
  | { op: 'terrain'; region?: RegionRef; biome?: string; amplitude?: number; scale?: number; baseHeight?: number; seed?: number; water?: boolean; seaLevel?: number }
  | { op: 'mountain'; at?: PointRef; radius?: number; height?: number; biome?: string; seed?: number }
  | { op: 'hills'; region?: RegionRef; amplitude?: number; scale?: number; biome?: string; seed?: number }
  | { op: 'smooth'; region?: RegionRef; iterations?: number }
  | { op: 'forest'; region?: RegionRef; density?: number; biome?: string; seed?: number }
  | { op: 'tree'; at?: PointRef; biome?: string; seed?: number }
  | { op: 'river'; region?: RegionRef; width?: number; depth?: number; seed?: number }
  | { op: 'lake'; at?: PointRef; radius?: number; depth?: number }
  | { op: 'paintBiome'; region?: RegionRef; biome: string }
  | { op: 'castle'; at?: PointRef; size?: number; style?: string; moat?: boolean; seed?: number }
  | { op: 'house'; at?: PointRef; width?: number; depth?: number; height?: number; style?: string }
  | { op: 'tower'; at?: PointRef; radius?: number; height?: number; style?: string }
  | { op: 'village'; at?: PointRef; houses?: number; radius?: number; style?: string; seed?: number }
  | { op: 'bridge'; from: PointRef; to: PointRef; width?: number; style?: string }
  | { op: 'wall'; from: PointRef; to: PointRef; height?: number; thickness?: number; style?: string }
  | { op: 'pyramid'; at?: PointRef; size?: number; style?: string; hollow?: boolean }
  | { op: 'dome'; at?: PointRef; radius?: number; block: string; hollow?: boolean }
  | { op: 'clear'; region?: RegionRef }
  | { op: 'flatten'; region?: RegionRef; block?: string };

/** `"selection"` = the current selection, `"cursor"` = where the user is looking. */
export type RegionRef = 'selection' | 'world' | { min: Vec3; max: Vec3 } | { around: PointRef; radius: number };
export type PointRef = 'cursor' | 'selection-center' | 'camera' | Vec3;

export interface AiPlan {
  /** Human-readable summary shown before applying. */
  summary: string;
  operations: AiOperation[];
  /** How the plan was produced. */
  source: 'local' | 'remote';
  /** Parser confidence 0..1; low confidence prompts a clarification. */
  confidence: number;
  warnings?: string[];
}

export const OPERATION_NAMES = [
  'fill', 'replace', 'brush', 'walls', 'hollow', 'line', 'terrain', 'mountain', 'hills',
  'smooth', 'forest', 'tree', 'river', 'lake', 'paintBiome', 'castle', 'house', 'tower',
  'village', 'bridge', 'wall', 'pyramid', 'dome', 'clear', 'flatten',
] as const;

/** JSON-schema-ish description handed to a remote LLM as its system prompt. */
export const AI_SYSTEM_PROMPT = `You are the planning engine for WebWorld, a Minecraft world editor.
Convert the user's building request into a JSON plan. Respond with JSON only, no prose.

Schema:
{
  "summary": string,
  "operations": Operation[]
}

Operation is one of (field names are exact):
${OPERATION_NAMES.join(', ')}

Common fields:
- "region": "selection" | "world" | {"min":{"x","y","z"},"max":{"x","y","z"}} | {"around":PointRef,"radius":number}
- "at"/"from"/"to": "cursor" | "selection-center" | "camera" | {"x","y","z"}
- "block": a Minecraft block name without namespace, e.g. "stone", "mossy_cobblestone"
- "style": "medieval" | "rustic" | "desert" | "modern" | "dark"
- "biome": "plains" | "forest" | "taiga" | "desert" | "badlands" | "snowy" | "mountain" | "swamp" | "jungle" | "volcanic"

Prefer a few large, meaningful operations over many tiny ones. Never invent fields.`;
