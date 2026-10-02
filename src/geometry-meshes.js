import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { GEOMETRY, DETAIL_GEOMETRY, probeBoreSpec } from './geometry.js';

const rectShape = (left, bottom, right, top) => {
  const s = new THREE.Shape(); s.moveTo(left, bottom); s.lineTo(right, bottom); s.lineTo(right, top); s.lineTo(left, top); s.closePath(); return s;
};
const circleHole = (shape, x, y, radius) => { const hole = new THREE.Path(); hole.absarc(x, y, radius, 0, Math.PI * 2, true); shape.holes.push(hole); };

// Boundary surfaces of a blind-drilled block. Holes do not intersect each other.
// The optional half-section is capped geometry, rather than an uncapped shader clip.
export function boredBlockGeometry(kind, section = false) {
  const body = GEOMETRY[kind], b = probeBoreSpec(kind), [sx, sy, sz] = body.size;
  const x0 = -sx / 2, x1 = sx / 2, y0 = -sy / 2, y1 = section ? b.center[1] - body.center[1] : sy / 2, z0 = -sz / 2, z1 = sz / 2;
  const bx = b.center[0] - body.center[0], by = b.center[1] - body.center[1], bz = b.bottomZ - body.center[2], r = b.radius, pieces = [];
  const face = (shape, transform) => { const g = new THREE.ShapeGeometry(shape, 32).toNonIndexed(); transform(g); pieces.push(g); };
  let front;
  if (section) {
    front = new THREE.Shape(); front.moveTo(x0, y0); front.lineTo(x1, y0); front.lineTo(x1, y1); front.lineTo(bx + r, y1);
    front.absarc(bx, by, r, 0, -Math.PI, true); front.lineTo(x0, y1); front.closePath();
  } else { front = rectShape(x0, y0, x1, y1); circleHole(front, bx, by, r); }
  face(front, g => g.translate(0, 0, z1));
  face(rectShape(x0, y0, x1, y1), g => { g.rotateY(Math.PI); g.translate(0, 0, z0); });
  for (const side of [-1, 1]) face(rectShape(-sz / 2, y0, sz / 2, y1), g => { g.rotateY(side * Math.PI / 2); g.translate(side * sx / 2, 0, 0); });
  for (const top of [false, true]) {
    let shape;
    if (top && section) {
      shape = new THREE.Shape(); shape.moveTo(x0, z0); shape.lineTo(x1, z0); shape.lineTo(x1, z1); shape.lineTo(bx + r, z1); shape.lineTo(bx + r, bz); shape.lineTo(bx - r, bz); shape.lineTo(bx - r, z1); shape.lineTo(x0, z1); shape.closePath();
    } else shape = rectShape(x0, z0, x1, z1);
    if (kind === 'sink') for (const x of [-GEOMETRY.sink.boltX, GEOMETRY.sink.boltX]) for (const z of [-GEOMETRY.sink.boltZ, GEOMETRY.sink.boltZ]) circleHole(shape, x, z, GEOMETRY.sink.holeRadius);
    // Shape uses (x,z); +90 degrees maps its normal to -Y.
    face(shape, g => { g.rotateX(Math.PI / 2); g.translate(0, top ? y1 : y0, 0); if (top) reverseSurface(g); });
  }
  const positions = [], normals = [], uvs = [];
  const tri = (a, c, d, ns) => {
    const cross = new THREE.Vector3().subVectors(new THREE.Vector3(...c), new THREE.Vector3(...a)).cross(new THREE.Vector3().subVectors(new THREE.Vector3(...d), new THREE.Vector3(...a)));
    if (cross.dot(new THREE.Vector3(...ns[0])) < 0) { [c, d] = [d, c]; ns = [ns[0], ns[2], ns[1]]; }
    [a, c, d].forEach((p, i) => { positions.push(...p); normals.push(...ns[i]); uvs.push(p[0], p[2]); });
  };
  const theta0 = section ? Math.PI : 0, segments = 64;
  for (let i = 0; i < segments; i++) {
    const a = theta0 + i / segments * (section ? Math.PI : Math.PI * 2), c = theta0 + (i + 1) / segments * (section ? Math.PI : Math.PI * 2);
    const point = (t, z) => [bx + r * Math.cos(t), by + r * Math.sin(t), z], normal = t => [-Math.cos(t), -Math.sin(t), 0];
    tri(point(a, bz), point(c, bz), point(c, z1), [normal(a), normal(c), normal(c)]);
    tri(point(a, bz), point(c, z1), point(a, z1), [normal(a), normal(c), normal(a)]);
    if (!section || i > 0) tri(section ? point(theta0, bz) : [bx, by, bz], point(a, bz), point(c, bz), [[0, 0, 1], [0, 0, 1], [0, 0, 1]]);
  }
  const cavity = new THREE.BufferGeometry(); cavity.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); cavity.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); cavity.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); pieces.push(cavity);
  if (kind === 'sink') for (const x of [-GEOMETRY.sink.boltX, GEOMETRY.sink.boltX]) for (const z of [-GEOMETRY.sink.boltZ, GEOMETRY.sink.boltZ]) {
    const g = new THREE.CylinderGeometry(GEOMETRY.sink.holeRadius, GEOMETRY.sink.holeRadius, y1 - y0, 64, 1, true).toNonIndexed(); reverseSurface(g); g.translate(x, (y0 + y1) / 2, z); pieces.push(g);
  }
  const joined = mergeGeometries(pieces, false); pieces.forEach(g => g.dispose());
  // Earcut may emit collinear bridge triangles when several holes share a row.
  const result = new THREE.BufferGeometry(), kept = [], p = joined.getAttribute('position'), a = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) { a.fromBufferAttribute(p, i); c.fromBufferAttribute(p, i + 1).sub(a); d.fromBufferAttribute(p, i + 2).sub(a); if (c.cross(d).length() > 1e-14) kept.push(i, i + 1, i + 2); }
  for (const [name, attr] of Object.entries(joined.attributes)) { const values = []; for (const i of kept) for (let j = 0; j < attr.itemSize; j++) values.push(attr.array[i * attr.itemSize + j]); result.setAttribute(name, new THREE.Float32BufferAttribute(values, attr.itemSize)); }
  joined.dispose(); result.computeBoundingBox(); return result;
}

function reverseSurface(g) {
  for (const attr of Object.values(g.attributes)) for (let i = 0; i < attr.count; i += 3) for (let c = 0; c < attr.itemSize; c++) {
    const a = (i + 1) * attr.itemSize + c, b = (i + 2) * attr.itemSize + c, saved = attr.array[a]; attr.array[a] = attr.array[b]; attr.array[b] = saved;
  }
  const n = g.getAttribute('normal'); for (let i = 0; i < n.array.length; i++) n.array[i] *= -1;
}

export function annularGeometry(outerRadius, innerRadius, length, segments = 48, chamfer = .00012) {
  if (!(outerRadius > innerRadius && innerRadius > 0 && length > 0)) throw new RangeError('Invalid annulus');
  const e = Math.min(chamfer, (outerRadius - innerRadius) / 4, length / 4), h = length / 2;
  const points = [[innerRadius, -h + e], [innerRadius + e, -h], [outerRadius - e, -h], [outerRadius, -h + e], [outerRadius, h - e], [outerRadius - e, h], [innerRadius + e, h], [innerRadius, h - e], [innerRadius, -h + e]];
  const g = new THREE.LatheGeometry(points.map(p => new THREE.Vector2(...p)), segments); g.computeBoundingBox(); return g;
}

// Closed, twisted molded blade. Its visual pitch is not an aerodynamic solution.
export function fanBladeGeometry() {
  const d = DETAIL_GEOMETRY.blade, positions = [], indices = [], nr = d.radialSegments, nc = d.chordSegments;
  for (const side of [-1, 1]) for (let i = 0; i <= nr; i++) for (let j = 0; j <= nc; j++) {
    const t = i / nr, r = d.rootRadius + t * (d.tipRadius - d.rootRadius), width = .007 + .009 * Math.sin(Math.PI * t * .8), q = (j / nc - .5) * width;
    const pitch = d.rootPitch + t * (d.tipPitch - d.rootPitch), sweep = -.18 * t;
    const y = q * Math.cos(pitch), z = q * Math.sin(pitch) + side * d.thickness / 2;
    positions.push(r * Math.cos(sweep) - y * Math.sin(sweep), r * Math.sin(sweep) + y * Math.cos(sweep), z);
  }
  const layer = (nr + 1) * (nc + 1), idx = (i, j, side) => side * layer + i * (nc + 1) + j;
  const quad = (a, b, c, d, flip = false) => indices.push(...(flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d]));
  for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) for (let side = 0; side < 2; side++) quad(idx(i, j, side), idx(i + 1, j, side), idx(i + 1, j + 1, side), idx(i, j + 1, side), side === 0);
  for (let i = 0; i < nr; i++) { quad(idx(i, 0, 0), idx(i + 1, 0, 0), idx(i + 1, 0, 1), idx(i, 0, 1)); quad(idx(i, nc, 1), idx(i + 1, nc, 1), idx(i + 1, nc, 0), idx(i, nc, 0)); }
  for (let j = 0; j < nc; j++) { quad(idx(0, j, 1), idx(0, j + 1, 1), idx(0, j + 1, 0), idx(0, j, 0)); quad(idx(nr, j, 0), idx(nr, j + 1, 0), idx(nr, j + 1, 1), idx(nr, j, 1)); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setIndex(indices); g.computeVertexNormals(); g.computeBoundingBox(); return g;
}
