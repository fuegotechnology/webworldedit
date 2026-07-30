/**
 * Editor: the application's command surface.
 *
 * Every user-facing action lives here as a method. Tools, keyboard shortcuts,
 * the UI panels and the AI assistant all call the *same* methods, which means
 * anything the AI can do a human can do, and vice-versa — and everything is
 * undoable by construction.
 */

import * as THREE from 'three';
import { EventBus } from '../core/events';
import {
  normalizeRegion,
  regionSize,
  regionVolume,
  type Axis,
  type BlockId,
  type BrushShape,
  type Region,
  type Vec3,
  vec3,
} from '../core/types';
import { AIR, blockRegistry } from '../world/blocks';
import type { World } from '../world/world';
import type { Overlay } from '../render/overlay';
import type { CameraController } from '../render/camera-controller';
import { EditHistory } from './history';
import { Selection } from './selection';
import { biomeById, resolveLayers } from './biomes';
import * as ops from './operations';
import { PreviewSink, WorldSink, type Clipboard, type PendingBlock } from './operations';
import { toolById, type Tool, type ToolId } from './tools';

export type ShapeKind = 'sphere' | 'cylinder' | 'pyramid' | 'box';

export interface EditorSettings {
  activeBlock: BlockId;
  secondaryBlock: BlockId;
  replaceFrom: BlockId;
  brushRadius: number;
  brushShape: BrushShape;
  brushHollow: boolean;
  sculptStrength: number;
  shapeKind: ShapeKind;
  shapeSize: number;
  shapeHollow: boolean;
  biome: string;
  gridSnap: number;
  showGrid: boolean;
  maskAirOnly: boolean;
  /** Hotbar of quick-access block ids. */
  hotbar: BlockId[];
  hotbarIndex: number;
}

export interface EditorEvents {
  'settings:changed': EditorSettings;
  'tool:changed': { tool: Tool };
  notify: { message: string; kind: 'info' | 'warn' | 'error' | 'success' };
  'operation:done': { label: string; blocks: number; ms: number };
  'clipboard:changed': { clipboard: Clipboard | null };
}

const MAX_OP_VOLUME = 40_000_000;

export class Editor {
  readonly events = new EventBus<EditorEvents>();
  readonly world: World;
  readonly overlay: Overlay;
  readonly camera: CameraController;
  readonly history: EditHistory;
  readonly selection = new Selection();
  readonly sink: WorldSink;

  settings: EditorSettings = {
    activeBlock: blockRegistry.resolve('stone')!.id,
    secondaryBlock: blockRegistry.resolve('dirt')!.id,
    replaceFrom: blockRegistry.resolve('stone')!.id,
    brushRadius: 4,
    brushShape: 'sphere',
    brushHollow: false,
    sculptStrength: 3,
    shapeKind: 'sphere',
    shapeSize: 8,
    shapeHollow: false,
    biome: 'plains',
    gridSnap: 1,
    showGrid: true,
    maskAirOnly: false,
    hotbar: [
      blockRegistry.resolve('stone')!.id,
      blockRegistry.resolve('grass_block')!.id,
      blockRegistry.resolve('dirt')!.id,
      blockRegistry.resolve('oak_planks')!.id,
      blockRegistry.resolve('oak_log')!.id,
      blockRegistry.resolve('stone_bricks')!.id,
      blockRegistry.resolve('glass')!.id,
      blockRegistry.resolve('water')!.id,
      blockRegistry.resolve('sand')!.id,
    ],
    hotbarIndex: 0,
  };

  clipboard: Clipboard | null = null;
  lineStart: Vec3 | null = null;
  activeTool: Tool = toolById('select');

  constructor(world: World, overlay: Overlay, camera: CameraController) {
    this.world = world;
    this.overlay = overlay;
    this.camera = camera;
    this.history = new EditHistory(world);
    this.sink = new WorldSink(world);
    this.selection.events.on('changed', ({ primary, regions }) => {
      this.overlay.showSelection(primary, regions.slice(1));
    });
  }

  // ------------------------------------------------------------- settings

  update(patch: Partial<EditorSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.overlay.setGridVisible(this.settings.showGrid);
    this.events.emit('settings:changed', this.settings);
  }

  setTool(id: ToolId): void {
    if (this.activeTool.id === id) return;
    this.activeTool.onExit?.(this);
    this.activeTool = toolById(id);
    this.events.emit('tool:changed', { tool: this.activeTool });
    this.notify(this.activeTool.description, 'info');
  }

  notify(message: string, kind: 'info' | 'warn' | 'error' | 'success' = 'info'): void {
    this.events.emit('notify', { message, kind });
  }

  setActiveBlock(id: BlockId): void {
    this.update({ activeBlock: id });
  }

  selectHotbar(index: number): void {
    const clamped = Math.max(0, Math.min(this.settings.hotbar.length - 1, index));
    this.update({ hotbarIndex: clamped, activeBlock: this.settings.hotbar[clamped] });
  }

  assignHotbar(index: number, id: BlockId): void {
    const hotbar = [...this.settings.hotbar];
    hotbar[index] = id;
    this.update({ hotbar });
  }

  /** Snaps a point to the grid setting. */
  snap(p: Vec3): Vec3 {
    const g = Math.max(1, this.settings.gridSnap);
    if (g === 1) return p;
    return vec3(Math.round(p.x / g) * g, Math.round(p.y / g) * g, Math.round(p.z / g) * g);
  }

  // ------------------------------------------------------------- run helper

  /** Wraps an operation in a transaction, timing and reporting it. */
  run(label: string, fn: (sink: WorldSink) => number): number {
    const start = performance.now();
    const blocks = this.history.transaction(label, () => fn(this.sink));
    const ms = performance.now() - start;
    if (blocks > 0) {
      this.events.emit('operation:done', { label, blocks, ms });
      this.notify(`${label}: ${blocks.toLocaleString()} blocks in ${ms.toFixed(0)}ms`, 'success');
    } else {
      this.notify(`${label}: no blocks changed`, 'warn');
    }
    return blocks;
  }

  private guardVolume(volume: number, label: string): boolean {
    if (volume > MAX_OP_VOLUME) {
      this.notify(`${label} aborted — ${volume.toLocaleString()} blocks exceeds the safety limit`, 'error');
      return false;
    }
    return true;
  }

  private requireSelection(label: string): Region | null {
    const region = this.selection.primary;
    if (!region) {
      this.notify(`${label} needs a selection — use the Select tool (1)`, 'warn');
      return null;
    }
    return region;
  }

  // ------------------------------------------------------------- basic edits

  placeBlock(p: Vec3): void {
    this.run('Place block', (sink) => (sink.set(p.x, p.y, p.z, this.settings.activeBlock) ? 1 : 0));
  }

  breakBlock(p: Vec3): void {
    this.run('Break block', (sink) => (sink.set(p.x, p.y, p.z, AIR) ? 1 : 0));
  }

  pickBlock(p: Vec3): void {
    const id = this.world.getBlockV(p);
    if (id === AIR) {
      this.notify('Nothing to pick here', 'warn');
      return;
    }
    this.update({ activeBlock: id });
    this.notify(`Picked ${blockRegistry.get(id).name}`, 'success');
  }

  applyBrush(centre: Vec3, erase = false): void {
    const s = this.settings;
    this.run(erase ? 'Erase brush' : 'Brush', (sink) =>
      ops.brush(sink, centre, s.brushShape, s.brushRadius, erase ? AIR : s.activeBlock, {
        hollow: s.brushHollow,
        replaceOnly: !erase && s.maskAirOnly ? AIR : undefined,
      }),
    );
  }

  fillSelection(id: BlockId = this.settings.activeBlock): void {
    const regions = this.selection.regions;
    if (regions.length === 0) {
      this.notify('Fill needs a selection', 'warn');
      return;
    }
    const volume = regions.reduce((s, r) => s + regionVolume(r), 0);
    if (!this.guardVolume(volume, 'Fill')) return;
    this.run(id === AIR ? 'Clear selection' : 'Fill selection', (sink) =>
      regions.reduce((n, r) => n + ops.fill(sink, r, id), 0),
    );
  }

  wallsInSelection(): void {
    const region = this.requireSelection('Walls');
    if (!region) return;
    this.run('Walls', (sink) => ops.walls(sink, region, this.settings.activeBlock));
  }

  hollowSelection(): void {
    const region = this.requireSelection('Hollow');
    if (!region) return;
    this.run('Hollow shell', (sink) => ops.hollowBox(sink, region, this.settings.activeBlock));
  }

  replaceInSelection(from?: BlockId | 'any-solid', to?: BlockId): void {
    const regions = this.selection.regions;
    if (regions.length === 0) {
      this.notify('Replace needs a selection', 'warn');
      return;
    }
    const source = from ?? this.settings.replaceFrom;
    const target = to ?? this.settings.activeBlock;
    this.run('Replace', (sink) => regions.reduce((n, r) => n + ops.replace(sink, r, source, target), 0));
  }

  floodFillAt(p: Vec3): void {
    this.run('Flood fill', (sink) => ops.floodFill(sink, this.world, p, this.settings.activeBlock));
  }

  drawLine(from: Vec3, to: Vec3): void {
    this.run('Line', (sink) => ops.line(sink, from, to, this.settings.activeBlock, 0));
  }

  previewLine(from: Vec3, to: Vec3): void {
    const preview = new PreviewSink(this.world, 20000);
    ops.line(preview, from, to, this.settings.activeBlock, 0);
    this.overlay.showPreview(preview.blocks);
  }

  generateShape(centre: Vec3, erase = false): void {
    const s = this.settings;
    const id = erase ? AIR : s.activeBlock;
    this.run(`Shape (${s.shapeKind})`, (sink) => {
      switch (s.shapeKind) {
        case 'sphere':
          return ops.brush(sink, centre, 'sphere', s.shapeSize, id, { hollow: s.shapeHollow });
        case 'cylinder':
          return ops.brush(sink, centre, 'cylinder', s.shapeSize, id, {
            hollow: s.shapeHollow,
            height: s.shapeSize,
          });
        case 'pyramid':
          return ops.pyramid(sink, centre, s.shapeSize, id, s.shapeHollow);
        case 'box': {
          const r = s.shapeSize;
          const region = normalizeRegion(
            vec3(centre.x - r, centre.y, centre.z - r),
            vec3(centre.x + r, centre.y + r * 2, centre.z + r),
          );
          return s.shapeHollow ? ops.hollowBox(sink, region, id) : ops.fill(sink, region, id);
        }
      }
    });
  }

  sculptAt(p: Vec3, direction: 1 | -1): void {
    const s = this.settings;
    this.run(direction > 0 ? 'Raise terrain' : 'Lower terrain', (sink) =>
      ops.sculpt(
        sink,
        this.world,
        p,
        s.brushRadius,
        s.sculptStrength * direction,
        s.activeBlock,
      ),
    );
  }

  smoothAround(p: Vec3): void {
    const r = this.settings.brushRadius;
    const region: Region = {
      min: vec3(p.x - r, this.world.bounds.minY, p.z - r),
      max: vec3(p.x + r, this.world.bounds.maxY, p.z + r),
    };
    this.run('Smooth terrain', (sink) => ops.smoothTerrain(sink, this.world, region, 2));
  }

  smoothSelection(iterations = 3): void {
    const region = this.requireSelection('Smooth');
    if (!region) return;
    this.run('Smooth selection', (sink) => ops.smoothTerrain(sink, this.world, region, iterations));
  }

  paintBiomeAt(p: Vec3): void {
    const r = this.settings.brushRadius;
    const biome = biomeById(this.settings.biome);
    const layers = resolveLayers(biome);
    const region: Region = {
      min: vec3(p.x - r, this.world.bounds.minY, p.z - r),
      max: vec3(p.x + r, this.world.bounds.maxY, p.z + r),
    };
    this.run(`Paint ${biome.name}`, (sink) => {
      let n = 0;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dz * dz > r * r) continue;
          const col: Region = {
            min: vec3(p.x + dx, region.min.y, p.z + dz),
            max: vec3(p.x + dx, region.max.y, p.z + dz),
          };
          n += ops.paintSurface(sink, this.world, col, layers);
        }
      }
      return n;
    });
  }

  paintBiomeSelection(): void {
    const region = this.requireSelection('Paint biome');
    if (!region) return;
    const biome = biomeById(this.settings.biome);
    this.run(`Paint ${biome.name}`, (sink) =>
      ops.paintSurface(sink, this.world, region, resolveLayers(biome)),
    );
  }

  // ------------------------------------------------------------- clipboard

  copySelection(): void {
    const region = this.requireSelection('Copy');
    if (!region) return;
    this.clipboard = ops.copyRegion(this.world, region, this.cameraAnchor(region));
    const s = regionSize(region);
    this.events.emit('clipboard:changed', { clipboard: this.clipboard });
    this.notify(`Copied ${s.x}×${s.y}×${s.z} region`, 'success');
  }

  cutSelection(): void {
    const region = this.requireSelection('Cut');
    if (!region) return;
    this.clipboard = ops.copyRegion(this.world, region, this.cameraAnchor(region));
    this.events.emit('clipboard:changed', { clipboard: this.clipboard });
    this.run('Cut selection', (sink) => ops.fill(sink, region, AIR));
  }

  private cameraAnchor(region: Region): Vec3 {
    return region.min;
  }

  pasteAt(p: Vec3): void {
    if (!this.clipboard) {
      this.notify('Clipboard is empty — copy a selection first (Ctrl+C)', 'warn');
      return;
    }
    const clip = this.clipboard;
    this.run('Paste', (sink) => ops.pasteClipboard(sink, clip, p, { skipAir: true }));
    this.overlay.clearPreview();
  }

  pasteAtSelection(): void {
    const region = this.selection.primary;
    const at = region ? region.min : this.cameraTargetBlock();
    this.pasteAt(at);
  }

  previewPaste(p: Vec3): void {
    if (!this.clipboard) return;
    const preview = new PreviewSink(this.world, 60000);
    ops.pasteClipboard(preview, this.clipboard, p, { skipAir: true });
    this.overlay.showPreview(preview.blocks);
  }

  rotateClipboard(steps: number): void {
    if (!this.clipboard) {
      this.notify('Nothing in the clipboard to rotate', 'warn');
      return;
    }
    this.clipboard = ops.rotateClipboard(this.clipboard, steps);
    this.events.emit('clipboard:changed', { clipboard: this.clipboard });
    this.notify(`Clipboard rotated ${steps * 90}°`, 'success');
  }

  mirrorClipboard(axis: Axis): void {
    if (!this.clipboard) {
      this.notify('Nothing in the clipboard to mirror', 'warn');
      return;
    }
    this.clipboard = ops.mirrorClipboard(this.clipboard, axis);
    this.events.emit('clipboard:changed', { clipboard: this.clipboard });
    this.notify(`Clipboard mirrored on ${axis.toUpperCase()}`, 'success');
  }

  rotateSelection(steps: number): void {
    const region = this.requireSelection('Rotate');
    if (!region) return;
    this.run('Rotate selection', (sink) => ops.rotateRegion(this.world, sink, region, steps));
  }

  mirrorSelection(axis: Axis): void {
    const region = this.requireSelection('Mirror');
    if (!region) return;
    this.run('Mirror selection', (sink) => ops.mirrorRegion(this.world, sink, region, axis));
  }

  stackSelection(direction: Vec3, count: number): void {
    const region = this.requireSelection('Stack');
    if (!region) return;
    this.run('Stack selection', (sink) =>
      ops.stackRegion(this.world, sink, region, direction, count),
    );
  }

  moveSelection(direction: Vec3, distance: number): void {
    const region = this.requireSelection('Move');
    if (!region) return;
    const clip = ops.copyRegion(this.world, region);
    const dest = vec3(
      region.min.x + direction.x * distance,
      region.min.y + direction.y * distance,
      region.min.z + direction.z * distance,
    );
    this.run('Move selection', (sink) => {
      let n = ops.fill(sink, region, AIR);
      n += ops.pasteClipboard(sink, { ...clip, origin: vec3(0, 0, 0) }, dest, { skipAir: true });
      return n;
    });
    this.selection.shift(vec3(direction.x * distance, direction.y * distance, direction.z * distance));
  }

  // ------------------------------------------------------------- selection helpers

  focusSelection(): void {
    const region = this.selection.primary;
    if (!region) {
      const bounds = this.world.computeBounds();
      if (bounds) this.camera.focusRegion(bounds);
      else this.notify('Nothing to focus on', 'warn');
      return;
    }
    this.camera.focusRegion(region);
  }

  selectAll(): void {
    const bounds = this.world.computeBounds();
    if (!bounds) {
      this.notify('World is empty', 'warn');
      return;
    }
    this.selection.setRegion(bounds);
    this.notify(`Selected ${regionVolume(bounds).toLocaleString()} blocks`, 'success');
  }

  expandSelection(amount: number): void {
    this.selection.expand(amount);
  }

  analyzeSelection(): string[] {
    const region = this.selection.primary;
    if (!region) return [];
    if (regionVolume(region) > 4_000_000) return ['Selection too large to analyze'];
    return ops.describeCounts(ops.countBlocks(this.world, region));
  }

  /** The block the camera is looking at, used as a default anchor. */
  cameraTargetBlock(distance = 20): Vec3 {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.camera.quaternion);
    const hit = this.world.raycast(
      vec3(this.camera.camera.position.x, this.camera.camera.position.y, this.camera.camera.position.z),
      vec3(dir.x, dir.y, dir.z),
      160,
    );
    if (hit) return hit.adjacent;
    const p = this.camera.camera.position.clone().addScaledVector(dir, distance);
    return vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  }

  // ------------------------------------------------------------- previews

  showPreview(blocks: PendingBlock[]): void {
    this.overlay.showPreview(blocks);
  }

  clearPreview(): void {
    this.overlay.clearPreview();
  }

  undo(): void {
    const entry = this.history.undo();
    this.notify(entry ? `Undid: ${entry.label}` : 'Nothing to undo', entry ? 'info' : 'warn');
  }

  redo(): void {
    const entry = this.history.redo();
    this.notify(entry ? `Redid: ${entry.label}` : 'Nothing to redo', entry ? 'info' : 'warn');
  }
}
