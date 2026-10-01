// Two uniform thermal nodes; SI coefficients, absolute temperatures in Celsius.
export const MODEL_VERSION = 'thermal-two-node-1';
export const DEFAULT_CONFIG = Object.freeze({ module: 'plate', contact: 'good', fan: false, powerW: 12 });
const powers = [0, 4, 8, 12];
const configKeys = ['module', 'contact', 'fan', 'powerW'];
const parameterKeys = ['ambientC', 'heaterCapacityJPerK', 'sinkCapacityJPerK', 'contactResistanceKPerW', 'airConductanceWPerK'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
function shape(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${name}: expected an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new TypeError(`${name}: missing or unknown field`);
}
export function normalizeConfig(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const module = value.module === 'fins' ? 'fins' : 'plate';
  const power = finite(value.powerW) ? Math.min(12, Math.max(0, value.powerW)) : 12;
  return { module, contact: value.contact === 'poor' ? 'poor' : 'good', fan: module === 'fins' && value.fan === true,
    powerW: powers.reduce((best, candidate) => Math.abs(candidate - power) < Math.abs(best - power) ? candidate : best) };
}
export function assertConfig(config) {
  shape(config, configKeys, 'config');
  if (!['plate', 'fins'].includes(config.module) || !['good', 'poor'].includes(config.contact) || typeof config.fan !== 'boolean' || !finite(config.powerW)) throw new TypeError('Invalid thermal configuration types');
  if (!powers.includes(config.powerW) || (config.module === 'plate' && config.fan)) throw new RangeError('Unsupported heater power or fan/module combination');
  return config;
}
export function parametersFor(config) {
  assertConfig(config);
  return { ambientC: 25, heaterCapacityJPerK: 20, sinkCapacityJPerK: config.module === 'plate' ? 60 : 120,
    contactResistanceKPerW: config.contact === 'good' ? .5 : 2,
    airConductanceWPerK: config.module === 'plate' ? .2 : config.fan ? 1 : .5 };
}
export function steadyState(config) {
  const p = parametersFor(config), sinkC = p.ambientC + config.powerW / p.airConductanceWPerK;
  return { heaterC: sinkC + config.powerW * p.contactResistanceKPerW, sinkC };
}
function validate(temperatures, parameters, powerW) {
  shape(temperatures, ['heaterC', 'sinkC'], 'temperatures'); shape(parameters, parameterKeys, 'parameters');
  if (!Object.values(temperatures).every(finite) || !Object.values(parameters).every(finite) || !finite(powerW)) throw new TypeError('Finite temperatures, coefficients and heater power are required');
  if (parameterKeys.slice(1).some(key => parameters[key] <= 0) || powerW < 0) throw new RangeError('Capacities, resistance and conductance must be positive; power must be nonnegative');
}
export function temperatureRates(temperatures, parameters, powerW) {
  validate(temperatures, parameters, powerW);
  const contactHeatW = (temperatures.heaterC - temperatures.sinkC) / parameters.contactResistanceKPerW;
  const airHeatW = parameters.airConductanceWPerK * (temperatures.sinkC - parameters.ambientC);
  const result = { contactHeatW, airHeatW, heaterRateKPerS: (powerW - contactHeatW) / parameters.heaterCapacityJPerK,
    sinkRateKPerS: (contactHeatW - airHeatW) / parameters.sinkCapacityJPerK };
  if (!Object.values(result).every(Number.isFinite)) throw new RangeError('Thermal rates exceed floating-point range');
  return result;
}
function integralExp(rate, seconds) {
  const x = rate * seconds;
  return x < 1e-5 ? seconds * (x === 0 ? 1 : -Math.expm1(-x) / x) : -Math.expm1(-x) / rate;
}
function integralDifference(slow, fast, gap, seconds) {
  const x = fast * seconds, y = slow * seconds;
  if (x < .25) {
    // (I(slow)-I(fast))/gap = t² sum (-1)^n h_n(x,y)/(n+2)!.
    // This avoids subtracting two nearly equal t-sized input responses.
    let previous = 1, earlier = 0, factorial = 2, sum = .5;
    for (let n = 1; n < 18; n++) {
      const h = (x + y) * previous - x * y * earlier;
      factorial *= n + 2; const term = (n % 2 ? -h : h) / factorial;
      sum += term; earlier = previous; previous = h;
      if (Math.abs(term) < 1e-18) break;
    }
    return seconds * seconds * sum;
  }
  if (gap < fast * 1e-7) {
    // Continuous coincident-rate limit; omitted correction is O((gap/rate)²).
    const rate = (fast + slow) / 2, z = rate * seconds;
    return (z === Infinity ? 1 : -Math.expm1(-z) - z * Math.exp(-z)) / rate / rate;
  }
  return (integralExp(slow, seconds) - integralExp(fast, seconds)) / gap;
}
export function advanceTemperatures(temperatures, parameters, powerW, seconds) {
  validate(temperatures, parameters, powerW);
  if (!finite(seconds)) throw new TypeError('Duration must be finite');
  if (seconds < 0) throw new RangeError('Duration must be nonnegative');
  if (seconds === 0) return { ...temperatures };
  const { ambientC, heaterCapacityJPerK: ch, sinkCapacityJPerK: cs, contactResistanceKPerW: rc, airConductanceWPerK: ga } = parameters;
  const a = 1 / rc / ch, b = 1 / rc / cs, c = ga / cs, sum = a + b + c;
  const gap = Math.hypot(a - b - c, 2 * Math.sqrt(a) * Math.sqrt(b));
  const fast = sum / 2 + gap / 2, slow = (a / fast) * c;
  if (![a, b, c, gap, fast, slow].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Thermal coefficients exceed representable rates');
  const eSlow = Math.exp(-slow * seconds), eFast = Math.exp(-fast * seconds);
  const q = eSlow * (-Math.expm1(-gap * seconds)) / gap;
  const weight = Math.min(1, Math.max(0, .5 * (1 + (b + c - a) / gap)));
  const eHH = weight * eSlow + (1 - weight) * eFast, eSS = (1 - weight) * eSlow + weight * eFast;
  const inputH = powerW === 0 ? 0 : powerW / ch * (weight * integralExp(slow, seconds) + (1 - weight) * integralExp(fast, seconds));
  const inputS = powerW === 0 ? 0 : powerW / ch * b * integralDifference(slow, fast, gap, seconds);
  const h = temperatures.heaterC - ambientC, s = temperatures.sinkC - ambientC;
  const result = { heaterC: ambientC + eHH * h + a * q * s + inputH,
    sinkC: ambientC + b * q * h + eSS * s + inputS };
  if (!Object.values(result).every(Number.isFinite)) throw new RangeError('Thermal result exceeds floating-point range');
  return result;
}
