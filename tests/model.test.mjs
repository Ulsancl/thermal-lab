import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_VERSION, DEFAULT_CONFIG, normalizeConfig, assertConfig, parametersFor, steadyState, temperatureRates, advanceTemperatures } from '../src/model.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b} (±${tolerance})`);
const p = { ambientC: 20, heaterCapacityJPerK: 10, sinkCapacityJPerK: 10, contactResistanceKPerW: 1, airConductanceWPerK: 1 };
const temperatures = { heaterC: 20, sinkC: 20 };
const energy = (t, params) => params.heaterCapacityJPerK * (t.heaterC - params.ambientC) + params.sinkCapacityJPerK * (t.sinkC - params.ambientC);
function rk4(initial, params, power, duration) {
  // Independent integration of both ODEs and actual air heat, not input-E.
  let state = [initial.heaterC, initial.sinkC, 0];
  const count = Math.ceil(duration / .025), dt = duration / count;
  const slope = ([h, s]) => {
    const contact = (h - s) / params.contactResistanceKPerW, air = params.airConductanceWPerK * (s - params.ambientC);
    return [(power - contact) / params.heaterCapacityJPerK, (contact - air) / params.sinkCapacityJPerK, air];
  };
  for (let n = 0; n < count; n++) {
    const a = slope(state), b = slope(state.map((v, i) => v + dt * a[i] / 2));
    const c = slope(state.map((v, i) => v + dt * b[i] / 2)), d = slope(state.map((v, i) => v + dt * c[i]));
    state = state.map((v, i) => v + dt / 6 * (a[i] + 2 * b[i] + 2 * c[i] + d[i]));
  }
  return { heaterC: state[0], sinkC: state[1], releasedJ: state[2] };
}

test('educational coefficients and four steady reference cases are explicit', () => {
  assert.equal(MODEL_VERSION, 'thermal-two-node-1'); assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  assert.deepEqual(parametersFor(DEFAULT_CONFIG), { ambientC: 25, heaterCapacityJPerK: 20, sinkCapacityJPerK: 60, contactResistanceKPerW: .5, airConductanceWPerK: .2 });
  for (const [patch, heaterC, sinkC] of [[{}, 91, 85], [{ module: 'fins' }, 55, 49], [{ module: 'fins', fan: true }, 43, 37], [{ module: 'fins', fan: true, contact: 'poor' }, 61, 37]]) {
    assert.deepEqual(steadyState({ ...DEFAULT_CONFIG, ...patch }), { heaterC, sinkC });
  }
});
test('live config normalization is separate from strict file validation', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({ module: 'plate', fan: true, contact: 'poor', powerW: 6 }), { module: 'plate', fan: false, contact: 'poor', powerW: 4 });
  assert.deepEqual(normalizeConfig({ module: 'fins', fan: true, powerW: 999 }), { module: 'fins', contact: 'good', fan: true, powerW: 12 });
  for (const value of [{ ...DEFAULT_CONFIG, extra: 1 }, { ...DEFAULT_CONFIG, fan: 1 }, { ...DEFAULT_CONFIG, powerW: '12' }, { ...DEFAULT_CONFIG, module: 'metal' }, { ...DEFAULT_CONFIG, powerW: NaN }]) assert.throws(() => assertConfig(value), TypeError);
  for (const value of [{ ...DEFAULT_CONFIG, fan: true }, { ...DEFAULT_CONFIG, powerW: 6 }, { ...DEFAULT_CONFIG, powerW: -4 }]) assert.throws(() => assertConfig(value), RangeError);
  assert.equal(assertConfig(DEFAULT_CONFIG), DEFAULT_CONFIG);
});
test('independent equal-capacity analytic reference values agree at ten and sixty seconds', () => {
  for (const [seconds, h, s] of [[10, 26.99317739, 22.13354401], [60, 38.08502297, 28.81647946]]) {
    const result = advanceTemperatures(temperatures, p, 10, seconds); near(result.heaterC, h, 1e-8); near(result.sinkC, s, 1e-8);
  }
});
test('zero duration is an independent exact copy and equilibrium is fixed', () => {
  const original = { heaterC: 40, sinkC: 30 }, result = advanceTemperatures(original, p, 10, 0);
  assert.deepEqual(result, original); assert.notEqual(result, original);
  for (const seconds of [1e-10, 1, 100, 1e9]) {
    const next = advanceTemperatures(original, p, 10, seconds); near(next.heaterC, 40, 2e-13); near(next.sinkC, 30, 2e-13);
  }
});
test('power-off sink warming coexists with falling total stored energy', () => {
  const initial = { heaterC: 80, sinkC: 40 }, rates = temperatureRates(initial, p, 0);
  assert.deepEqual(rates, { contactHeatW: 40, airHeatW: 20, heaterRateKPerS: -4, sinkRateKPerS: 2 });
  const next = advanceTemperatures(initial, p, 0, .25);
  assert.ok(next.heaterC < initial.heaterC && next.sinkC > initial.sinkC);
  assert.ok(energy(next, p) < energy(initial, p));
});
test('zero-input passivity obeys the ambient-and-initial maximum principle', () => {
  for (const initial of [{ heaterC: 80, sinkC: 40 }, { heaterC: -10, sinkC: 5 }, { heaterC: 0, sinkC: 100 }]) {
    const low = Math.min(20, initial.heaterC, initial.sinkC), high = Math.max(20, initial.heaterC, initial.sinkC);
    for (const seconds of [1e-9, .01, 1, 10, 1000]) for (const value of Object.values(advanceTemperatures(initial, p, 0, seconds))) assert.ok(value >= low - 1e-12 && value <= high + 1e-12);
  }
});
test('ambient-start heating rises monotonically and stays below steady temperatures', () => {
  for (const config of [DEFAULT_CONFIG, { ...DEFAULT_CONFIG, module: 'fins', fan: true, contact: 'poor' }]) {
    const params = parametersFor(config), steady = steadyState(config); let previous = { heaterC: 25, sinkC: 25 };
    for (const seconds of [1e-8, .1, 1, 10, 120, 1800, 7200]) {
      const next = advanceTemperatures({ heaterC: 25, sinkC: 25 }, params, 12, seconds);
      for (const key of ['heaterC', 'sinkC']) assert.ok(next[key] >= previous[key] - 1e-12 && next[key] <= steady[key] + 1e-12);
      previous = next;
    }
  }
});
test('exact evolution has the semigroup property across fast and long intervals', () => {
  const initial = { heaterC: 68, sinkC: 11 };
  for (const [a, b] of [[1e-8, 2e-8], [.01, .02], [3.1, 97.4], [120, 3600]]) {
    const whole = advanceTemperatures(initial, p, 8, a + b), parts = advanceTemperatures(advanceTemperatures(initial, p, 8, a), p, 8, b);
    near(parts.heaterC, whole.heaterC, 1e-11); near(parts.sinkC, whole.sinkC, 1e-11);
  }
});
test('short-time derivatives and second-order sink response do not cancel away', () => {
  const seconds = 1e-4, next = advanceTemperatures(temperatures, p, 10, seconds);
  near((next.heaterC - 20) / seconds, 1, 1e-5);
  near(next.sinkC - 20, .05 * seconds ** 2, 6e-15);
  const long = advanceTemperatures(temperatures, p, 10, 1e9);
  near(long.heaterC, 40, 1e-12); near(long.sinkC, 30, 1e-12);
});
test('independent RK4 air-heat quadrature verifies temperatures and energy balance', () => {
  const cases = [[p, { heaterC: 80, sinkC: 40 }, 0, 60], [p, temperatures, 10, 60],
    [{ ambientC: 20, heaterCapacityJPerK: 3, sinkCapacityJPerK: 47, contactResistanceKPerW: 2.8, airConductanceWPerK: .07 }, { heaterC: 30, sinkC: 15 }, 5, 250]];
  for (const [params, initial, power, duration] of cases) {
    const oracle = rk4(initial, params, power, duration), actual = advanceTemperatures(initial, params, power, duration);
    near(actual.heaterC, oracle.heaterC, 3e-9); near(actual.sinkC, oracle.sinkC, 3e-9);
    near(energy(actual, params) - energy(initial, params) + oracle.releasedJ, power * duration, 2e-7);
  }
});
test('nearly coincident decay rates approach the independently decoupled limit', () => {
  const params = { ambientC: 20, heaterCapacityJPerK: 1, sinkCapacityJPerK: 1e16, contactResistanceKPerW: 1, airConductanceWPerK: 1e16 };
  const actual = advanceTemperatures({ heaterC: 30, sinkC: 20 }, params, 0, 2);
  near(actual.heaterC, 20 + 10 * Math.exp(-2), 1e-12); near(actual.sinkC, 20, 1e-12);
});
test('invalid numerical domains reject without mutating input', () => {
  const original = Object.freeze({ ...temperatures }), params = Object.freeze({ ...p });
  advanceTemperatures(original, params, 10, 10); assert.deepEqual(original, temperatures); assert.deepEqual(params, p);
  for (const seconds of [NaN, Infinity, '1']) assert.throws(() => advanceTemperatures(original, params, 10, seconds), TypeError);
  assert.throws(() => advanceTemperatures(original, params, 10, -1), RangeError);
  assert.throws(() => advanceTemperatures(original, params, -1, 1), RangeError);
  for (const key of ['heaterCapacityJPerK', 'sinkCapacityJPerK', 'contactResistanceKPerW', 'airConductanceWPerK']) assert.throws(() => advanceTemperatures(original, { ...params, [key]: 0 }, 10, 1), RangeError);
  assert.throws(() => advanceTemperatures({ ...original, extra: 1 }, params, 10, 1), TypeError);
  assert.throws(() => advanceTemperatures(original, { ...params, ambientC: Infinity }, 10, 1), TypeError);
});
