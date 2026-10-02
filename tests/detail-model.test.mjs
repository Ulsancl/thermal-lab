import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, parametersFor, steadyState, temperatureRates, advanceTemperatures } from '../src/model.js';
import { ThermalRun, createExperiment, MAX_TIME_S } from '../src/experiment.js';
import { COMPONENTS } from '../src/geometry.js';
import { thermalDetail, describeThermalDetail } from '../src/detail-model.js';

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (±${tolerance})`);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const configurations = ['good', 'poor'].flatMap(contact => [
  { module: 'plate', contact, fan: false }, { module: 'fins', contact, fan: false }, { module: 'fins', contact, fan: true },
].flatMap(config => [0, 4, 8, 12].map(powerW => ({ ...config, powerW }))));
function runAt(config, time = 0) { const run = new ThermalRun(createExperiment(config)); run.advance(time); return run; }
function snapshotAt(config, temperatures) {
  const parameters = parametersFor(config);
  const storedEnergyJ = parameters.heaterCapacityJPerK * (temperatures.heaterC - parameters.ambientC)
    + parameters.sinkCapacityJPerK * (temperatures.sinkC - parameters.ambientC);
  return { config, parameters, timeS: 0, ...temperatures, ...temperatureRates(temperatures, parameters, config.powerW),
    storedEnergyJ, inputEnergyJ: 0, releasedEnergyJ: -storedEnergyJ, steady: steadyState(config), atLimit: false };
}

// Independent RK4 integration: no production derivative, modal or energy helpers.
function integrate(initial, config, duration) {
  const ch = 20, cs = config.module === 'plate' ? 60 : 120;
  const rc = config.contact === 'good' ? .5 : 2, ga = config.module === 'plate' ? .2 : config.fan ? 1 : .5;
  let state = [initial.heaterC, initial.sinkC, 0, 0, 0];
  const n = Math.max(1, Math.ceil(duration / .02)), dt = duration / n;
  const slope = ([h, s]) => {
    const contact = (h - s) / rc, air = ga * (s - 25);
    return [(config.powerW - contact) / ch, (contact - air) / cs, config.powerW - contact, contact - air, air];
  };
  for (let i = 0; i < n; i++) {
    const a = slope(state), b = slope(state.map((v, j) => v + dt * a[j] / 2));
    const c = slope(state.map((v, j) => v + dt * b[j] / 2)), d = slope(state.map((v, j) => v + dt * c[j]));
    state = state.map((v, j) => v + dt * (a[j] + 2 * b[j] + 2 * c[j] + d[j]) / 6);
  }
  return { heaterC: state[0], sinkC: state[1], heaterChangeJ: state[2], sinkChangeJ: state[3], airJ: state[4] };
}

test('all 24 allowed conditions expose finite node storage and the correct series thermal path', () => {
  for (const config of configurations) {
    const d = thermalDetail(runAt(config, 125.25).getSnapshot());
    const resistance = config.contact === 'good' ? .5 : 2;
    const airResistance = config.module === 'plate' ? 5 : config.fan ? 1 : 2;
    assert.equal(d.path.contactResistanceKPerW, resistance);
    assert.equal(d.path.airResistanceKPerW, airResistance);
    assert.equal(d.path.totalResistanceKPerW, resistance + airResistance);
    assert.equal(d.nodes.heater.steadyC, 25 + config.powerW * (resistance + airResistance));
    assert.equal(d.nodes.sink.steadyC, 25 + config.powerW * airResistance);
    assert.equal(d.path.steadyContactDeltaK, config.powerW * resistance);
    assert.equal(d.nodes.heater.capacityJPerK, 20);
    assert.equal(d.nodes.sink.capacityJPerK, config.module === 'plate' ? 60 : 120);
    near(d.power.balanceResidualW, 0, 4e-15);
    near(d.energy.balanceResidualJ, 0, 3e-12);
    assert.ok(d.modes.fastTauS > 0 && d.modes.slowTauS > d.modes.fastTauS);
  }
});

test('startup and exact equilibrium distinguish instantaneous heat storage from steady transfer', () => {
  const initial = thermalDetail(new ThermalRun().getSnapshot());
  assert.deepEqual([initial.power.inputW, initial.power.contactW, initial.power.airW, initial.power.heaterStorageW, initial.power.sinkStorageW], [12, 0, 0, 12, 0]);
  assert.equal(initial.nodes.heater.rateKPerS, .6);
  assert.equal(initial.nodes.heater.errorToSteadyK, 66);
  assert.equal(initial.path.contactDeltaK, 0);
  assert.equal(initial.path.steadyContactDeltaK, 6);
  const steady = thermalDetail(snapshotAt(DEFAULT_CONFIG, { heaterC: 91, sinkC: 85 }));
  assert.deepEqual([steady.power.inputW, steady.power.contactW, steady.power.airW], [12, 12, 12]);
  assert.equal(steady.power.totalStorageW, 0);
  assert.equal(steady.energy.heaterJ, 1320); assert.equal(steady.energy.sinkJ, 3600);
  assert.equal(steady.modes.heaterSlowK, 0); assert.equal(Math.abs(steady.modes.heaterFastK), 0);
});

test('independent heat-rate integration reconstructs each node energy and cumulative air release across control events', () => {
  for (const contact of ['good', 'poor']) {
    const config = { ...DEFAULT_CONFIG, module: 'fins', contact };
    const run = new ThermalRun(createExperiment(config));
    let oracle = { heaterC: 25, sinkC: 25 }, input = 0, air = 0, heater = 0, sink = 0;
    for (const [duration, powerW, fan] of [[30.125, 12, false], [60.25, 4, true], [40.5, 0, false]]) {
      run.changeControl({ powerW, fan });
      oracle = integrate(oracle, { ...config, powerW, fan }, duration);
      input += powerW * duration; air += oracle.airJ; heater += oracle.heaterChangeJ; sink += oracle.sinkChangeJ;
      const d = thermalDetail(run.advance(duration));
      near(d.nodes.heater.temperatureC, oracle.heaterC, 3e-10);
      near(d.nodes.sink.temperatureC, oracle.sinkC, 3e-10);
      near(d.energy.heaterJ, heater, 6e-9); near(d.energy.sinkJ, sink, 6e-9);
      near(d.energy.releasedJ, air, 1e-8); near(d.energy.inputJ, input, 1e-10);
      near(d.energy.storedJ + air, input, 1e-8);
    }
  }
});

test('finite temperature and stored-energy changes independently verify instantaneous node powers', () => {
  for (const config of configurations) {
    const time = 72.375, dt = .001;
    const d = thermalDetail(runAt(config, time).getSnapshot());
    const before = runAt(config, time - dt).getSnapshot(), after = runAt(config, time + dt).getSnapshot();
    near((after.heaterC - before.heaterC) / (2 * dt), d.nodes.heater.rateKPerS, 2e-10);
    near((after.sinkC - before.sinkC) / (2 * dt), d.nodes.sink.rateKPerS, 2e-10);
    near((after.storedEnergyJ - before.storedEnergyJ) / (2 * dt), d.power.totalStorageW, 3e-8);
  }
});

test('decay times match a separate closed-form quadratic and are independent of power and elapsed time', () => {
  // Default matrix has characteristic polynomial r² - (41/300)r + 1/3000.
  const fast = (41 + Math.sqrt(1561)) / 600, slow = (41 - Math.sqrt(1561)) / 600;
  for (const powerW of [0, 4, 8, 12]) for (const time of [0, 100, 7200]) {
    const m = thermalDetail(runAt({ ...DEFAULT_CONFIG, powerW }, time).getSnapshot()).modes;
    near(m.fastRatePerS, fast, 3e-17); near(m.slowRatePerS, slow, 3e-17);
    near(m.fastTauS, 1 / fast, 3e-14); near(m.slowTauS, 1 / slow, 3e-12);
  }
});

test('mode amplitudes reconstruct independent fixed-control future temperatures and can have opposite signs', () => {
  const run = runAt({ ...DEFAULT_CONFIG, module: 'fins', contact: 'poor' }, 300);
  const snapshot = run.changeControl({ powerW: 4, fan: true }), d = thermalDetail(snapshot), m = d.modes;
  for (const duration of [0, 3.5, m.fastTauS, m.slowTauS]) {
    const oracle = integrate(snapshot, snapshot.config, duration);
    const factorFast = Math.exp(-duration / m.fastTauS), factorSlow = Math.exp(-duration / m.slowTauS);
    near(d.nodes.heater.steadyC + m.heaterFastK * factorFast + m.heaterSlowK * factorSlow, oracle.heaterC, 3e-10);
    near(d.nodes.sink.steadyC + m.sinkFastK * factorFast + m.sinkSlowK * factorSlow, oracle.sinkC, 3e-10);
  }
  const startup = thermalDetail(new ThermalRun().getSnapshot());
  assert.ok(startup.modes.sinkFastK > 0 && startup.modes.sinkSlowK < 0);
  near(-startup.modes.fastRatePerS * startup.modes.sinkFastK - startup.modes.slowRatePerS * startup.modes.sinkSlowK, 0, 3e-15);
});

test('one mode time means 1/e amplitude rather than completed cooling or an endpoint time', () => {
  const config = { ...DEFAULT_CONFIG, powerW: 0 }, p = parametersFor(config);
  const slow = (41 - Math.sqrt(1561)) / 600, fast = (41 + Math.sqrt(1561)) / 600;
  for (const [name, rate] of [['slow', slow], ['fast', fast]]) {
    const ratio = 1 - rate * 10;
    const initial = { heaterC: 26, sinkC: 25 + ratio };
    const detail = thermalDetail(snapshotAt(config, initial));
    const tau = name === 'slow' ? detail.modes.slowTauS : detail.modes.fastTauS;
    const after = advanceTemperatures(initial, p, 0, tau);
    near(after.heaterC - 25, 1 / Math.E, 8e-15);
    near(after.sinkC - 25, ratio / Math.E, 8e-15);
    assert.ok(after.heaterC > 25.3);
    near(detail.modes[name === 'slow' ? 'heaterFastK' : 'heaterSlowK'], 0, 3e-14);
  }
});

test('power-off sink warming is visible alongside negative heater and total storage rates', () => {
  const run = runAt(DEFAULT_CONFIG, 120), before = thermalDetail(run.getSnapshot());
  const after = thermalDetail(run.changeControl({ powerW: 0 }));
  assert.equal(after.power.inputW, 0);
  assert.ok(after.power.heaterStorageW < 0 && after.power.sinkStorageW > 0 && after.power.totalStorageW < 0);
  assert.equal(after.energy.inputJ, before.energy.inputJ);
  assert.equal(after.energy.storedJ, before.energy.storedJ);
  assert.equal(after.nodes.heater.steadyC, 25); assert.equal(after.nodes.sink.steadyC, 25);
  near(after.power.totalStorageW, -after.power.airW, 2e-15);
});

test('signed reverse contact transfer and below-ambient storage retain their physical signs', () => {
  const d = thermalDetail(snapshotAt({ ...DEFAULT_CONFIG, powerW: 0 }, { heaterC: 20, sinkC: 30 }));
  assert.equal(d.path.contactDeltaK, -10); assert.equal(d.power.contactW, -20);
  assert.equal(d.power.airW, 1); assert.equal(d.energy.heaterJ, -100); assert.equal(d.energy.sinkJ, 300);
  assert.equal(d.nodes.heater.rateKPerS, 1); assert.equal(d.power.sinkStorageW, -21);
  const cold = thermalDetail(snapshotAt({ ...DEFAULT_CONFIG, powerW: 0 }, { heaterC: 20, sinkC: 20 }));
  assert.equal(cold.power.airW, -1); assert.equal(cold.power.sinkStorageW, 1);
  assert.equal(cold.energy.storedJ, -400);
});

test('current controls rather than initial experiment config define coefficients without resetting stored heat', () => {
  const run = runAt({ ...DEFAULT_CONFIG, module: 'fins', powerW: 4 }, 50.125);
  const before = thermalDetail(run.getSnapshot());
  const after = thermalDetail(run.changeControl({ powerW: 12, fan: true }));
  assert.equal(run.exportExperiment().config.powerW, 4); assert.equal(run.exportExperiment().config.fan, false);
  assert.equal(after.power.inputW, 12); assert.equal(after.path.airConductanceWPerK, 1);
  assert.equal(after.energy.storedJ, before.energy.storedJ); assert.equal(after.energy.inputJ, before.energy.inputJ);
  assert.equal(after.power.airW, 2 * before.power.airW);
  assert.ok(after.modes.slowTauS < before.modes.slowTauS);
});

test('recording limit does not turn the current physical slope into zero or extend the experiment', () => {
  const run = runAt(DEFAULT_CONFIG, MAX_TIME_S), snapshot = run.changeControl({ powerW: 0 });
  const before = run.exportExperiment(), d = thermalDetail(snapshot);
  assert.equal(d.atLimit, true); assert.equal(d.timeS, 7200); assert.ok(d.nodes.heater.rateKPerS < 0);
  assert.ok(d.power.totalStorageW < 0);
  assert.deepEqual(run.exportExperiment(), before);
  assert.deepEqual(run.advance(60), snapshot);
  assert.match(describeThermalDetail('heater-block', snapshot).note, /일시정지·기록 종료/);
});

test('all sixteen parts keep bounded finite facts and explicitly identify omitted physical subsystems', () => {
  for (const config of configurations) {
    const snapshot = freeze(runAt(config, 10.25).getSnapshot()), before = JSON.stringify(snapshot);
    const detail = freeze(thermalDetail(snapshot));
    for (const { id } of COMPONENTS) {
      const result = describeThermalDetail(id, snapshot, detail);
      assert.ok(result.facts.length >= 4 && result.facts.length <= 6, id);
      assert.ok(result.note.length > 20, id);
      assert.equal(new Set(result.facts.map(f => f.label)).size, result.facts.length, id);
      for (const f of result.facts) {
        assert.equal(typeof f.label, 'string'); assert.equal(typeof f.unit, 'string');
        assert.ok(typeof f.value === 'string' || Number.isFinite(f.value), `${id}: ${f.label}`);
      }
    }
    assert.equal(JSON.stringify(snapshot), before);
  }
  const snapshot = new ThermalRun().getSnapshot();
  assert.match(describeThermalDetail('fan-rotor', snapshot).note, /RPM·풍속·유량/);
  assert.match(describeThermalDetail('contact-pad', snapshot).note, /패드 자체의 온도·열용량은 없/);
  assert.match(describeThermalDetail('bench-base', snapshot).note, /도달 시간/);
  assert.throws(() => describeThermalDetail('invented-part', snapshot), RangeError);
});

test('observations are independent copies and preserve low-energy floating-point residuals rather than clipping them', () => {
  const snapshot = freeze(runAt(DEFAULT_CONFIG, 1e-10).getSnapshot()), before = JSON.stringify(snapshot);
  const detail = thermalDetail(snapshot);
  assert.equal(detail.energy.releasedJ, snapshot.releasedEnergyJ);
  near(detail.energy.balanceResidualJ, 0, 2e-23);
  detail.nodes.heater.temperatureC = 123; detail.modes.fastTauS = 999;
  assert.equal(JSON.stringify(snapshot), before);
  assert.deepEqual(thermalDetail(snapshot), thermalDetail(structuredClone(snapshot)));
});

test('malformed inputs reject without normalizing configuration or mixing snapshot coefficients', () => {
  const snapshot = new ThermalRun().getSnapshot(), before = structuredClone(snapshot);
  for (const patch of [{ heaterC: NaN }, { sinkRateKPerS: Infinity }, { atLimit: 'false' }]) assert.throws(() => thermalDetail({ ...snapshot, ...patch }), TypeError);
  for (const patch of [{ timeS: -1 }, { atLimit: true }, { inputEnergyJ: -1 },
    { parameters: { ...snapshot.parameters, airConductanceWPerK: .3 } }, { steady: { heaterC: 90, sinkC: 85 } }]) assert.throws(() => thermalDetail({ ...snapshot, ...patch }), RangeError);
  assert.throws(() => thermalDetail({ ...snapshot, config: { ...snapshot.config, powerW: 6 } }), RangeError);
  assert.throws(() => thermalDetail(null), TypeError);
  assert.deepEqual(snapshot, before);
});
