/**
 * Project serialization.
 *
 * A WebWorld project is a single JSON document: world metadata, camera state,
 * editor settings, and every non-empty chunk stored as a palette + run-length
 * encoded index stream. This is compact (typically 50–200× smaller than raw
 * voxels), diff-friendly, and completely independent of the block registry's
 * numeric ids — chunks reference Minecraft block names, so projects survive
 * registry changes and version upgrades.
 */

import { Chunk } from '../world/chunk';
import type { World } from '../world/world';
import type { Editor, EditorSettings } from '../edit/editor';
import type { CameraController } from '../render/camera-controller';
import type { Region } from '../core/types';

export const PROJECT_VERSION = 1;

export interface SerializedChunk {
  key: string;
  palette: string[];
  rle: number[];
}

export interface ProjectFile {
  format: 'webworld-project';
  version: number;
  name: string;
  created: string;
  modified: string;
  /** Minecraft version the texture atlas was built from, if any. */
  minecraftVersion?: string;
  bounds: { radius: number; minY: number; maxY: number };
  camera: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    mode: string;
    moveSpeed: number;
  };
  settingsSnapshot: Partial<EditorSettings> & { activeBlockName?: string };
  selection?: { min: [number, number, number]; max: [number, number, number] } | null;
  stats: { chunks: number; blocks: number };
  chunks: SerializedChunk[];
}

export function serializeProject(
  world: World,
  editor: Editor,
  camera: CameraController,
  options: { name?: string; minecraftVersion?: string } = {},
): ProjectFile {
  const chunks: SerializedChunk[] = [];
  for (const chunk of world.chunks.values()) {
    if (chunk.isEmpty) continue;
    const payload = chunk.serialize(world.registry);
    if (payload) chunks.push(payload);
  }

  const now = new Date().toISOString();
  const selection: Region | null = editor.selection.primary;

  return {
    format: 'webworld-project',
    version: PROJECT_VERSION,
    name: options.name ?? 'Untitled World',
    created: now,
    modified: now,
    minecraftVersion: options.minecraftVersion,
    bounds: { ...world.bounds },
    camera: {
      position: camera.camera.position.toArray() as [number, number, number],
      quaternion: camera.camera.quaternion.toArray() as [number, number, number, number],
      mode: camera.mode,
      moveSpeed: camera.moveSpeed,
    },
    settingsSnapshot: {
      brushRadius: editor.settings.brushRadius,
      brushShape: editor.settings.brushShape,
      shapeKind: editor.settings.shapeKind,
      shapeSize: editor.settings.shapeSize,
      biome: editor.settings.biome,
      gridSnap: editor.settings.gridSnap,
      showGrid: editor.settings.showGrid,
      activeBlockName: world.registry.get(editor.settings.activeBlock).mc,
    },
    selection: selection
      ? {
          min: [selection.min.x, selection.min.y, selection.min.z],
          max: [selection.max.x, selection.max.y, selection.max.z],
        }
      : null,
    stats: { chunks: chunks.length, blocks: world.blockCount },
    chunks,
  };
}

export interface LoadResult {
  name: string;
  chunks: number;
  blocks: number;
  warnings: string[];
}

export function deserializeProject(
  json: unknown,
  world: World,
  editor: Editor,
  camera: CameraController,
): LoadResult {
  const project = json as ProjectFile;
  const warnings: string[] = [];

  if (!project || project.format !== 'webworld-project') {
    throw new Error('Not a WebWorld project file');
  }
  if (project.version > PROJECT_VERSION) {
    warnings.push(`Project was saved by a newer version (v${project.version}); loading best-effort.`);
  }

  world.clear();
  editor.history.clear();

  if (project.bounds) world.bounds = { ...world.bounds, ...project.bounds };

  for (const payload of project.chunks ?? []) {
    try {
      const chunk = Chunk.deserialize(payload, world.registry);
      if (!chunk.isEmpty) world.chunks.set(chunk.key, chunk);
    } catch (err) {
      warnings.push(`Skipped corrupt chunk ${payload.key}`);
      void err;
    }
  }

  // Camera.
  if (project.camera) {
    camera.camera.position.fromArray(project.camera.position);
    camera.camera.quaternion.fromArray(project.camera.quaternion);
    camera.moveSpeed = project.camera.moveSpeed ?? camera.moveSpeed;
    camera.setMode(project.camera.mode === 'orbit' ? 'orbit' : 'fly');
  }

  // Settings.
  const snapshot = project.settingsSnapshot ?? {};
  const activeBlock = snapshot.activeBlockName
    ? world.registry.byMinecraftName(snapshot.activeBlockName)?.id
    : undefined;
  editor.update({
    ...snapshot,
    ...(activeBlock !== undefined ? { activeBlock } : {}),
  } as Partial<EditorSettings>);

  // Selection.
  if (project.selection) {
    editor.selection.set(
      { x: project.selection.min[0], y: project.selection.min[1], z: project.selection.min[2] },
      { x: project.selection.max[0], y: project.selection.max[1], z: project.selection.max[2] },
    );
  } else {
    editor.selection.clear();
  }

  // Force a full remesh of everything we just loaded.
  for (const [key, chunk] of world.chunks) world.events.emit('chunk:dirty', { key, chunk });

  return {
    name: project.name ?? 'Untitled',
    chunks: world.chunkCount,
    blocks: world.blockCount,
    warnings,
  };
}

// ---------------------------------------------------------------- file utils

export function downloadBlob(data: BlobPart, filename: string, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(value: unknown, filename: string): void {
  downloadBlob(JSON.stringify(value), filename, 'application/json');
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // Resolve null if the dialog is dismissed (best-effort; no cancel event).
    window.addEventListener('focus', () => setTimeout(() => resolve(input.files?.[0] ?? null), 400), { once: true });
    input.click();
  });
}

const AUTOSAVE_KEY = 'webworld.autosave';

export function autosave(project: ProjectFile): boolean {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(project));
    return true;
  } catch {
    // Quota exceeded on large worlds — expected, not fatal.
    return false;
  }
}

export function loadAutosave(): ProjectFile | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? (JSON.parse(raw) as ProjectFile) : null;
  } catch {
    return null;
  }
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    /* ignore */
  }
}
