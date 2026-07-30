/**
 * Keyboard shortcuts.
 *
 * Deliberately close to WorldEdit / Minecraft muscle memory where it makes
 * sense, and to standard desktop-app conventions everywhere else.
 */

import type { Editor } from '../edit/editor';
import type { CameraController } from '../render/camera-controller';
import { vec3 } from '../core/types';
import { TOOLS, type ToolId } from '../edit/tools';

export interface ShortcutSpec {
  keys: string;
  label: string;
  group: string;
}

export const SHORTCUT_REFERENCE: ShortcutSpec[] = [
  { keys: 'W A S D', label: 'Fly horizontally', group: 'Camera' },
  { keys: 'Space / Shift', label: 'Fly up / down', group: 'Camera' },
  { keys: 'Ctrl (hold)', label: 'Sprint', group: 'Camera' },
  { keys: 'RMB drag', label: 'Look around', group: 'Camera' },
  { keys: 'Scroll', label: 'Adjust fly speed / zoom', group: 'Camera' },
  { keys: 'O', label: 'Toggle orbit / fly camera', group: 'Camera' },
  { keys: 'F', label: 'Focus on selection', group: 'Camera' },
  { keys: 'G', label: 'Toggle grid', group: 'Camera' },

  { keys: '1 … 0', label: 'Switch tool', group: 'Tools' },
  { keys: 'Q / E', label: 'Decrease / increase brush radius', group: 'Tools' },
  { keys: 'Alt + click', label: 'Eyedropper (pick block)', group: 'Tools' },
  { keys: '[ / ]', label: 'Previous / next hotbar slot', group: 'Tools' },

  { keys: 'Ctrl + Z', label: 'Undo', group: 'Edit' },
  { keys: 'Ctrl + Shift + Z', label: 'Redo', group: 'Edit' },
  { keys: 'Ctrl + C / X / V', label: 'Copy / cut / paste', group: 'Edit' },
  { keys: 'Ctrl + A', label: 'Select everything', group: 'Edit' },
  { keys: 'Enter', label: 'Fill selection with active block', group: 'Edit' },
  { keys: 'Delete', label: 'Clear selection to air', group: 'Edit' },
  { keys: 'Ctrl + R', label: 'Rotate clipboard 90°', group: 'Edit' },
  { keys: 'Ctrl + M', label: 'Mirror clipboard on X', group: 'Edit' },
  { keys: 'Esc', label: 'Clear selection / preview', group: 'Edit' },

  { keys: 'Ctrl + K', label: 'Focus the AI command bar', group: 'General' },
  { keys: 'Ctrl + S', label: 'Save project JSON', group: 'General' },
  { keys: 'Ctrl + O', label: 'Open project JSON', group: 'General' },
  { keys: '?', label: 'Toggle this shortcut list', group: 'General' },
];

const isTypingTarget = (el: EventTarget | null): boolean => {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
};

export function registerShortcuts(editor: Editor, camera: CameraController): () => void {
  const toolByShortcut = new Map<string, ToolId>();
  for (const tool of TOOLS) if (tool.shortcut) toolByShortcut.set(tool.shortcut, tool.id);

  const handler = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) {
      camera.setInputBlocked(true);
      if (event.key === 'Escape') (event.target as HTMLElement).blur();
      return;
    }
    camera.setInputBlocked(false);

    const ctrl = event.ctrlKey || event.metaKey;
    const shift = event.shiftKey;
    const key = event.key;

    // ---- Ctrl-modified commands
    if (ctrl) {
      switch (key.toLowerCase()) {
        case 'z':
          event.preventDefault();
          shift ? editor.redo() : editor.undo();
          return;
        case 'y':
          event.preventDefault();
          editor.redo();
          return;
        case 'c':
          event.preventDefault();
          editor.copySelection();
          return;
        case 'x':
          event.preventDefault();
          editor.cutSelection();
          return;
        case 'v':
          event.preventDefault();
          editor.pasteAtSelection();
          return;
        case 'a':
          event.preventDefault();
          editor.selectAll();
          return;
        case 'r':
          event.preventDefault();
          editor.rotateClipboard(1);
          return;
        case 'm':
          event.preventDefault();
          editor.mirrorClipboard('x');
          return;
        case 'k':
          event.preventDefault();
          document.dispatchEvent(new CustomEvent('webworld:focus-command'));
          return;
        case 's':
          event.preventDefault();
          document.dispatchEvent(new CustomEvent('webworld:save'));
          return;
        case 'o':
          event.preventDefault();
          document.dispatchEvent(new CustomEvent('webworld:open'));
          return;
      }
      return;
    }

    // ---- tool hotkeys
    const toolId = toolByShortcut.get(key);
    if (toolId) {
      editor.setTool(toolId);
      return;
    }

    switch (key) {
      case 'q':
      case 'Q':
        editor.update({ brushRadius: Math.max(1, editor.settings.brushRadius - 1) });
        break;
      case 'e':
      case 'E':
        editor.update({ brushRadius: Math.min(64, editor.settings.brushRadius + 1) });
        break;
      case 'f':
      case 'F':
        editor.focusSelection();
        break;
      case 'g':
      case 'G':
        editor.update({ showGrid: !editor.settings.showGrid });
        break;
      case 'o':
      case 'O':
        camera.setMode(camera.mode === 'fly' ? 'orbit' : 'fly');
        editor.notify(`Camera: ${camera.mode} mode`, 'info');
        break;
      case '[':
        editor.selectHotbar(editor.settings.hotbarIndex - 1);
        break;
      case ']':
        editor.selectHotbar(editor.settings.hotbarIndex + 1);
        break;
      case 'Enter':
        editor.fillSelection();
        break;
      case 'Delete':
      case 'Backspace':
        editor.fillSelection(0);
        break;
      case 'Escape':
        editor.clearPreview();
        editor.selection.clear();
        camera.exitPointerLock();
        document.dispatchEvent(new CustomEvent('webworld:escape'));
        break;
      case '?':
        document.dispatchEvent(new CustomEvent('webworld:toggle-help'));
        break;
      case 'ArrowUp':
        if (shift) editor.moveSelection(vec3(0, 1, 0), 1);
        break;
      case 'ArrowDown':
        if (shift) editor.moveSelection(vec3(0, -1, 0), 1);
        break;
      default:
        break;
    }
  };

  const focusIn = (e: FocusEvent) => camera.setInputBlocked(isTypingTarget(e.target));
  window.addEventListener('keydown', handler);
  window.addEventListener('focusin', focusIn);
  window.addEventListener('focusout', () => camera.setInputBlocked(false));

  return () => {
    window.removeEventListener('keydown', handler);
    window.removeEventListener('focusin', focusIn);
  };
}
