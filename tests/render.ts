/**
 * Render-path verification.
 *
 * A real GPU/browser is unavailable in CI, so this suite exercises everything
 * up to the driver call: mesher output is fed into genuine `THREE.BufferGeometry`
 * objects, the voxel material's `onBeforeCompile` is run against the actual
 * Lambert shader source shipped by the installed three version, and frustum
 * culling is checked with real `THREE.Frustum` math.
 *
 * This catches the failure modes that would otherwise only show up as a black
 * screen: mismatched attribute counts, out-of-range indices, wrong bounding
 * volumes, and shader patches whose anchor tokens no longer exist upstream.
 *
 *   npm run test:render
 */

import * as THREE from 'three';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
g.Image = dom.window.Image;
dom.window.HTMLCanvasElement.prototype.getContext = function () {
  return { fillRect() {}, fillStyle: '', imageSmoothingEnabled: false, drawImage() {} };
} as never;
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA';
g.fetch = async () => ({ ok: false });

let passed = 0;
let failed = 0;
const group = (n: string) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const ok = (c: boolean, m: string) => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); }
};

async function main() {
  const { greedyMesh, PADDED } = await import('../src/render/mesher');
  const { blockRegistry } = await import('../src/world/blocks');
  const { loadAtlas } = await import('../src/render/atlas');
  const { createVoxelMaterial } = await import('../src/render/material');
  const { CHUNK_SIZE } = await import('../src/world/chunk');

  const stone = blockRegistry.resolve('stone')!.id;
  const glass = blockRegistry.resolve('glass')!.id;

  const info = {
    tiles: new Int32Array(blockRegistry.blocks.length * 6).fill(3),
    colors: new Float32Array(blockRegistry.blocks.length * 3).fill(1),
    opaque: new Uint8Array(blockRegistry.blocks.length),
    translucent: new Uint8Array(blockRegistry.blocks.length),
  };
  info.opaque[stone] = 1;
  info.translucent[glass] = 1;

  const idx = (x: number, y: number, z: number) =>
    (y + 1) * PADDED * PADDED + (z + 1) * PADDED + (x + 1);

  // A representative chunk: solid lower half plus a scattered upper layer.
  const volume = new Uint16Array(PADDED ** 3);
  for (let y = 0; y < 8; y++)
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) volume[idx(x, y, z)] = stone;
  for (let z = 0; z < 16; z += 3)
    for (let x = 0; x < 16; x += 3) volume[idx(x, 8, z)] = glass;

  const mesh = greedyMesh(volume, info);

  // ------------------------------------------------------------- buffers
  group('Mesher → GPU buffer integrity');
  const verts = mesh.position.length / 3;
  ok(verts > 0, `opaque pass produced ${verts} vertices / ${mesh.index.length / 3} triangles`);
  ok(mesh.normal.length / 3 === verts, 'normal count matches vertex count');
  ok(mesh.uv.length / 2 === verts, 'uv count matches vertex count');
  ok(mesh.tile.length === verts, 'tile attribute count matches vertex count');
  ok(mesh.color.length / 3 === verts, 'color count matches vertex count');
  ok(mesh.ao.length === verts, 'ao count matches vertex count');
  ok(verts % 4 === 0, 'vertices arrive as whole quads');
  ok(mesh.index.length % 3 === 0, 'index buffer is whole triangles');

  let maxIndex = 0;
  for (const i of mesh.index) maxIndex = Math.max(maxIndex, i);
  ok(maxIndex < verts, `no index exceeds the vertex buffer (max ${maxIndex} < ${verts})`);

  ok([...mesh.normal].every((v) => v === 0 || v === 1 || v === -1), 'normals are axis-aligned unit vectors');
  ok([...mesh.ao].every((v) => v >= 0 && v <= 1), 'ao values are normalised to 0..1');
  ok([...mesh.position].every(Number.isFinite), 'no NaN/Infinity in positions');
  ok(
    [...mesh.position].every((v) => v >= 0 && v <= CHUNK_SIZE),
    'all geometry lies inside the chunk bounds',
  );

  group('Transparent pass separation');
  ok(mesh.transparent.index.length > 0, 'glass produced transparent geometry');
  let tMax = 0;
  for (const i of mesh.transparent.index) tMax = Math.max(tMax, i);
  ok(tMax < mesh.transparent.position.length / 3, 'transparent indices are in range');
  ok(
    mesh.transparent.position.length / 3 === mesh.transparent.ao.length,
    'transparent attributes are internally consistent',
  );

  // ------------------------------------------------- real THREE geometry
  group('THREE.BufferGeometry construction');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uv, 2));
  geometry.setAttribute('tile', new THREE.BufferAttribute(mesh.tile, 1));
  geometry.setAttribute('color', new THREE.BufferAttribute(mesh.color, 3));
  geometry.setAttribute('ao', new THREE.BufferAttribute(mesh.ao, 1));
  geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));
  ok(geometry.getAttribute('position').count === verts, 'THREE accepts the position attribute');
  ok(geometry.getIndex()!.count === mesh.index.length, 'THREE accepts the index buffer');

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bb = geometry.boundingBox!;
  ok(
    bb.min.x >= 0 && bb.max.x <= CHUNK_SIZE && bb.min.y >= 0 && bb.max.y <= CHUNK_SIZE,
    `computed bounding box stays in chunk space (${bb.min.x},${bb.min.y},${bb.min.z} → ${bb.max.x},${bb.max.y},${bb.max.z})`,
  );
  ok(Number.isFinite(geometry.boundingSphere!.radius), 'bounding sphere is finite');

  // The renderer assigns a fixed bounding volume rather than computing one;
  // verify that hand-rolled sphere actually contains the real geometry.
  const assumed = new THREE.Sphere(
    new THREE.Vector3(CHUNK_SIZE / 2, CHUNK_SIZE / 2, CHUNK_SIZE / 2),
    CHUNK_SIZE * 0.87,
  );
  let outside = 0;
  const p = new THREE.Vector3();
  for (let i = 0; i < verts; i++) {
    p.fromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute, i);
    if (!assumed.containsPoint(p)) outside++;
  }
  ok(outside === 0, `ChunkRenderer's fixed bounding sphere contains all geometry (${outside} strays)`);

  // -------------------------------------------------------------- shader
  group('Voxel material shader patch');
  const atlas = await loadAtlas();
  const material = createVoxelMaterial(atlas, { transparent: false }) as THREE.MeshLambertMaterial;
  ok(material.onBeforeCompile !== undefined, 'material installs an onBeforeCompile hook');

  // Run the patch against the genuine Lambert shader from this three version.
  const lambert = THREE.ShaderLib.lambert;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lambert.uniforms) as Record<string, { value: unknown }>,
    vertexShader: lambert.vertexShader,
    fragmentShader: lambert.fragmentShader,
    defines: {},
  };
  const beforeV = shader.vertexShader.length;
  const beforeF = shader.fragmentShader.length;
  material.onBeforeCompile(shader as never, null as never);

  ok(shader.vertexShader.length > beforeV, 'vertex shader was actually modified');
  ok(shader.fragmentShader.length > beforeF, 'fragment shader was actually modified');
  ok(shader.vertexShader.includes('attribute float tile;'), 'tile attribute declared in vertex shader');
  ok(shader.vertexShader.includes('attribute float ao;'), 'ao attribute declared in vertex shader');
  ok(shader.vertexShader.includes('vTile = tile;'), 'varyings are assigned in the vertex stage');
  ok(shader.fragmentShader.includes('sampleAtlas'), 'atlas sampler injected into fragment shader');
  ok(shader.fragmentShader.includes('uAtlasGrid'), 'atlas grid uniform referenced');
  ok(!shader.fragmentShader.includes('#include <map_fragment>'), 'map_fragment include was replaced, not appended');
  ok(shader.uniforms.uAtlasGrid !== undefined, 'uAtlasGrid uniform registered');
  ok(shader.uniforms.uAtlasTexel !== undefined, 'uAtlasTexel uniform registered');
  ok(shader.uniforms.uAOStrength !== undefined, 'uAOStrength uniform registered');

  // Every varying written by the vertex stage must be declared in the fragment
  // stage, or the program link fails at runtime with a black screen.
  const varyings = ['vTile', 'vTint', 'vAO', 'vTileUv'];
  ok(
    varyings.every((v) => shader.vertexShader.includes(`varying`) && shader.vertexShader.includes(v)),
    'all varyings declared in vertex shader',
  );
  ok(
    varyings.every((v) => shader.fragmentShader.includes(v)),
    'all varyings consumed in fragment shader',
  );

  // Balanced braces is a cheap proxy for "the injected GLSL is syntactically sane".
  const balanced = (s: string) => {
    let d = 0;
    for (const ch of s) {
      if (ch === '{') d++;
      else if (ch === '}') d--;
      if (d < 0) return false;
    }
    return d === 0;
  };
  ok(balanced(shader.vertexShader), 'patched vertex shader has balanced braces');
  ok(balanced(shader.fragmentShader), 'patched fragment shader has balanced braces');

  const transparentMat = createVoxelMaterial(atlas, { transparent: true });
  ok(
    material.customProgramCacheKey!() !== (transparentMat as THREE.Material).customProgramCacheKey!(),
    'opaque and transparent variants use distinct program cache keys',
  );
  ok((transparentMat as THREE.MeshLambertMaterial).depthWrite === false, 'transparent pass disables depth writes');

  // ------------------------------------------------------------- culling
  group('Frustum culling');
  const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 4000);
  camera.position.set(0, 20, 60);
  camera.lookAt(0, 20, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const sphereAt = (x: number, y: number, z: number) =>
    new THREE.Sphere(new THREE.Vector3(x + 8, y + 8, z + 8), CHUNK_SIZE * 0.87);

  ok(frustum.intersectsSphere(sphereAt(-8, 12, 0)), 'chunk in front of the camera is visible');
  ok(!frustum.intersectsSphere(sphereAt(-8, 12, 400)), 'chunk far behind the camera is culled');
  ok(!frustum.intersectsSphere(sphereAt(2000, 12, 0)), 'chunk far off-axis is culled');
  ok(!frustum.intersectsSphere(sphereAt(-8, 12, -5000)), 'chunk beyond the far plane is culled');

  // ----------------------------------------------------------- scene graph
  group('Scene graph assembly');
  const scene = new THREE.Scene();
  const group3 = new THREE.Group();
  const chunkMesh = new THREE.Mesh(geometry, material);
  chunkMesh.position.set(32, 0, -16);
  chunkMesh.matrixAutoUpdate = false;
  chunkMesh.updateMatrix();
  group3.add(chunkMesh);
  scene.add(group3);
  scene.updateMatrixWorld(true);

  const world = new THREE.Vector3().setFromMatrixPosition(chunkMesh.matrixWorld);
  ok(world.x === 32 && world.z === -16, 'chunk world transform is applied with matrixAutoUpdate off');

  let meshCount = 0;
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshCount++;
  });
  ok(meshCount === 1, 'scene graph contains the chunk mesh');

  const empty = greedyMesh(new Uint16Array(PADDED ** 3), info);
  ok(empty.index.length === 0 && empty.transparent.index.length === 0, 'empty chunk produces no geometry at all');

  const total = passed + failed;
  console.log(`\n${'─'.repeat(58)}`);
  console.log(
    failed === 0
      ? `\x1b[32m\x1b[1m  ALL ${total} RENDER CHECKS PASSED\x1b[0m`
      : `\x1b[31m\x1b[1m  ${failed} of ${total} RENDER CHECKS FAILED\x1b[0m`,
  );
  console.log(`${'─'.repeat(58)}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\x1b[31mRender harness crashed:\x1b[0m', err);
  process.exitCode = 1;
});
