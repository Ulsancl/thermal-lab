import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DEFAULT_CONFIG } from '../src/model.js';
import { MAX_TIME_S, MAX_EVENTS, createExperiment, assertExperiment, ThermalRun } from '../src/experiment.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b} (±${tolerance})`);
const fins = { ...DEFAULT_CONFIG, module: 'fins', powerW: 8 };
const fixture = { config: fins, elapsedS: 300.75, events: [{ timeS: 120.5, powerW: 12, fan: true }] };

test('new run starts at ambient with separate initial and current config', () => {
  assert.equal(MAX_TIME_S, 7200); assert.equal(MAX_EVENTS, 256);
  const run = new ThermalRun(), snapshot = run.getSnapshot();
  assert.deepEqual(run.exportExperiment(), { config: DEFAULT_CONFIG, elapsedS: 0, events: [] });
  assert.deepEqual(run.getSamples(), [{ timeS: 0, heaterC: 25, sinkC: 25 }]);
  for (const key of ['storedEnergyJ', 'inputEnergyJ', 'releasedEnergyJ', 'contactHeatW', 'airHeatW']) assert.equal(snapshot[key], 0);
  assert.equal(snapshot.heaterRateKPerS, .6); assert.equal(snapshot.sinkRateKPerS, 0); assert.equal(snapshot.atLimit, false);
});
test('integer samples persist while the fractional current endpoint is replaceable', () => {
  const run = new ThermalRun(createExperiment(fins)); run.advance(2.25);
  assert.deepEqual(run.getSamples().map(x => x.timeS), [0, 1, 2, 2.25]);
  run.advance(.5); assert.deepEqual(run.getSamples().map(x => x.timeS), [0, 1, 2, 2.75]);
  const before = run.getSnapshot(); run.changeControl({ fan: true, powerW: 12 }); const after = run.getSnapshot();
  assert.equal(after.heaterC, before.heaterC); assert.equal(after.sinkC, before.sinkC); assert.equal(after.inputEnergyJ, before.inputEnergyJ);
  assert.ok(after.airHeatW > before.airHeatW); run.advance(.5);
  assert.deepEqual(run.getSamples().map(x => x.timeS), [0, 1, 2, 2.75, 3, 3.25]);
});
test('live control history and replay recover exactly the same state and samples', () => {
  const run = new ThermalRun(createExperiment(fins)); run.advance(120.5); run.changeControl({ powerW: 12, fan: true }); run.advance(180.25);
  assert.deepEqual(run.exportExperiment(), fixture);
  const replay = new ThermalRun(fixture); assert.deepEqual(replay.getSnapshot(), run.getSnapshot()); assert.deepEqual(replay.getSamples(), run.getSamples());
  near(run.getSnapshot().inputEnergyJ, 8 * 120.5 + 12 * 180.25);
  assert.equal(run.exportExperiment().config.fan, false); assert.equal(run.getSnapshot().config.fan, true);
});
test('same-time controls coalesce, unchanged controls do nothing, and imported redundant records survive', () => {
  const run = new ThermalRun(createExperiment(fins)); run.changeControl({ powerW: 4 }); run.changeControl({ fan: true }); run.changeControl({ powerW: 4 });
  assert.deepEqual(run.exportExperiment().events, [{ timeS: 0, powerW: 4, fan: true }]);
  const experiment = { config: fins, elapsedS: 4, events: [{ timeS: 0, powerW: 8, fan: false }, { timeS: 2.25, powerW: 8, fan: false }] };
  assert.deepEqual(new ThermalRun(experiment).exportExperiment(), experiment);
  assert.deepEqual(new ThermalRun(experiment).getSamples().map(x => x.timeS), [0, 1, 2, 2.25, 3, 4]);
});
test('30, 60, 144, 240 Hz and irregular advances have the same model-time samples', () => {
  const reference = new ThermalRun(createExperiment(fins)); reference.advance(10.125);
  for (const hz of [30, 60, 144, 240]) {
    const run = new ThermalRun(createExperiment(fins)); for (let i = 0; i < 10 * hz; i++) run.advance(1 / hz); run.advance(.125);
    assert.deepEqual(run.getSnapshot(), reference.getSnapshot()); assert.deepEqual(run.getSamples(), reference.getSamples());
  }
  const irregular = new ThermalRun(createExperiment(fins)); for (const dt of [.001, .349, 2.375, .4, 7]) irregular.advance(dt);
  near(irregular.getSnapshot().timeS, 10.125); assert.deepEqual(irregular.getSamples(), reference.getSamples());
});
test('event-segment samples are independent of render schedule and exact event times remain', () => {
  const direct = new ThermalRun(createExperiment(fins)); direct.advance(10); direct.changeControl({ powerW: 12, fan: true }); direct.advance(20.5);
  for (const hz of [60, 144]) {
    const run = new ThermalRun(createExperiment(fins)); for (let i = 0; i < 10 * hz; i++) run.advance(1 / hz);
    run.changeControl({ powerW: 12, fan: true }); for (let i = 0; i < 20 * hz; i++) run.advance(1 / hz); run.advance(.5);
    assert.deepEqual(run.exportExperiment(), direct.exportExperiment()); assert.deepEqual(run.getSamples(), direct.getSamples());
  }
});
test('strict experiment import rejects malformed, out-of-order and unsupported controls without repair', () => {
  const valid = createExperiment(), unchanged = structuredClone(valid); assert.equal(assertExperiment(valid), valid);
  const invalid = [{ ...valid, extra: 1 }, { ...valid, elapsedS: NaN }, { ...valid, elapsedS: '10' }, { ...valid, events: {} },
    { ...valid, elapsedS: -1 }, { ...valid, elapsedS: 7201 }, { ...valid, events: [{ timeS: 1, powerW: 12, fan: false }] },
    { ...valid, events: [{ timeS: 0, powerW: 12, fan: true }] }, { ...valid, events: [{ timeS: 0, powerW: 6, fan: false }] },
    { ...valid, elapsedS: 3, events: [{ timeS: 2, powerW: 4, fan: false }, { timeS: 2, powerW: 8, fan: false }] },
    { ...valid, elapsedS: 3, events: [{ timeS: 2, powerW: 4, fan: false }, { timeS: 1, powerW: 8, fan: false }] },
    { ...valid, events: [{ timeS: 0, powerW: 12, fan: false, temperatures: {} }] }];
  for (const value of invalid) assert.throws(() => assertExperiment(value)); assert.deepEqual(valid, unchanged);
});
test('event cap fails atomically while coalescing at the final timestamp remains available', () => {
  const run = new ThermalRun();
  for (let i = 0; i < MAX_EVENTS; i++) { run.advance(1); run.changeControl({ powerW: i % 2 ? 12 : 4 }); }
  const before = run.exportExperiment(); assert.equal(before.events.length, 256);
  run.changeControl({ powerW: 8 }); assert.equal(run.exportExperiment().events.length, 256); run.advance(1);
  const snapshot = run.getSnapshot(), samples = run.getSamples(), original = run.exportExperiment();
  assert.throws(() => run.changeControl({ powerW: 0 }), RangeError);
  assert.deepEqual(run.exportExperiment(), original); assert.deepEqual(run.getSnapshot(), snapshot); assert.deepEqual(run.getSamples(), samples);
  assert.throws(() => assertExperiment({ ...original, events: [...original.events, { timeS: 257, powerW: 0, fan: false }] }), RangeError);
});
test('time limit is explicit, retains endpoint, and accepts controls without inventing extra time', () => {
  const run = new ThermalRun(createExperiment(fins)); const atLimit = run.advance(10000);
  assert.equal(atLimit.timeS, 7200); assert.equal(atLimit.atLimit, true); assert.equal(run.getSamples().length, 7201);
  const changed = run.changeControl({ powerW: 0, fan: true }); assert.equal(changed.heaterC, atLimit.heaterC); assert.equal(changed.sinkC, atLimit.sinkC);
  assert.deepEqual(run.advance(30), changed); assert.equal(run.exportExperiment().events[0].timeS, 7200);
  assert.deepEqual(new ThermalRun(run.exportExperiment()).getSnapshot(), changed);
});
test('returned observations are detached and rejected live actions preserve the experiment', () => {
  const run = new ThermalRun(fixture), before = run.exportExperiment();
  const snapshot = run.getSnapshot(), samples = run.getSamples(), exported = run.exportExperiment();
  snapshot.config.powerW = 0; snapshot.parameters.ambientC = 999; samples[0].heaterC = 999; exported.events[0].powerW = 0;
  assert.deepEqual(run.exportExperiment(), before); assert.equal(run.getSamples()[0].heaterC, 25);
  for (const dt of [-1, Infinity, NaN, '1']) assert.throws(() => run.advance(dt));
  for (const patch of [{ module: 'plate' }, { contact: 'poor' }, { powerW: 10 }, { fan: 1 }]) assert.throws(() => run.changeControl(patch));
  assert.deepEqual(run.exportExperiment(), before); assert.throws(() => new ThermalRun().changeControl({ fan: true }), RangeError);
});
test('power-off released energy agrees with independent integration of sampled air heat', () => {
  const run = new ThermalRun(); run.advance(120); run.changeControl({ powerW: 0 }); const before = run.getSnapshot(); run.advance(120); const after = run.getSnapshot();
  assert.equal(after.inputEnergyJ, before.inputEnergyJ); assert.ok(after.storedEnergyJ < before.storedEnergyJ);
  // Independent Simpson integration of the observed sink trajectory across shutdown.
  const samples = run.getSamples(), area = (start, end) => {
    let sum = 0; for (let i = start; i <= end; i++) sum += (i === start || i === end ? 1 : i % 2 ? 4 : 2) * .2 * (samples[i].sinkC - 25);
    return sum / 3;
  };
  near(after.releasedEnergyJ, area(0, 120) + area(120, 240), .00003);
});
test('maximum timeline replay benchmark rebuilds integer and event samples without truncation', t => {
  const events = Array.from({ length: 256 }, (_, i) => ({ timeS: i * 27 + .25, powerW: i % 2 ? 12 : 4, fan: i % 3 === 0 }));
  const experiment = { config: fins, elapsedS: 7200, events }, start = performance.now(), run = new ThermalRun(experiment), elapsedMs = performance.now() - start;
  assert.deepEqual(run.exportExperiment(), experiment); assert.equal(run.getSamples().length, 7201 + 256);
  assert.ok(run.getSamples().every((sample, i, all) => Number.isFinite(sample.heaterC) && Number.isFinite(sample.sinkC) && (!i || sample.timeS > all[i - 1].timeS)));
  t.diagnostic(`7200-second / 256-event replay: ${elapsedMs.toFixed(3)} ms; this observation is not a cross-machine guarantee.`);
});
