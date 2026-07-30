/**
 * Camera controller supporting two modes:
 *
 *  - `fly`   — Minecraft-creative style WASD + mouse-look (pointer lock or RMB drag),
 *              Space/Shift for vertical, Ctrl to sprint, scroll to change speed.
 *  - `orbit` — turntable around a focus point; LMB-drag orbits, MMB pans, scroll dollies.
 *
 * Both modes share the same `THREE.PerspectiveCamera` and can be switched at any
 * time without losing position.
 */

import * as THREE from 'three';
import type { Region, Vec3 } from '../core/types';

export type CameraMode = 'fly' | 'orbit';

export interface CameraOptions {
  fov?: number;
  near?: number;
  far?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'fly';

  /** Blocks per second at normal speed. */
  moveSpeed = 22;
  sprintMultiplier = 3.5;
  lookSensitivity = 0.0022;
  /** Orbit focus point. */
  target = new THREE.Vector3(0, 64, 0);

  private yaw = 0;
  private pitch = 0;
  private orbitDistance = 60;
  private velocity = new THREE.Vector3();
  private keys = new Set<string>();
  private dragging: 'none' | 'look' | 'orbit' | 'pan' = 'none';
  private pointerLocked = false;
  private element: HTMLElement;
  private enabled = true;
  /** Set while a UI field has focus so WASD types instead of flying. */
  private inputBlocked = false;

  constructor(element: HTMLElement, opts: CameraOptions = {}) {
    this.element = element;
    this.camera = new THREE.PerspectiveCamera(
      opts.fov ?? 72,
      1,
      opts.near ?? 0.1,
      opts.far ?? 4000,
    );
    this.camera.position.set(40, 90, 40);
    this.lookAt(new THREE.Vector3(0, 64, 0));
    this.attach();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.keys.clear();
  }

  setInputBlocked(blocked: boolean): void {
    this.inputBlocked = blocked;
    if (blocked) this.keys.clear();
  }

  get isLooking(): boolean {
    return this.dragging === 'look' || this.pointerLocked;
  }

  // -------------------------------------------------------------- lifecycle

  private attach(): void {
    const el = this.element;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === el;
      if (!this.pointerLocked && this.dragging === 'look') this.dragging = 'none';
    });
  }

  dispose(): void {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  // -------------------------------------------------------------- handlers

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    if (event.button === 2) {
      this.dragging = this.mode === 'fly' ? 'look' : 'orbit';
      this.element.setPointerCapture?.(event.pointerId);
    } else if (event.button === 1) {
      this.dragging = 'pan';
      event.preventDefault();
    } else if (event.button === 0 && this.mode === 'orbit' && event.altKey) {
      this.dragging = 'orbit';
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.enabled) return;
    const dx = event.movementX ?? 0;
    const dy = event.movementY ?? 0;

    if (this.pointerLocked || this.dragging === 'look') {
      this.yaw -= dx * this.lookSensitivity;
      this.pitch = clamp(this.pitch - dy * this.lookSensitivity, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
      this.applyRotation();
    } else if (this.dragging === 'orbit') {
      this.yaw -= dx * this.lookSensitivity * 1.6;
      this.pitch = clamp(this.pitch - dy * this.lookSensitivity * 1.6, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
      this.applyOrbit();
    } else if (this.dragging === 'pan') {
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
      const scale = this.mode === 'orbit' ? this.orbitDistance * 0.0016 : 0.06;
      const delta = right.multiplyScalar(-dx * scale).add(up.multiplyScalar(dy * scale));
      this.camera.position.add(delta);
      this.target.add(delta);
    }
  };

  private onPointerUp = (): void => {
    this.dragging = 'none';
  };

  private onWheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    if (this.mode === 'orbit' && !event.shiftKey) {
      this.orbitDistance = clamp(this.orbitDistance * (1 + Math.sign(event.deltaY) * 0.12), 2, 2000);
      this.applyOrbit();
    } else {
      // Fly mode: scroll adjusts movement speed (WorldEdit-ish muscle memory).
      this.moveSpeed = clamp(this.moveSpeed * (1 - Math.sign(event.deltaY) * 0.12), 1, 400);
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.inputBlocked) return;
    this.keys.add(event.code);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  requestPointerLock(): void {
    if (this.mode === 'fly') this.element.requestPointerLock?.();
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // -------------------------------------------------------------- maths

  private applyRotation(): void {
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    this.camera.quaternion.copy(quat);
    if (this.mode === 'orbit') this.applyOrbit();
  }

  private applyOrbit(): void {
    const offset = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    ).multiplyScalar(this.orbitDistance);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.pitch = e.x;
    this.yaw = e.y;
  }

  lookAt(point: THREE.Vector3 | Vec3): void {
    const v = point instanceof THREE.Vector3 ? point : new THREE.Vector3(point.x, point.y, point.z);
    this.camera.lookAt(v);
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.pitch = e.x;
    this.yaw = e.y;
    this.target.copy(v);
    this.orbitDistance = this.camera.position.distanceTo(v);
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.exitPointerLock();
    if (mode === 'orbit') {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.target.copy(this.camera.position).add(forward.multiplyScalar(this.orbitDistance));
      this.applyOrbit();
    }
  }

  /** Frames a region: positions the camera so the whole box is visible. */
  focusRegion(region: Region): void {
    const cx = (region.min.x + region.max.x + 1) / 2;
    const cy = (region.min.y + region.max.y + 1) / 2;
    const cz = (region.min.z + region.max.z + 1) / 2;
    const size = Math.max(
      region.max.x - region.min.x + 1,
      region.max.y - region.min.y + 1,
      region.max.z - region.min.z + 1,
    );
    const fov = (this.camera.fov * Math.PI) / 180;
    const distance = Math.max(6, (size * 0.75) / Math.tan(fov / 2)) * 1.15;
    this.target.set(cx, cy, cz);
    this.orbitDistance = distance;
    const dir = new THREE.Vector3(0.75, 0.55, 0.75).normalize().multiplyScalar(distance);
    this.camera.position.copy(this.target).add(dir);
    this.lookAt(this.target);
  }

  focusPoint(p: Vec3, distance = 30): void {
    this.focusRegion({
      min: { x: p.x - distance / 3, y: p.y - distance / 3, z: p.z - distance / 3 },
      max: { x: p.x + distance / 3, y: p.y + distance / 3, z: p.z + distance / 3 },
    });
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    if (!this.enabled || this.mode !== 'fly') {
      this.velocity.setScalar(0);
      return;
    }
    const dir = new THREE.Vector3();
    if (this.keys.has('KeyW')) dir.z -= 1;
    if (this.keys.has('KeyS')) dir.z += 1;
    if (this.keys.has('KeyA')) dir.x -= 1;
    if (this.keys.has('KeyD')) dir.x += 1;
    if (this.keys.has('Space')) dir.y += 1;
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) dir.y -= 1;

    const speed =
      this.moveSpeed *
      (this.keys.has('ControlLeft') || this.keys.has('ControlRight') ? this.sprintMultiplier : 1);

    if (dir.lengthSq() > 0) {
      dir.normalize();
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const move = new THREE.Vector3()
        .addScaledVector(forward, -dir.z)
        .addScaledVector(right, dir.x);
      move.y += dir.y;
      if (move.lengthSq() > 0) move.normalize();
      this.velocity.lerp(move.multiplyScalar(speed), 1 - Math.exp(-18 * dt));
    } else {
      this.velocity.lerp(new THREE.Vector3(), 1 - Math.exp(-22 * dt));
    }

    if (this.velocity.lengthSq() > 1e-6) {
      this.camera.position.addScaledVector(this.velocity, dt);
    }
  }
}
