import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENTS, DEFAULT_VIEW, GEOMETRY as G, assemblyOffsets, clampPositions, finCenters, temperatureColor } from '../src/geometry.js';

const near = (a, b, epsilon = 1e-12) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const bottom = part => part.center[1] - part.size[1] / 2;
const top = part => part.center[1] + part.size[1] / 2;

test('sixteen original part identities and five observation fields remain immutable', () => {
  assert.deepEqual(COMPONENTS.map(p => p.id), ['bench-base', 'insulator', 'heater-block', 'heater-leads', 'contact-pad', 'heat-sink', 'cartridge-handle', 'clamp-screws', 'fan-frame', 'fan-rotor', 'fan-guard', 'probe-heater', 'probe-sink', 'probe-cables', 'power-unit', 'power-dial']);
  assert.deepEqual(DEFAULT_VIEW, { temperature: true, flows: true, exploded: false, labels: true, selectedPart: 'heat-sink' });
  assert.ok(COMPONENTS.every(p => p.name && p.description && p.material && Object.isFrozen(p))); assert.ok(Object.isFrozen(G.heater.center));
});

test('heater, pad and module are in physical contact above the supported insulator', () => {
  near(bottom(G.insulator), G.bench.topY); near(top(G.insulator), bottom(G.heater)); near(top(G.heater), bottom(G.pad)); near(top(G.pad), bottom(G.sink));
  assert.ok(G.pad.size[0] <= G.heater.size[0] && G.pad.size[2] <= G.heater.size[2]);
  assert.ok(G.pad.size[0] < G.sink.size[0] && G.pad.size[2] < G.sink.size[2]);
});

test('parallel fins meet the base, leave air channels and clear four actual clamp holes', () => {
  const fins = finCenters(), bolts = clampPositions(); assert.equal(fins.length, 9); assert.equal(bolts.length, 4);
  near(G.fins.bottomY, top(G.sink)); assert.ok(G.fins.pitch > G.fins.thickness);
  for (const center of fins) {
    near(center[1] - G.fins.height / 2, top(G.sink));
    assert.ok(Math.abs(center[0] - G.sink.center[0]) + G.fins.thickness / 2 < G.sink.size[0] / 2);
    for (const [x] of bolts) assert.ok(Math.abs(center[0] - x) > G.fins.thickness / 2 + .005, 'fin must clear clamp washer, not merely shaft');
  }
  for (const [x, , z] of bolts) {
    assert.ok(Math.abs(x - G.sink.center[0]) > G.heater.size[0] / 2 + G.clamp.radius);
    assert.ok(Math.abs(x - G.sink.center[0]) + .005 < G.sink.size[0] / 2); assert.ok(Math.abs(z) + .005 < G.sink.size[2] / 2);
    assert.ok(G.sink.holeRadius > G.clamp.radius); assert.ok(G.clamp.bottomY <= bottom(G.sink) && G.clamp.topY > top(G.sink));
  }
});

test('two probe tips enter their own bodies and insulated outlets are outside the front faces', () => {
  for (const [probe, body] of [[G.probeHeater, G.heater], [G.probeSink, G.sink]]) {
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(probe.tip[i] - body.center[i]) + probe.radius < body.size[i] / 2);
    assert.ok(probe.outlet[2] > body.center[2] + body.size[2] / 2 + .015);
    assert.equal(probe.tip[0], probe.outlet[0]); assert.equal(probe.tip[1], probe.outlet[1]);
  }
});

test('fan opening clears blades and guard, while its axial path covers the fin height', () => {
  assert.ok(G.fan.rotorRadius + .002 < G.fan.openingRadius);
  assert.ok(G.fan.openingRadius < G.fan.size[0] / 2);
  assert.ok(.014 - G.fan.guardRadius > .006, 'fixed guard clears rotor thickness');
  assert.ok(G.fan.center[1] - G.fan.openingRadius < G.fins.bottomY + .005);
  assert.ok(G.fan.center[1] + G.fan.openingRadius > G.fins.bottomY + G.fins.height);
  assert.ok(G.fan.center[2] + G.fan.size[2] / 2 < -G.sink.size[2] / 2 - .02);
});

test('inspection offsets separate contact surfaces without changing their SI geometry', () => {
  const together = assemblyOffsets(), apart = assemblyOffsets(true);
  assert.ok(Object.values(together).flat().every(value => value === 0));
  assert.ok(bottom(G.heater) + apart.heater[1] > top(G.insulator));
  assert.ok(bottom(G.pad) + apart.pad[1] > top(G.heater) + apart.heater[1]);
  assert.ok(bottom(G.sink) + apart.sink[1] > top(G.pad) + apart.pad[1]);
  assert.throws(() => assemblyOffsets('true'), TypeError);
});

test('temperature palette uses one fixed finite Celsius scale rather than automatic contrast', () => {
  assert.equal(temperatureColor(25), '#69c8e8'); assert.equal(temperatureColor(65), '#f5d675'); assert.equal(temperatureColor(110), '#f06b43');
  assert.equal(temperatureColor(-20), temperatureColor(25)); assert.equal(temperatureColor(1000), temperatureColor(110));
  assert.equal(temperatureColor(45), '#afcfaf');
  for (const bad of [NaN, Infinity, '25', undefined]) assert.throws(() => temperatureColor(bad), TypeError);
});
