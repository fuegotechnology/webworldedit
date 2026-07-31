/**
 * AI assistant.
 *
 * Pipeline: prompt → plan (local rules and/or remote LLM) → resolved operations
 * → *preview* rendered as translucent instanced blocks → user accepts → the
 * exact same operations are replayed against the world inside one undo
 * transaction.
 *
 * Crucially the preview and the commit run identical code with identical seeds,
 * so what you see is exactly what you get.
 */

import { EventBus } from '../core/events';
import { AIR, blockRegistry } from '../world/blocks';
import type { Editor } from '../edit/editor';
import type { World } from '../world/world';
import {
  PreviewSink,
  brush,
  fill,
  hollowBox,
  line,
  paintSurface,
  replace,
  smoothTerrain,
  walls,
  type BlockSink,
} from '../edit/operations';
import {
  generateForest,
  generateMountain,
  generateRiver,
  generateRollingHills,
  generateTerrain,
  plantTree,
} from '../world/generator';
import { biomeById, resolveLayers } from '../edit/biomes';
import {
  buildBridge,
  buildCastle,
  buildDome,
  buildHouse,
  buildPyramidStructure,
  buildTower,
  buildVillage,
  buildWallStructure,
  styleByName,
} from './structures';
import { parsePrompt } from './parser';
import {
  loadProviderConfig,
  requestRemotePlan,
  saveProviderConfig,
  type ProviderConfig,
} from './provider';
import type { AiOperation, AiPlan, PointRef, RegionRef } from './intents';
import {
  normalizeRegion,
  regionVolume,
  type Region,
  type Vec3,
  vec3,
} from '../core/types';
import { makeRandom } from '../edit/operations';

export interface AiProposal {
  prompt: string;
  plan: AiPlan;
  /** Blocks the plan would write — rendered as the preview. */
  blocks: Array<{ x: number; y: number; z: number; id: number }>;
  truncated: boolean;
  ms: number;
}

export interface AssistantEvents {
  thinking: { prompt: string };
  proposal: { proposal: AiProposal };
  applied: { prompt: string; blocks: number };
  rejected: void;
  error: { message: string };
}

const PREVIEW_LIMIT = 350_000;

export class AiAssistant {
  readonly events = new EventBus<AssistantEvents>();
  provider: ProviderConfig = loadProviderConfig();
  pending: AiProposal | null = null;
  history: string[] = [];

  private editor: Editor;
  private world: World;
  private abort: AbortController | null = null;

  constructor(editor: Editor) {
    this.editor = editor;
    this.world = editor.world;
  }

  setProvider(config: Partial<ProviderConfig>): void {
    this.provider = { ...this.provider, ...config };
    saveProviderConfig(this.provider);
  }

  // ----------------------------------------------------------------- resolve

  /** Resolves a symbolic point reference into world coordinates. */
  private resolvePoint(ref: PointRef | undefined): Vec3 {
    if (!ref || ref === 'cursor') {
      return this.editor.cameraTargetBlock();
    }
    if (ref === 'camera') {
      const p = this.editor.camera.camera.position;
      return vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    }
    if (ref === 'selection-center') {
      const r = this.editor.selection.primary;
      if (!r) return this.editor.cameraTargetBlock();
      return vec3(
        Math.floor((r.min.x + r.max.x) / 2),
        Math.floor((r.min.y + r.max.y) / 2),
        Math.floor((r.min.z + r.max.z) / 2),
      );
    }
    if (typeof ref === 'object' && 'x' in ref) return vec3(ref.x, ref.y, ref.z);
    return this.editor.cameraTargetBlock();
  }

  /** Resolves a symbolic region reference, clamped to world bounds. */
  private resolveRegion(ref: RegionRef | undefined, defaultRadius = 64): Region {
    const clampY = (r: Region): Region => ({
      min: vec3(r.min.x, Math.max(this.world.bounds.minY, r.min.y), r.min.z),
      max: vec3(r.max.x, Math.min(this.world.bounds.maxY, r.max.y), r.max.z),
    });

    if (ref === 'selection') {
      const sel = this.editor.selection.primary;
      if (sel) return clampY(sel);
      return this.resolveRegion({ around: 'cursor', radius: defaultRadius });
    }
    if (ref === 'world') {
      const bounds = this.world.computeBounds();
      if (bounds) return clampY(bounds);
      return this.resolveRegion({ around: 'cursor', radius: defaultRadius });
    }
    if (ref && typeof ref === 'object' && 'around' in ref) {
      const c = this.resolvePoint(ref.around);
      const r = Math.max(1, Math.min(512, ref.radius ?? defaultRadius));
      return clampY(
        normalizeRegion(
          vec3(c.x - r, this.world.bounds.minY, c.z - r),
          vec3(c.x + r, this.world.bounds.maxY, c.z + r),
        ),
      );
    }
    if (ref && typeof ref === 'object' && 'min' in ref) {
      return clampY(normalizeRegion(ref.min, ref.max));
    }
    // Default: a box around the selection if there is one, else around the cursor.
    const sel = this.editor.selection.primary;
    if (sel) return clampY(sel);
    return this.resolveRegion({ around: 'cursor', radius: defaultRadius });
  }

  private block(name: string | undefined, fallback = 'stone'): number {
    return blockRegistry.resolve(name ?? fallback)?.id ?? blockRegistry.resolve(fallback)!.id;
  }

  // ----------------------------------------------------------------- execute

  /** Runs a whole plan against a sink. Shared by preview and commit. */
  private execute(plan: AiPlan, sink: BlockSink): number {
    let n = 0;
    for (const operation of plan.operations) {
      try {
        n += this.executeOne(operation, sink);
      } catch (err) {
        console.error('[ai] operation failed', operation, err);
      }
    }
    return n;
  }

  private executeOne(operation: AiOperation, sink: BlockSink): number {
    const world = this.world;

    switch (operation.op) {
      case 'fill':
        return fill(sink, this.resolveRegion(operation.region, 24), this.block(operation.block));

      case 'clear':
        return fill(sink, this.resolveRegion(operation.region, 24), AIR);

      case 'replace':
        return replace(
          sink,
          this.resolveRegion(operation.region, 96),
          operation.from === 'any' || operation.from === 'any-solid'
            ? (operation.from as 'any' | 'any-solid')
            : this.block(operation.from),
          this.block(operation.to),
        );

      case 'walls':
        return walls(
          sink,
          this.resolveRegion(operation.region, 24),
          this.block(operation.block),
          operation.thickness ?? 1,
        );

      case 'hollow':
        return hollowBox(sink, this.resolveRegion(operation.region, 24), this.block(operation.block));

      case 'brush': {
        const at = this.resolvePoint(operation.at);
        return brush(sink, at, operation.shape ?? 'sphere', Math.min(160, operation.radius ?? 8), this.block(operation.block), {
          hollow: operation.hollow,
        });
      }

      case 'line':
        return line(
          sink,
          this.resolvePoint(operation.from),
          this.resolvePoint(operation.to),
          this.block(operation.block),
          operation.thickness ?? 0,
        );

      case 'terrain':
        return generateTerrain(sink, this.resolveRegion(operation.region, 96), {
          seed: operation.seed,
          baseHeight: operation.baseHeight ?? 64,
          amplitude: operation.amplitude ?? 16,
          scale: operation.scale ?? 70,
          biome: operation.biome ?? 'plains',
          water: operation.water,
          seaLevel: operation.seaLevel ?? 60,
        });

      case 'mountain':
        return generateMountain(sink, world, this.resolvePoint(operation.at), {
          radius: Math.min(240, operation.radius ?? 50),
          height: Math.min(220, operation.height ?? 64),
          biome: operation.biome ?? 'mountain',
          seed: operation.seed,
        });

      case 'hills':
        return generateRollingHills(sink, world, this.resolveRegion(operation.region, 80), {
          amplitude: operation.amplitude ?? 10,
          scale: operation.scale ?? 45,
          biome: operation.biome ?? 'plains',
          seed: operation.seed,
        });

      case 'smooth':
        return smoothTerrain(sink, world, this.resolveRegion(operation.region, 48), operation.iterations ?? 2);

      case 'flatten': {
        const region = this.resolveRegion(operation.region, 48);
        const target = Math.round(
          (world.surfaceAt(region.min.x, region.min.z) + world.surfaceAt(region.max.x, region.max.z)) / 2,
        );
        const mat = this.block(operation.block, 'grass_block');
        let n = 0;
        for (let z = region.min.z; z <= region.max.z; z++) {
          for (let x = region.min.x; x <= region.max.x; x++) {
            const surface = world.surfaceAt(x, z);
            for (let y = surface; y > target; y--) if (sink.set(x, y, z, AIR)) n++;
            for (let y = Math.min(surface, target); y <= target; y++) if (sink.set(x, y, z, mat)) n++;
            if (sink.set(x, target, z, mat)) n++;
          }
        }
        return n;
      }

      case 'forest':
        return generateForest(sink, world, this.resolveRegion(operation.region, 72), {
          density: Math.min(0.3, operation.density ?? 0.045),
          biome: operation.biome ?? 'forest',
          seed: operation.seed,
        });

      case 'tree': {
        const at = this.resolvePoint(operation.at);
        const def = biomeById(operation.biome ?? 'forest');
        const species = def.tree ?? biomeById('forest').tree!;
        const ground = world.surfaceAt(at.x, at.z);
        return plantTree(sink, vec3(at.x, Math.max(ground + 1, at.y), at.z), species, makeRandom(operation.seed ?? 1));
      }

      case 'river':
        return generateRiver(sink, world, this.resolveRegion(operation.region, 96), {
          width: operation.width ?? 6,
          depth: operation.depth ?? 4,
          seed: operation.seed,
        });

      case 'lake': {
        const at = this.resolvePoint(operation.at);
        const radius = Math.min(200, operation.radius ?? 16);
        const depth = Math.min(48, operation.depth ?? 5);
        const waterId = this.block('water');
        const sandId = this.block('sand');
        let n = 0;
        for (let dz = -radius; dz <= radius; dz++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const d = Math.sqrt(dx * dx + dz * dz) / radius;
            if (d > 1) continue;
            const x = at.x + dx;
            const z = at.z + dz;
            const surface = world.surfaceAt(x, z);
            if (surface < world.bounds.minY) continue;
            const carve = Math.max(1, Math.round(depth * Math.cos(d * Math.PI * 0.5)));
            const bed = surface - carve;
            for (let y = surface; y > bed; y--) if (sink.set(x, y, z, AIR)) n++;
            for (let y = bed + 1; y <= surface - 1; y++) if (sink.set(x, y, z, waterId)) n++;
            if (sink.set(x, bed, z, d > 0.82 ? sandId : this.block('gravel'))) n++;
          }
        }
        return n;
      }

      case 'paintBiome':
        return paintSurface(
          sink,
          world,
          this.resolveRegion(operation.region, 64),
          resolveLayers(biomeById(operation.biome)),
        );

      case 'castle':
        return buildCastle(sink, world, this.resolvePoint(operation.at), {
          size: Math.min(160, operation.size ?? 40),
          style: styleByName(operation.style),
          moat: operation.moat ?? true,
          seed: operation.seed,
        });

      case 'house': {
        const at = this.resolvePoint(operation.at);
        const ground = world.surfaceAt(at.x, at.z);
        return buildHouse(sink, vec3(at.x, Math.max(ground + 1, world.bounds.minY), at.z), {
          width: Math.min(64, operation.width ?? 9),
          depth: Math.min(64, operation.depth ?? 7),
          height: Math.min(32, operation.height ?? 5),
          style: styleByName(operation.style),
        });
      }

      case 'tower': {
        const at = this.resolvePoint(operation.at);
        const ground = world.surfaceAt(at.x, at.z);
        return buildTower(sink, vec3(at.x, Math.max(ground + 1, world.bounds.minY), at.z), {
          radius: Math.min(32, operation.radius ?? 4),
          height: Math.min(200, operation.height ?? 20),
          style: styleByName(operation.style),
        });
      }

      case 'village':
        return buildVillage(sink, world, this.resolvePoint(operation.at), {
          houses: Math.min(60, operation.houses ?? 8),
          radius: Math.min(300, operation.radius ?? 40),
          style: styleByName(operation.style),
          seed: operation.seed,
        });

      case 'bridge': {
        const from = this.resolvePoint(operation.from);
        let to = this.resolvePoint(operation.to);
        // If both refs collapsed to the same point, span forward from the camera.
        if (to.x === from.x && to.z === from.z) to = vec3(from.x + 48, from.y, from.z);
        return buildBridge(sink, from, to, {
          width: Math.min(32, operation.width ?? 5),
          style: styleByName(operation.style),
        });
      }

      case 'wall': {
        const from = this.resolvePoint(operation.from);
        let to = this.resolvePoint(operation.to);
        if (to.x === from.x && to.z === from.z) to = vec3(from.x + 80, from.y, from.z);
        return buildWallStructure(sink, world, from, to, {
          height: Math.min(64, operation.height ?? 8),
          thickness: Math.min(16, operation.thickness ?? 3),
          style: styleByName(operation.style),
        });
      }

      case 'pyramid':
        return buildPyramidStructure(sink, world, this.resolvePoint(operation.at), {
          size: Math.min(120, operation.size ?? 24),
          style: styleByName(operation.style),
          hollow: operation.hollow,
        });

      case 'dome': {
        const at = this.resolvePoint(operation.at);
        return buildDome(sink, at, Math.min(120, operation.radius ?? 12), operation.block ?? 'glass', operation.hollow ?? true);
      }

      default:
        return 0;
    }
  }

  // ----------------------------------------------------------------- public

  /** Compiles a prompt and stages a preview. Does not modify the world. */
  async propose(prompt: string): Promise<AiProposal | null> {
    const trimmed = prompt.trim();
    if (!trimmed) return null;

    this.events.emit('thinking', { prompt: trimmed });
    const start = performance.now();
    // One seed per proposal keeps preview and commit byte-identical.
    const seed = Math.floor(Math.random() * 1e9);
    let plan = parsePrompt(trimmed, { seed });

    if (this.provider.enabled) {
      this.abort?.abort();
      this.abort = new AbortController();
      try {
        const remote = await requestRemotePlan(trimmed, this.provider, this.abort.signal);
        if (remote && remote.operations.length > 0) plan = remote;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.events.emit('error', { message: `Remote AI unavailable (${message}) — used the local planner.` });
      }
    }

    if (plan.operations.length === 0) {
      this.events.emit('error', {
        message: plan.warnings?.join(' ') ?? 'Could not turn that into editor operations.',
      });
      return null;
    }

    // Guard against absurd plans before we spend time previewing them.
    const estimated = plan.operations.reduce((sum, op) => {
      const anyOp = op as { region?: RegionRef };
      if (!anyOp.region) return sum + 50_000;
      return sum + Math.min(5_000_000, regionVolume(this.resolveRegion(anyOp.region)));
    }, 0);
    if (estimated > 80_000_000) {
      this.events.emit('error', { message: 'That plan is too large to preview safely. Try a smaller area or selection.' });
      return null;
    }

    const preview = new PreviewSink(this.world, PREVIEW_LIMIT);
    this.execute(plan, preview);

    const proposal: AiProposal = {
      prompt: trimmed,
      plan,
      blocks: preview.blocks,
      truncated: preview.blocks.length >= PREVIEW_LIMIT,
      ms: performance.now() - start,
    };

    this.pending = proposal;
    this.editor.showPreview(proposal.blocks);
    this.events.emit('proposal', { proposal });
    return proposal;
  }

  /** Commits the staged proposal as one undoable transaction. */
  apply(): number {
    const proposal = this.pending;
    if (!proposal) return 0;

    // The preview already holds every resolved write, so replaying it is both
    // faster than re-running generators and guaranteed to match the preview.
    const blocks = proposal.blocks;
    const written = this.editor.run(`AI: ${proposal.plan.summary}`, (sink) => {
      let n = 0;
      for (const b of blocks) if (sink.set(b.x, b.y, b.z, b.id)) n++;
      return n;
    });

    this.history.unshift(proposal.prompt);
    this.history = this.history.slice(0, 30);
    this.pending = null;
    this.editor.clearPreview();
    this.events.emit('applied', { prompt: proposal.prompt, blocks: written });
    return written;
  }

  reject(): void {
    this.pending = null;
    this.editor.clearPreview();
    this.events.emit('rejected', undefined);
  }
}
