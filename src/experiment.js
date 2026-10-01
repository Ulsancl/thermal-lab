import { DEFAULT_CONFIG, assertConfig, normalizeConfig, parametersFor, steadyState, temperatureRates, advanceTemperatures } from './model.js';

export const MAX_TIME_S = 7200;
export const MAX_EVENTS = 256;
const clone = value => structuredClone(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
function record(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${name}: expected an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new TypeError(`${name}: missing or unknown field`);
}
export function createExperiment(config = DEFAULT_CONFIG) {
  return { config: normalizeConfig(config), elapsedS: 0, events: [] };
}
export function assertExperiment(experiment) {
  record(experiment, ['config', 'elapsedS', 'events'], 'experiment'); assertConfig(experiment.config);
  if (!finite(experiment.elapsedS)) throw new TypeError('Elapsed model time must be finite');
  if (experiment.elapsedS < 0 || experiment.elapsedS > MAX_TIME_S) throw new RangeError('Elapsed model time is outside 0..7200 seconds');
  if (!Array.isArray(experiment.events)) throw new TypeError('events must be an array');
  if (experiment.events.length > MAX_EVENTS) throw new RangeError('The experiment supports at most 256 control events');
  let previous = -1;
  for (const event of experiment.events) {
    record(event, ['timeS', 'powerW', 'fan'], 'event');
    if (!finite(event.timeS)) throw new TypeError('Event time must be finite');
    if (event.timeS < 0 || event.timeS > experiment.elapsedS || event.timeS <= previous) throw new RangeError('Events must be strictly increasing within the elapsed model time');
    assertConfig({ ...experiment.config, powerW: event.powerW, fan: event.fan }); previous = event.timeS;
  }
  return experiment;
}

export class ThermalRun {
  #initial; #events; #config; #parameters; #timeS = 0; #compensation = 0;
  #temperatures; #inputEnergyJ = 0; #segment; #samples; #nextInteger = 1;
  constructor(experiment = createExperiment()) {
    assertExperiment(experiment);
    this.#initial = clone(experiment.config); this.#events = clone(experiment.events);
    this.#config = clone(this.#initial); this.#parameters = parametersFor(this.#config);
    this.#temperatures = { heaterC: this.#parameters.ambientC, sinkC: this.#parameters.ambientC };
    this.#samples = [{ timeS: 0, ...this.#temperatures }]; this.#anchor();
    for (const event of this.#events) {
      this.#advanceTo(event.timeS); this.#commitSample(event.timeS, this.#temperatures);
      this.#config = { ...this.#initial, powerW: event.powerW, fan: event.fan };
      this.#parameters = parametersFor(this.#config); this.#anchor();
    }
    this.#advanceTo(experiment.elapsedS);
  }
  #anchor() {
    this.#segment = { timeS: this.#timeS, temperatures: { ...this.#temperatures }, inputEnergyJ: this.#inputEnergyJ };
  }
  #at(timeS) {
    return advanceTemperatures(this.#segment.temperatures, this.#parameters, this.#config.powerW, timeS - this.#segment.timeS);
  }
  #commitSample(timeS, temperatures) {
    if (this.#samples.at(-1).timeS !== timeS) this.#samples.push({ timeS, ...temperatures });
  }
  #advanceTo(timeS) {
    while (this.#nextInteger <= timeS) {
      this.#commitSample(this.#nextInteger, this.#at(this.#nextInteger)); this.#nextInteger++;
    }
    this.#temperatures = this.#at(timeS);
    this.#inputEnergyJ = this.#segment.inputEnergyJ + this.#config.powerW * (timeS - this.#segment.timeS);
    this.#timeS = timeS;
  }
  exportExperiment() { return { config: clone(this.#initial), elapsedS: this.#timeS, events: clone(this.#events) }; }
  getSnapshot() {
    const p = this.#parameters, storedEnergyJ = p.heaterCapacityJPerK * (this.#temperatures.heaterC - p.ambientC) + p.sinkCapacityJPerK * (this.#temperatures.sinkC - p.ambientC);
    return { config: clone(this.#config), timeS: this.#timeS, ...this.#temperatures,
      ...temperatureRates(this.#temperatures, p, this.#config.powerW), storedEnergyJ,
      inputEnergyJ: this.#inputEnergyJ, releasedEnergyJ: this.#inputEnergyJ - storedEnergyJ,
      steady: steadyState(this.#config), parameters: { ...p }, atLimit: this.#timeS === MAX_TIME_S };
  }
  getSamples() {
    const result = this.#samples.map(sample => ({ ...sample }));
    if (result.at(-1).timeS !== this.#timeS) result.push({ timeS: this.#timeS, ...this.#temperatures });
    return result;
  }
  advance(seconds) {
    if (!finite(seconds)) throw new TypeError('Duration must be finite');
    if (seconds < 0) throw new RangeError('Duration must be nonnegative');
    if (seconds === 0 || this.#timeS === MAX_TIME_S) return this.getSnapshot();
    if (seconds >= MAX_TIME_S - this.#timeS) { this.#advanceTo(MAX_TIME_S); this.#compensation = 0; }
    else {
      const corrected = seconds - this.#compensation, next = this.#timeS + corrected;
      this.#compensation = (next - this.#timeS) - corrected;
      this.#advanceTo(Math.min(MAX_TIME_S, next));
    }
    return this.getSnapshot();
  }
  changeControl(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || ![Object.prototype, null].includes(Object.getPrototypeOf(patch)) || Object.keys(patch).some(key => !['powerW', 'fan'].includes(key))) throw new TypeError('Only powerW and fan controls can change during a run');
    const next = { ...this.#config, ...patch }; assertConfig(next);
    if (next.powerW === this.#config.powerW && next.fan === this.#config.fan) return this.getSnapshot();
    const replacing = this.#events.at(-1)?.timeS === this.#timeS;
    if (!replacing && this.#events.length >= MAX_EVENTS) throw new RangeError('256 control events reached; save this experiment and start a new one');
    const event = { timeS: this.#timeS, powerW: next.powerW, fan: next.fan };
    if (replacing) this.#events[this.#events.length - 1] = event; else this.#events.push(event);
    this.#commitSample(this.#timeS, this.#temperatures);
    this.#config = next; this.#parameters = parametersFor(next); this.#anchor();
    return this.getSnapshot();
  }
}
