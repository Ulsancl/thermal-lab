import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GEOMETRY as G, DETAIL_GEOMETRY as D, probeBoreSpec } from '../src/geometry.js';
import { boredBlockGeometry, annularGeometry, fanBladeGeometry } from '../src/geometry-meshes.js';

const near = (a, b, tolerance = 2e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function triangles(geometry) {
  const p = geometry.getAttribute('position'), index = geometry.index, count = index?.count ?? p.count, result = [];
  for (let i = 0; i < count; i += 3) result.push([0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(p, index ? index.getX(i + j) : i + j)));
  return result;
}
function volume(geometry) { return triangles(geometry).reduce((v, [a, b, c]) => v + a.dot(new THREE.Vector3().crossVectors(b, c)) / 6, 0); }
function ray(geometry, start, direction) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.updateMatrixWorld();
  const hits = new THREE.Raycaster(new THREE.Vector3(...start), new THREE.Vector3(...direction)).intersectObject(mesh); mesh.material.dispose(); return hits;
}
function closedBoundary(geometry) {
  const key = p => p.toArray().map(v => Math.round(v / 1e-8)).join(','), edges = new Map();
  for (const tri of triangles(geometry)) for (let i = 0; i < 3; i++) {
    const a = key(tri[i]), b = key(tri[(i + 1) % 3]); if (a === b) continue;
    const edge = [a, b].sort().join('|'); edges.set(edge, (edges.get(edge) ?? 0) + (a < b ? 1 : -1));
  }
  assert.equal([...edges].filter(([, balance]) => balance !== 0).length, 0, 'surface edges must close with opposite winding');
}

for (const kind of ['heater', 'sink']) for (const section of [false, true]) test(`${kind} ${section ? 'capped half-section' : 'full body'} removes actual blind-bore and bolt-hole volume`, () => {
  const g = boredBlockGeometry(kind, section), b = probeBoreSpec(kind), body = G[kind], height = section ? b.center[1] - body.center[1] + body.size[1] / 2 : body.size[1];
  const boreVolume = Math.PI * b.radius ** 2 * (b.frontZ - b.bottomZ) * (section ? .5 : 1);
  const boltVolume = kind === 'sink' ? 4 * Math.PI * G.sink.holeRadius ** 2 * height : 0;
  const expected = body.size[0] * height * body.size[2] - boreVolume - boltVolume;
  near(volume(g), expected, expected * 8e-5); closedBoundary(g);
  const normal = g.getAttribute('normal');
  for (let i = 0; i < normal.count; i++) near(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)), 1, 2e-6);
  for (const [a, c, d] of triangles(g)) assert.ok(new THREE.Vector3().subVectors(c, a).cross(new THREE.Vector3().subVectors(d, a)).length() > 1e-14, 'no zero-area triangles');
  g.dispose();
});

test('rays enter each drilled hole and meet the closed bottom, with side wall and exact original contact faces', () => {
  for (const kind of ['heater', 'sink']) {
    const g = boredBlockGeometry(kind), b = probeBoreSpec(kind), body = G[kind], bx = b.center[0] - body.center[0], by = b.center[1] - body.center[1];
    const startZ = body.size[2] / 2 + .005, bottomZ = b.bottomZ - body.center[2];
    near(ray(g, [bx, by, startZ], [0, 0, -1])[0].point.z, bottomZ);
    near(ray(g, [bx, by, bottomZ + .001], [1, 0, 0])[0].point.x, bx + b.radius);
    near(g.boundingBox.min.y, -body.size[1] / 2); near(g.boundingBox.max.y, body.size[1] / 2);
    if (kind === 'sink') for (const x of [-G.sink.boltX, G.sink.boltX]) for (const z of [-G.sink.boltZ, G.sink.boltZ]) assert.equal(ray(g, [x, .01, z], [0, -1, 0]).length, 0, 'clamp bore stays open through the full base');
    assert.ok(b.radialClearance > 0); near(b.bottomClearance, .0005); g.dispose();
  }
});

test('the explicitly withdrawn inspection probe clears the complete blind bore without changing assembled fit', () => {
  for (const kind of ['heater', 'sink']) {
    const b = probeBoreSpec(kind), probe = kind === 'heater' ? G.probeHeater : G.probeSink;
    near(probe.tip[2] - b.bottomZ, .0005);
    assert.ok(probe.tip[2] + D.probeInspectionWithdrawalM > b.frontZ + .001, 'inspection tip must reveal the entire bore, not remain partly inserted');
    near(D.probeInspectionWithdrawalM, .012);
  }
});

test('handle attachment faces fit the base and both its bent stems and grip clear the inserted probe', () => {
  const h = D.handle, probe = G.probeSink;
  near(h.y, G.sink.center[1]); assert.ok(h.flangeRadius < G.sink.size[1] / 2);
  for (const x of h.stemX) {
    assert.ok(Math.abs(x - G.sink.center[0]) + h.flangeRadius < G.sink.size[0] / 2);
    assert.ok(Math.abs(x - probe.tip[0]) - h.stemRadius - probe.radius > .004);
    const curve = new THREE.CatmullRomCurve3([[x, h.y, .039], [x, h.y, .050], [x, .065, .058], [x, h.gripY, h.gripZ]].map(p => new THREE.Vector3(...p)));
    for (const point of curve.getPoints(512)) assert.ok(Math.hypot(point.x - probe.tip[0], point.y - probe.tip[1]) > h.stemRadius + probe.radius);
  }
  assert.ok(h.gripY - probe.tip[1] - h.gripRadius - probe.radius > .006);
});

test('washer and compression gland have actual through bores; shaft ends below the recessed screw socket', () => {
  for (const [outer, inner, length] of [[D.washer.outerRadius, D.washer.innerRadius, D.washer.height], [D.glandOuterRadius, G.probeSink.radius + .00005, D.glandLength]]) {
    const g = annularGeometry(outer, inner, length); assert.equal(ray(g, [0, length, 0], [0, -1, 0]).length, 0); assert.ok(volume(g) > 0); closedBoundary(g); g.dispose();
  }
  assert.ok(D.washer.innerRadius > G.clamp.radius); near(D.washer.centerY - D.washer.height / 2, G.sink.center[1] + G.sink.size[1] / 2);
  near(D.washer.centerY + D.washer.height / 2, D.clamp.headBottomY); assert.ok(D.clamp.shaftTopY < D.clamp.socketBottomY); assert.ok(D.clamp.socketBottomY < D.clamp.headTopY);
});

test('twisted fan blade is closed with real axial pitch and clears frame, rear carrier and both guards throughout rotation', () => {
  const g = fanBladeGeometry(), p = g.getAttribute('position'); closedBoundary(g); assert.ok(volume(g) > 0);
  let radialMax = 0, axialMax = 0;
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 24) for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) * Math.cos(angle) - p.getY(i) * Math.sin(angle), y = p.getX(i) * Math.sin(angle) + p.getY(i) * Math.cos(angle);
    radialMax = Math.max(radialMax, Math.hypot(x, y)); axialMax = Math.max(axialMax, Math.abs(p.getZ(i)));
  }
  assert.ok(G.fan.openingRadius - radialMax > .003); assert.ok(.014 - G.fan.guardRadius - axialMax > .007); assert.ok(.009 - axialMax > .004);
  const nc = D.blade.chordSegments, nr = D.blade.radialSegments;
  assert.ok(Math.abs(p.getZ(nc) - p.getZ(0)) > .003); assert.ok(Math.abs(p.getZ(nr * (nc + 1) + nc) - p.getZ(nr * (nc + 1))) > .002);
  g.dispose();
});
