/**
 * Tool definitions.
 *
 * A tool is a small state machine reacting to pointer events from the input
 * system. Tools never mutate the world directly — they call into `operations`
 * inside an `Editor` transaction, which keeps undo, previews and the AI
 * assistant all working through one code path.
 */

import type { BrushShape, RaycastHit, Vec3 } from '../core/types';
import type { Editor } from './editor';

export type ToolId =
  | 'select'
  | 'place'
  | 'brush'
  | 'fill'
  | 'replace'
  | 'sculpt'
  | 'paint'
  | 'eyedropper'
  | 'line'
  | 'shape'
  | 'flood'
  | 'clipboard';

export interface ToolContext {
  editor: Editor;
  hit: RaycastHit | null;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export interface Tool {
  id: ToolId;
  name: string;
  icon: string;
  shortcut?: string;
  description: string;
  /** Pointer pressed on the viewport. */
  onPointerDown?(ctx: ToolContext): void;
  /** Pointer dragged while held (used by brush/sculpt painting). */
  onPointerDrag?(ctx: ToolContext): void;
  onPointerUp?(ctx: ToolContext): void;
  /** Hover — used to render footprints and previews. */
  onHover?(ctx: ToolContext): void;
  /** Called when the tool is deselected. */
  onExit?(editor: Editor): void;
}

const targetOf = (hit: RaycastHit | null, place: boolean): Vec3 | null =>
  hit ? (place ? hit.adjacent : hit.block) : null;

export const selectTool: Tool = {
  id: 'select',
  name: 'Select',
  icon: '⬚',
  shortcut: '1',
  description: 'Left click sets position 1, right click sets position 2. Shift+click adds a region.',
  onPointerDown({ editor, hit, button, shift }) {
    if (!hit) return;
    const p = hit.block;
    if (button === 0) editor.selection.setPos1(p);
    else if (button === 2) editor.selection.setPos2(p);
    if (shift) editor.selection.pushRegion();
  },
  onHover({ editor, hit }) {
    editor.overlay.showCursor(hit?.block ?? null, hit?.normal);
  },
};

export const placeTool: Tool = {
  id: 'place',
  name: 'Place / Break',
  icon: '⛏',
  shortcut: '2',
  description: 'Left click breaks a block, right click places the active block.',
  onPointerDown({ editor, hit, button }) {
    if (!hit) return;
    if (button === 0) editor.breakBlock(hit.block);
    else if (button === 2) editor.placeBlock(hit.adjacent);
  },
  onPointerDrag(ctx) {
    this.onPointerDown?.(ctx);
  },
  onHover({ editor, hit, button }) {
    editor.overlay.showCursor(targetOf(hit, button === 2), hit?.normal);
  },
};

export const brushTool: Tool = {
  id: 'brush',
  name: 'Brush',
  icon: '◍',
  shortcut: '3',
  description: 'Paints a sphere/cube/cylinder of the active block. Left click paints, right click erases.',
  onPointerDown({ editor, hit, button }) {
    if (!hit) return;
    const centre = button === 2 ? hit.block : hit.adjacent;
    editor.applyBrush(centre, button === 2);
  },
  onPointerDrag(ctx) {
    this.onPointerDown?.(ctx);
  },
  onHover({ editor, hit }) {
    editor.overlay.showCursor(hit?.block ?? null, hit?.normal);
    editor.overlay.showBrush(
      hit?.adjacent ?? null,
      editor.settings.brushRadius,
      editor.settings.brushShape as BrushShape,
    );
  },
  onExit(editor) {
    editor.overlay.showBrush(null, 0, 'sphere');
  },
};

export const fillTool: Tool = {
  id: 'fill',
  name: 'Fill',
  icon: '▣',
  shortcut: '4',
  description: 'Fills the current selection with the active block (Enter). Right click fills with air.',
  onPointerDown({ editor, button }) {
    if (button === 0) editor.fillSelection(editor.settings.activeBlock);
    else if (button === 2) editor.fillSelection(0);
  },
  onHover({ editor, hit }) {
    editor.overlay.showCursor(hit?.block ?? null, hit?.normal);
  },
};

export const replaceTool: Tool = {
  id: 'replace',
  name: 'Replace',
  icon: '⇄',
  shortcut: '5',
  description: 'Replaces every "from" block in the selection with the active block.',
  onPointerDown({ editor, hit, button }) {
    if (button === 2 && hit) {
      // Right click picks the "from" block.
      editor.settings.replaceFrom = editor.world.getBlockV(hit.block);
      editor.notify(`Replace source: ${editor.world.registry.get(editor.settings.replaceFrom).name}`);
      return;
    }
    editor.replaceInSelection();
  },
  onHover({ editor, hit }) {
    editor.overlay.showCursor(hit?.block ?? null, hit?.normal);
  },
};

export const sculptTool: Tool = {
  id: 'sculpt',
  name: 'Sculpt',
  icon: '⛰',
  shortcut: '6',
  description: 'Raises terrain on left click, lowers it on right click. Ctrl smooths.',
  onPointerDown({ editor, hit, button, ctrl }) {
    if (!hit) return;
    if (ctrl) editor.smoothAround(hit.block);
    else editor.sculptAt(hit.block, button === 2 ? -1 : 1);
  },
  onPointerDrag(ctx) {
    this.onPointerDown?.(ctx);
  },
  onHover({ editor, hit }) {
    editor.overlay.showCursor(hit?.block ?? null, hit?.normal);
    editor.overlay.showBrush(hit?.block ?? null, editor.settings.brushRadius, 'cylinder');
  },
  onExit(editor) {
    editor.overlay.showBrush(null, 0, 'sphere');
  },
};

export const paintTool: Tool = {
  id: 'paint',
  name: 'Paint Biome',
  icon: '🎨',
  shortcut: '7',
  description: 'Repaints the terrain surface with the selected biome palette.',
  onPointerDown({ editor, hit }) {
    if (!hit) return;
    editor.paintBiomeAt(hit.block);
  },
  onPointerDrag(ctx) {
    this.onPointerDown?.(ctx);
  },
  onHover({ editor, hit }) {
    editor.overlay.showCursor(hit?.block ?? null, hit?.normal);
    editor.overlay.showBrush(hit?.block ?? null, editor.settings.brushRadius, 'cylinder');
  },
  onExit(editor) {
    editor.overlay.showBrush(null, 0, 'sphere');
  },
};

export const eyedropperTool: Tool = {
  id: 'eyedropper',
  name: 'Eyedropper',
  icon: '💧',
  shortcut: '8',
  description: 'Picks the clicked block as the active block.',
  onPointerDown({ editor, hit }) {
    if (!hit) return;
    editor.pickBlock(hit.block);
  },
  onHover({ editor, hit }) {
    editor.overlay.showCursor(hit?.block ?? null, hit?.normal);
  },
};

export const lineTool: Tool = {
  id: 'line',
  name: 'Line',
  icon: '╱',
  shortcut: '9',
  description: 'Click a start point then an end point to draw a line of blocks.',
  onPointerDown({ editor, hit, button }) {
    if (!hit) return;
    if (button === 2) {
      editor.lineStart = null;
      editor.overlay.clearPreview();
      return;
    }
    if (!editor.lineStart) {
      editor.lineStart = hit.adjacent;
      editor.notify('Line start set — click the end point.');
    } else {
      editor.drawLine(editor.lineStart, hit.adjacent);
      editor.lineStart = null;
      editor.overlay.clearPreview();
    }
  },
  onHover({ editor, hit }) {
    editor.overlay.showCursor(hit?.block ?? null, hit?.normal);
    if (editor.lineStart && hit) editor.previewLine(editor.lineStart, hit.adjacent);
  },
  onExit(editor) {
    editor.lineStart = null;
    editor.overlay.clearPreview();
  },
};

export const shapeTool: Tool = {
  id: 'shape',
  name: 'Shape',
  icon: '◆',
  shortcut: '0',
  description: 'Generates a sphere, cylinder, pyramid or hollow box at the clicked point.',
  onPointerDown({ editor, hit, button }) {
    if (!hit) return;
    editor.generateShape(hit.adjacent, button === 2);
  },
  onHover({ editor, hit }) {
    editor.overlay.showCursor(hit?.block ?? null, hit?.normal);
    editor.overlay.showBrush(
      hit?.adjacent ?? null,
      editor.settings.shapeSize,
      editor.settings.shapeKind === 'box' ? 'cube' : (editor.settings.shapeKind as BrushShape),
    );
  },
  onExit(editor) {
    editor.overlay.showBrush(null, 0, 'sphere');
  },
};

export const floodTool: Tool = {
  id: 'flood',
  name: 'Flood Fill',
  icon: '🪣',
  shortcut: '-',
  description: 'Replaces a connected volume of identical blocks with the active block.',
  onPointerDown({ editor, hit }) {
    if (!hit) return;
    editor.floodFillAt(hit.block);
  },
  onHover({ editor, hit }) {
    editor.overlay.showCursor(hit?.block ?? null, hit?.normal);
  },
};

export const clipboardTool: Tool = {
  id: 'clipboard',
  name: 'Stamp',
  icon: '📋',
  shortcut: '=',
  description: 'Pastes the clipboard at the clicked location. Right click previews.',
  onPointerDown({ editor, hit, button }) {
    if (!hit) return;
    if (button === 2) editor.previewPaste(hit.adjacent);
    else editor.pasteAt(hit.adjacent);
  },
  onHover({ editor, hit }) {
    editor.overlay.showCursor(hit?.block ?? null, hit?.normal);
    if (hit) editor.previewPaste(hit.adjacent);
  },
  onExit(editor) {
    editor.overlay.clearPreview();
  },
};

export const TOOLS: Tool[] = [
  selectTool,
  placeTool,
  brushTool,
  fillTool,
  replaceTool,
  sculptTool,
  paintTool,
  eyedropperTool,
  lineTool,
  shapeTool,
  floodTool,
  clipboardTool,
];

export const toolById = (id: ToolId): Tool => TOOLS.find((t) => t.id === id) ?? selectTool;
