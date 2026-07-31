/**
 * Voxel material.
 *
 * A patched `MeshLambertMaterial` that reads the block atlas using a per-vertex
 * tile index plus a tiling UV (so greedy-merged quads repeat the texture rather
 * than stretching it), applies vertex AO, and keeps Three.js' standard lighting
 * and fog pipeline intact.
 */

import * as THREE from 'three';
import type { Atlas } from './atlas';

export interface VoxelMaterialOptions {
  transparent?: boolean;
  wireframe?: boolean;
}

export function createVoxelMaterial(atlas: Atlas, opts: VoxelMaterialOptions = {}): THREE.Material {
  const { tile, columns, width, height } = atlas.manifest;
  const rows = Math.max(1, Math.round(height / tile));

  const material = new THREE.MeshLambertMaterial({
    map: atlas.texture,
    vertexColors: false,
    transparent: opts.transparent ?? false,
    alphaTest: opts.transparent ? 0.0 : 0.5,
    depthWrite: !opts.transparent,
    side: THREE.FrontSide,
    wireframe: opts.wireframe ?? false,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlasGrid = { value: new THREE.Vector2(columns, rows) };
    shader.uniforms.uAtlasTexel = { value: new THREE.Vector2(1 / width, 1 / height) };
    shader.uniforms.uAOStrength = { value: 0.55 };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float tile;
        attribute vec3 color;
        attribute float ao;
        varying float vTile;
        varying vec3 vTint;
        varying float vAO;
        varying vec2 vTileUv;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        vTile = tile;
        vTint = color;
        vAO = ao;
        vTileUv = uv;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec2 uAtlasGrid;
        uniform vec2 uAtlasTexel;
        uniform float uAOStrength;
        varying float vTile;
        varying vec3 vTint;
        varying float vAO;
        varying vec2 vTileUv;

        vec4 sampleAtlas(sampler2D atlas) {
          float index = max(vTile, 0.0);
          float col = mod(index, uAtlasGrid.x);
          float row = floor(index / uAtlasGrid.x);
          // Repeat within the tile so merged quads tile instead of stretching.
          vec2 frac = fract(vTileUv);
          // Half-texel inset kills bleeding between neighbouring atlas tiles.
          vec2 inset = uAtlasTexel * 0.5;
          vec2 cell = vec2(1.0 / uAtlasGrid.x, 1.0 / uAtlasGrid.y);
          vec2 uv = vec2(col, row) * cell + inset + frac * (cell - inset * 2.0);
          return texture2D(atlas, uv);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          vec4 atlasColor = sampleAtlas(map);
          if (vTile < 0.0) atlasColor = vec4(1.0);
          diffuseColor *= atlasColor;
        #endif
        diffuseColor.rgb *= vTint;
        diffuseColor.rgb *= mix(1.0 - uAOStrength, 1.0, clamp(vAO, 0.0, 1.0));`,
      );
  };

  // Distinct cache key so opaque/transparent variants don't share a program.
  material.customProgramCacheKey = () => `voxel-${opts.transparent ? 't' : 'o'}`;
  return material;
}
