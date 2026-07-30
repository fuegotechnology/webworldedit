/**
 * Input system.
 *
 * Translates raw DOM pointer/keyboard events into tool invocations and editor
 * commands. Owns the picking raycast so tools receive a resolved `RaycastHit`
 * rather than screen coordinates.
 */

import * as THREE from 'three';
import type { Editor } from '../edit/editor';
import type { World } from '../world/world';
import type { CameraController } from '../render/camera-controller';
import type { RaycastHit } from '../core/types';
import { vec3 } from '../core/types';
import { TOOLS, type ToolContext } from '../edit/tools';
import { registerShortcuts } from './shortcuts';

export class InputSystem {
  private canvas: HTMLCanvasElement;
  private editor: Editor;
  private world: World;
  private camera: CameraController;
  private ndc = new THREE.Vector2();
  private ray = new THREE.Raycaster();
  private pointerDown = false;
  private lastButton = 0;
  private lastHit: RaycastHit | null = null;
  private dragThrottle = 0;
  private disposers: Array<() => void> = [];

  /** Max picking distance in blocks. */
  reach = 220;

  constructor(canvas: HTMLCanvasElement, editor: Editor, camera: CameraController) {
    this.canvas = canvas;
    this.editor = editor;
    this.world = editor.world;
    this.camera = camera;
    this.attach();
    this.disposers.push(registerShortcuts(editor, camera));
  }

  get hit(): RaycastHit | null {
    return this.lastHit;
  }

  private attach(): void {
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type as string, handler as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type as string, handler as EventListener));
    };

    on(this.canvas, 'pointerdown', this.onPointerDown);
    on(window as unknown as HTMLElement, 'pointermove', this.onPointerMove);
    on(window as unknown as HTMLElement, 'pointerup', this.onPointerUp);
  }

  private updateNdc(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /** Casts through the voxel world from the current pointer position. */
  private pick(): RaycastHit | null {
    // Pointer lock: always cast through the screen centre.
    if (document.pointerLockElement === this.canvas) this.ndc.set(0, 0);
    this.ray.setFromCamera(this.ndc, this.camera.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    return this.world.raycast(vec3(o.x, o.y, o.z), vec3(d.x, d.y, d.z), this.reach);
  }

  private context(event: PointerEvent | MouseEvent, hit: RaycastHit | null): ToolContext {
    return {
      editor: this.editor,
      hit,
      button: 'button' in event ? event.button : 0,
      shift: event.shiftKey,
      ctrl: event.ctrlKey || event.metaKey,
      alt: event.altKey,
    };
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.target !== this.canvas) return;
    this.updateNdc(event);
    const hit = this.pick();
    this.lastHit = hit;
    this.lastButton = event.button;

    // Middle mouse and right-drag belong to the camera, not to tools.
    if (event.button === 1) return;
    if (event.button === 2 && this.camera.mode === 'orbit') return;

    // In fly mode RMB looks around; a *click* without movement still edits, so
    // we defer the tool action to pointerup for RMB in fly mode.
    if (event.button === 2 && this.camera.mode === 'fly' && !document.pointerLockElement) {
      this.rmbStart = { x: event.clientX, y: event.clientY };
      return;
    }

    this.pointerDown = true;
    this.editor.activeTool.onPointerDown?.(this.context(event, hit));
  };

  private rmbStart: { x: number; y: number } | null = null;

  private onPointerMove = (event: PointerEvent): void => {
    this.updateNdc(event);
    const hit = this.pick();
    this.lastHit = hit;

    if (this.pointerDown) {
      // Throttle drag painting to at most ~120Hz worth of distinct blocks.
      const now = performance.now();
      if (now - this.dragThrottle > 16) {
        this.dragThrottle = now;
        this.editor.activeTool.onPointerDrag?.({
          ...this.context(event, hit),
          button: this.lastButton,
        });
      }
    } else if (!this.camera.isLooking || document.pointerLockElement) {
      this.editor.activeTool.onHover?.(this.context(event, hit));
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    // Resolve deferred right-click edits in fly mode (click, not look-drag).
    if (event.button === 2 && this.rmbStart) {
      const moved =
        Math.abs(event.clientX - this.rmbStart.x) + Math.abs(event.clientY - this.rmbStart.y);
      this.rmbStart = null;
      if (moved < 5 && event.target === this.canvas) {
        this.updateNdc(event);
        const hit = this.pick();
        this.lastHit = hit;
        this.editor.activeTool.onPointerDown?.(this.context(event, hit));
      }
      return;
    }
    if (!this.pointerDown) return;
    this.pointerDown = false;
    this.editor.activeTool.onPointerUp?.(this.context(event, this.lastHit));
  };

  /** Refreshes hover feedback each frame (cheap; keeps overlays in sync while flying). */
  tick(): void {
    if (this.pointerDown) return;
    if (this.camera.isLooking && !document.pointerLockElement) return;
    const hit = this.pick();
    this.lastHit = hit;
    this.editor.activeTool.onHover?.({
      editor: this.editor,
      hit,
      button: 0,
      shift: false,
      ctrl: false,
      alt: false,
    });
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}

export { TOOLS };
