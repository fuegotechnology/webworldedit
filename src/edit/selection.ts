/**
 * Selection system.
 *
 * Mirrors WorldEdit semantics: two positions define the primary cuboid region.
 * Additional regions can be added to build a multi-selection; operations run
 * over every region in the set.
 */

import { EventBus } from '../core/events';
import {
  normalizeRegion,
  regionVolume,
  type Region,
  type Vec3,
  vec3,
} from '../core/types';

export interface SelectionEvents {
  changed: { primary: Region | null; regions: Region[] };
}

export class Selection {
  readonly events = new EventBus<SelectionEvents>();

  pos1: Vec3 | null = null;
  pos2: Vec3 | null = null;
  /** Extra regions beyond the primary one (multi-selection). */
  extra: Region[] = [];

  get primary(): Region | null {
    if (!this.pos1 || !this.pos2) return null;
    return normalizeRegion(this.pos1, this.pos2);
  }

  /** Primary + extras. */
  get regions(): Region[] {
    const p = this.primary;
    return p ? [p, ...this.extra] : [...this.extra];
  }

  get volume(): number {
    return this.regions.reduce((sum, r) => sum + regionVolume(r), 0);
  }

  setPos1(p: Vec3): void {
    this.pos1 = vec3(p.x, p.y, p.z);
    this.emit();
  }

  setPos2(p: Vec3): void {
    this.pos2 = vec3(p.x, p.y, p.z);
    this.emit();
  }

  set(a: Vec3, b: Vec3): void {
    this.pos1 = vec3(a.x, a.y, a.z);
    this.pos2 = vec3(b.x, b.y, b.z);
    this.emit();
  }

  setRegion(region: Region): void {
    this.set(region.min, region.max);
  }

  /** Pushes the current primary region into the multi-selection set. */
  pushRegion(): boolean {
    const p = this.primary;
    if (!p) return false;
    this.extra.push(p);
    this.pos1 = null;
    this.pos2 = null;
    this.emit();
    return true;
  }

  clear(): void {
    this.pos1 = null;
    this.pos2 = null;
    this.extra = [];
    this.emit();
  }

  /** Grows the selection outward on all axes (WorldEdit `//expand`). */
  expand(amount: number): void {
    const p = this.primary;
    if (!p) return;
    this.set(
      vec3(p.min.x - amount, p.min.y - amount, p.min.z - amount),
      vec3(p.max.x + amount, p.max.y + amount, p.max.z + amount),
    );
  }

  contract(amount: number): void {
    this.expand(-amount);
  }

  shift(delta: Vec3): void {
    const p = this.primary;
    if (!p) return;
    this.set(
      vec3(p.min.x + delta.x, p.min.y + delta.y, p.min.z + delta.z),
      vec3(p.max.x + delta.x, p.max.y + delta.y, p.max.z + delta.z),
    );
  }

  private emit(): void {
    this.events.emit('changed', { primary: this.primary, regions: this.regions });
  }
}
