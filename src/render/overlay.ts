/**
 * Overlay renderer: everything that isn't world voxels.
 *
 * - block cursor highlight
 * - selection box (with corner handles) and multi-selection boxes
 * - brush footprint preview
 * - translucent instanced preview of pending AI / tool operations
 * - ground grid
 *
 * Previews use a single `InstancedMesh` so a 50k-block AI proposal costs one
 * draw call.
 */

import * as THREE from 'three';
import type { Region, Vec3 } from '../core/types';
import { blockRegistry } from '../world/blocks';

const UNIT = new THREE.BoxGeometry(1, 1, 1);

export class Overlay {
  readonly group = new THREE.Group();

  private cursor: THREE.LineSegments;
  private cursorFace: THREE.Mesh;
  private selectionBox: THREE.LineSegments;
  private selectionFill: THREE.Mesh;
  private extraSelections: THREE.LineSegments[] = [];
  private preview: THREE.InstancedMesh;
  private previewCapacity = 0;
  private grid: THREE.GridHelper;
  private brushMesh: THREE.Mesh;

  constructor() {
    this.group.name = 'overlay';

    // --- block cursor
    const edges = new THREE.EdgesGeometry(UNIT);
    this.cursor = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.cursor.renderOrder = 999;
    this.cursor.visible = false;
    this.group.add(this.cursor);

    this.cursorFace = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x6ee7ff,
        transparent: true,
        opacity: 0.22,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
    this.cursorFace.renderOrder = 998;
    this.cursorFace.visible = false;
    this.group.add(this.cursorFace);

    // --- selection
    this.selectionBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(UNIT),
      new THREE.LineBasicMaterial({ color: 0xffc046, transparent: true, opacity: 1, depthTest: false }),
    );
    this.selectionBox.renderOrder = 1000;
    this.selectionBox.visible = false;
    this.group.add(this.selectionBox);

    this.selectionFill = new THREE.Mesh(
      UNIT,
      new THREE.MeshBasicMaterial({
        color: 0xffc046,
        transparent: true,
        opacity: 0.08,
        depthWrite: false,
        side: THREE.BackSide,
      }),
    );
    this.selectionFill.renderOrder = 997;
    this.selectionFill.visible = false;
    this.group.add(this.selectionFill);

    // --- brush footprint
    this.brushMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x6ee7ff, transparent: true, opacity: 0.14, depthWrite: false }),
    );
    this.brushMesh.visible = false;
    this.group.add(this.brushMesh);

    // --- operation preview
    this.preview = new THREE.InstancedMesh(
      UNIT,
      new THREE.MeshLambertMaterial({
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        vertexColors: true,
      }),
      0,
    );
    this.preview.frustumCulled = false;
    this.preview.visible = false;
    this.group.add(this.preview);

    // --- grid
    this.grid = new THREE.GridHelper(512, 32, 0x3a4150, 0x252a35);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.grid.position.set(0, 0.01, 0);
    this.group.add(this.grid);
  }

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
  }

  setGridHeight(y: number): void {
    this.grid.position.y = y + 0.01;
  }

  showCursor(block: Vec3 | null, normal?: Vec3): void {
    if (!block) {
      this.cursor.visible = false;
      this.cursorFace.visible = false;
      return;
    }
    this.cursor.visible = true;
    this.cursor.position.set(block.x + 0.5, block.y + 0.5, block.z + 0.5);
    this.cursor.scale.setScalar(1.002);

    if (normal && (normal.x || normal.y || normal.z)) {
      this.cursorFace.visible = true;
      this.cursorFace.position.set(
        block.x + 0.5 + normal.x * 0.503,
        block.y + 0.5 + normal.y * 0.503,
        block.z + 0.5 + normal.z * 0.503,
      );
      this.cursorFace.lookAt(
        this.cursorFace.position.x + normal.x,
        this.cursorFace.position.y + normal.y,
        this.cursorFace.position.z + normal.z,
      );
    } else {
      this.cursorFace.visible = false;
    }
  }

  showBrush(center: Vec3 | null, radius: number, shape: 'sphere' | 'cube' | 'cylinder'): void {
    if (!center) {
      this.brushMesh.visible = false;
      return;
    }
    this.brushMesh.visible = true;
    const geom =
      shape === 'sphere'
        ? new THREE.SphereGeometry(radius + 0.5, 20, 14)
        : shape === 'cylinder'
          ? new THREE.CylinderGeometry(radius + 0.5, radius + 0.5, radius * 2 + 1, 24)
          : new THREE.BoxGeometry(radius * 2 + 1, radius * 2 + 1, radius * 2 + 1);
    this.brushMesh.geometry.dispose();
    this.brushMesh.geometry = geom;
    this.brushMesh.position.set(center.x + 0.5, center.y + 0.5, center.z + 0.5);
  }

  showSelection(region: Region | null, extras: Region[] = []): void {
    for (const mesh of this.extraSelections) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.extraSelections = [];

    if (!region) {
      this.selectionBox.visible = false;
      this.selectionFill.visible = false;
    } else {
      const sx = region.max.x - region.min.x + 1;
      const sy = region.max.y - region.min.y + 1;
      const sz = region.max.z - region.min.z + 1;
      const cx = region.min.x + sx / 2;
      const cy = region.min.y + sy / 2;
      const cz = region.min.z + sz / 2;
      for (const obj of [this.selectionBox, this.selectionFill]) {
        obj.visible = true;
        obj.position.set(cx, cy, cz);
        obj.scale.set(sx, sy, sz);
      }
    }

    for (const extra of extras) {
      const mesh = new THREE.LineSegments(
        new THREE.EdgesGeometry(UNIT),
        new THREE.LineBasicMaterial({ color: 0x8b93a5, transparent: true, opacity: 0.7, depthTest: false }),
      );
      const sx = extra.max.x - extra.min.x + 1;
      const sy = extra.max.y - extra.min.y + 1;
      const sz = extra.max.z - extra.min.z + 1;
      mesh.position.set(extra.min.x + sx / 2, extra.min.y + sy / 2, extra.min.z + sz / 2);
      mesh.scale.set(sx, sy, sz);
      mesh.renderOrder = 1000;
      this.group.add(mesh);
      this.extraSelections.push(mesh);
    }
  }

  /** Renders a pending operation as translucent instanced blocks. */
  showPreview(blocks: Array<{ x: number; y: number; z: number; id: number }>): void {
    if (blocks.length === 0) {
      this.preview.visible = false;
      this.preview.count = 0;
      return;
    }
    if (blocks.length > this.previewCapacity) {
      this.group.remove(this.preview);
      this.preview.dispose();
      const capacity = Math.ceil(blocks.length * 1.35);
      this.preview = new THREE.InstancedMesh(
        UNIT,
        new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.62, depthWrite: false, vertexColors: true }),
        capacity,
      );
      this.preview.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      this.preview.frustumCulled = false;
      this.group.add(this.preview);
      this.previewCapacity = capacity;
    }

    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      matrix.makeTranslation(b.x + 0.5, b.y + 0.5, b.z + 0.5);
      this.preview.setMatrixAt(i, matrix);
      color.setHex(blockRegistry.get(b.id).color, THREE.SRGBColorSpace);
      this.preview.setColorAt(i, color);
    }
    this.preview.count = blocks.length;
    this.preview.instanceMatrix.needsUpdate = true;
    if (this.preview.instanceColor) this.preview.instanceColor.needsUpdate = true;
    this.preview.visible = true;
  }

  clearPreview(): void {
    this.preview.visible = false;
    this.preview.count = 0;
  }

  dispose(): void {
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
    });
  }
}
