import * as THREE from 'three';
import { GEOMETRY as G, DETAIL_GEOMETRY as D, probeBoreSpec } from './geometry.js';

// Small, repeatable manufacturing marks used only for surface relief.
export function surfaceFinish(renderer, brushed) {
  const size = 128, canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(size, size);
  let seed = 617;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let y = 0; y < size; y++) {
    const pass = 113 + 31 * noise();
    for (let x = 0; x < size; x++) {
      const gray = brushed ? pass + 15 * noise() : 105 + 53 * noise();
      const offset = 4 * (y * size + x);
      pixels.data.set([gray, gray, gray, 255], offset);
    }
  }
  context.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

export function machiningUVs(geometry) {
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
    const face = Math.abs(normals.getZ(i)) > .6;
    const top = Math.abs(normals.getY(i)) > .7;
    uv.setXY(i, (face ? x : z) / .038, (top ? x : y) / .021);
  }
  return geometry;
}

export function shadeCutaway(geometry, kind) {
  const { center, bottomZ, frontZ, radius } = probeBoreSpec(kind);
  const [x, y, z] = G[kind].center;
  const boreX = center[0] - x, cutY = center[1] - y, epsilon = 1e-7;
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i += 3) {
    const cutFace = normals.getY(i) > .999 && Math.abs(positions.getY(i) - cutY) < epsilon;
    let insideBore = true;
    for (let vertex = i; vertex < i + 3; vertex++) {
      const depth = positions.getZ(vertex) + z;
      const offset = Math.hypot(positions.getX(vertex) - boreX, positions.getY(vertex) - cutY);
      insideBore &&= depth >= bottomZ - epsilon && depth <= frontZ + epsilon && offset <= radius + epsilon;
    }
    // Sample the cavity and cut surface as different neutral finishes for inspection.
    colors.fill(cutFace ? .73 : insideBore ? .18 : 1, i * 3, (i + 3) * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

export function coolingFinGeometry() {
  const { height, length, thickness } = G.fins;
  const y = height / 2, z = length / 2;
  const bevel = .0002, tip = .002;
  const profile = new THREE.Shape([
    new THREE.Vector2(-z + bevel, -y + bevel),
    new THREE.Vector2(z - bevel, -y + bevel),
    new THREE.Vector2(z - bevel, y - tip),
    new THREE.Vector2(z - tip, y - bevel),
    new THREE.Vector2(-z + tip, y - bevel),
    new THREE.Vector2(-z + bevel, y - tip),
  ]);
  const depth = thickness - 2 * bevel;
  const geometry = new THREE.ExtrudeGeometry(profile, {
    depth, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.rotateY(Math.PI / 2);
  return machiningUVs(geometry);
}

function roundedSquare(half, radius) {
  const n = half - radius;
  const shape = new THREE.Shape();
  shape.moveTo(-n, -half);
  shape.lineTo(n, -half);
  shape.quadraticCurveTo(half, -half, half, -n);
  shape.lineTo(half, n);
  shape.quadraticCurveTo(half, half, n, half);
  shape.lineTo(-n, half);
  shape.quadraticCurveTo(-half, half, -half, n);
  shape.lineTo(-half, -n);
  shape.quadraticCurveTo(-half, -half, -n, -half);
  shape.closePath();
  return shape;
}

function roundHole(shape, x, y, radius) {
  const bore = new THREE.Path();
  bore.absarc(x, y, radius, 0, Math.PI * 2, true);
  shape.holes.push(bore);
}

export function fanHousingGeometry(flange = false) {
  const { size, openingRadius } = G.fan;
  const half = size[0] / 2 - (flange ? .0004 : .0016);
  const depth = flange ? .0022 : size[2] - .003;
  const bevel = .00035;
  const frame = roundedSquare(half, .007);
  roundHole(frame, 0, 0, openingRadius + (flange ? .00105 : .00035));
  for (const x of [-.036, .036]) for (const y of [-.036, .036]) roundHole(frame, x, y, .00225);
  const geometry = new THREE.ExtrudeGeometry(frame, {
    depth: depth - 2 * bevel, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 28,
  });
  return geometry.translate(0, 0, -depth / 2 + bevel);
}

export function socketHeadGeometry() {
  const { socketRadius, socketBottomY, headTopY } = D.clamp;
  const bevel = .00014;
  const ring = new THREE.Shape();
  ring.absarc(0, 0, .004 - bevel, 0, Math.PI * 2);
  const socket = new THREE.Path();
  for (let i = 0; i < 6; i++) {
    const angle = -i * Math.PI / 3;
    const radius = socketRadius + bevel;
    socket[i === 0 ? 'moveTo' : 'lineTo'](radius * Math.cos(angle), radius * Math.sin(angle));
  }
  socket.closePath();
  ring.holes.push(socket);
  const depth = headTopY - socketBottomY;
  const geometry = new THREE.ExtrudeGeometry(ring, {
    depth: depth - 2 * bevel, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, curveSegments: 18,
  });
  geometry.translate(0, 0, -depth / 2 + bevel);
  return geometry.rotateX(-Math.PI / 2);
}

export function clampThreadGeometry() {
  const turns = 8, length = .009, radius = G.clamp.radius;
  const points = Array.from({ length: 97 }, (_, i) => {
    const t = i / 96, angle = t * turns * Math.PI * 2;
    return new THREE.Vector3(radius * Math.cos(angle), t * length, radius * Math.sin(angle));
  });
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 96, .000095, 5, false);
}
