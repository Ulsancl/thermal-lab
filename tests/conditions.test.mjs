import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, assertConfig, fanSpeedPercent, parametersFor, steadyState } from '../src/model.js';
import { ThermalRun, createExperiment } from '../src/experiment.js';
import { createProject, parseProject, ProjectError, serializeProject } from '../src/project.js';
import { createGuide, guideControlChange } from '../src/lessons.js';
import { describeThermalDetail, thermalDetail } from '../src/detail-model.js';

const fins = { ...DEFAULT_CONFIG, module: 'fins' };
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('ambient offsets initial and steady temperatures while energy stays relative to ambient', () => {
  const baseline = new ThermalRun(), cold = new ThermalRun(createExperiment({ ...DEFAULT_CONFIG, ambientC: 10.5 }));
  const start = cold.getSnapshot();
  assert.deepEqual([start.heaterC, start.sinkC, start.storedEnergyJ, start.releasedEnergyJ], [10.5, 10.5, 0, 0]);
  assert.deepEqual(start.steady, { heaterC: 76.5, sinkC: 70.5 });
  const reference = baseline.advance(300), result = cold.advance(300);
  near(result.heaterC, reference.heaterC - 14.5);
  near(result.sinkC, reference.sinkC - 14.5);
  near(result.storedEnergyJ, reference.storedEnergyJ);
  near(result.releasedEnergyJ, reference.releasedEnergyJ);
  assert.match(describeThermalDetail('heater-block', result).note, /10\.5 °C/);
  assert.match(describeThermalDetail('cartridge-handle', result).note, /10\.5 °C/);
});

test('intermediate fan fractions preserve continuity and use the legacy endpoints', () => {
  assert.deepEqual([false, true].map(fan => parametersFor({ ...fins, fan }).airConductanceWPerK), [.5, 1]);
  const run = new ThermalRun(createExperiment(fins)), before = run.advance(120);
  const middle = run.changeControl({ fanSpeedPct: 50 });
  assert.equal(middle.config.fan, true);
  assert.equal(middle.parameters.airConductanceWPerK, .75);
  assert.deepEqual(middle.steady, { heaterC: 47, sinkC: 41 });
  for (const key of ['heaterC', 'sinkC', 'inputEnergyJ', 'storedEnergyJ', 'releasedEnergyJ']) assert.equal(middle[key], before[key]);
  near(middle.airHeatW, before.airHeatW * 1.5);
  near(thermalDetail(middle).power.balanceResidualW, 0);
  assert.deepEqual(describeThermalDetail('fan-rotor', middle).facts[0], { label: '팬 운전 비율', value: 50, unit: '%', digits: 2 });
  run.advance(1); run.changeControl({ fanSpeedPct: 50 });
  assert.equal(run.exportExperiment().events.length, 1);
  run.changeControl({ powerW: 8 });
  assert.equal(run.exportExperiment().events.at(-1).fanSpeedPct, 50);
  run.changeControl({ fan: true });
  assert.deepEqual(run.exportExperiment().events.at(-1), { timeS: 121, powerW: 8, fan: true });
  assert.equal(run.getSnapshot().parameters.airConductanceWPerK, 1);
});

test('independent air heat integration balances energy through numeric changes and cooling', () => {
  const ambient = 35, run = new ThermalRun(createExperiment({ ...fins, ambientC: ambient }));
  run.advance(120);
  run.changeControl({ fanSpeedPct: 37.5 }); run.advance(120);
  run.changeControl({ fanSpeedPct: 80, powerW: 0 }); const final = run.advance(120);
  const samples = run.getSamples();
  const integrateAir = (start, end, conductance) => {
    let sum = 0;
    for (let second = start; second <= end; second++) {
      const weight = second === start || second === end ? 1 : second % 2 === 0 ? 2 : 4;
      sum += weight * conductance * (samples[second].sinkC - ambient);
    }
    return sum / 3;
  };
  const airEnergy = integrateAir(0, 120, .5) + integrateAir(120, 240, .6875) + integrateAir(240, 360, .9);
  assert.equal(final.inputEnergyJ, 2880);
  near(final.storedEnergyJ + airEnergy, 2880, 2e-5);
  near(final.releasedEnergyJ, airEnergy, 2e-5);
  assert.ok(airEnergy > 0 && final.storedEnergyJ > 0 && final.heaterC >= ambient && final.sinkC >= ambient);
});

test('project roundtrip retains numeric conditions and the endpoints of legacy boolean events', () => {
  const experiment = { config: { ...fins, fan: true, fanSpeedPct: 28.25, ambientC: 0 }, elapsedS: 180.5,
    events: [{ timeS: 20, powerW: 12, fan: false }, { timeS: 80, powerW: 4, fan: true }, { timeS: 120, powerW: 8, fan: true, fanSpeedPct: 16.75 }] };
  const comparison = { label: '이전 팬 실험', experiment: { config: fins, elapsedS: 25, events: [{ timeS: 10, powerW: 12, fan: true }] } };
  const project = createProject({ experiment, comparison }), revived = parseProject(serializeProject(project));
  assert.deepEqual(revived, project);
  const replay = new ThermalRun(revived.experiment), reference = new ThermalRun(experiment);
  assert.deepEqual(replay.getSnapshot(), reference.getSnapshot());
  assert.deepEqual(replay.getSamples(), reference.getSamples());
  for (const [elapsedS, expected] of [[20, 0], [80, 100]]) {
    const prefix = { ...revived.experiment, elapsedS, events: experiment.events.filter(event => event.timeS <= elapsedS) };
    assert.equal(fanSpeedPercent(new ThermalRun(prefix).getSnapshot().config), expected);
  }
  assert.equal(replay.getSnapshot().config.fanSpeedPct, 16.75);
  assert.equal(new ThermalRun(revived.comparison.experiment).getSnapshot().parameters.ambientC, 25);
});

test('invalid ranges and fan states fail strict imports and invalid live control changes are atomic', () => {
  assert.equal(steadyState({ ...DEFAULT_CONFIG, ambientC: 45 }).heaterC, 111);
  for (const patch of [{ ambientC: -1 }, { ambientC: 46 }, { ambientC: null }, { ambientC: '25' }, { ambientC: -0 },
    { fanSpeedPct: -1 }, { fanSpeedPct: 101 }, { fanSpeedPct: null }, { fanSpeedPct: 50 }, { fan: true, fanSpeedPct: 0 }]) {
    assert.throws(() => assertConfig({ ...fins, ...patch }));
  }
  const run = new ThermalRun(createExperiment(fins)), before = run.getSnapshot();
  for (const patch of [{ fanSpeedPct: NaN }, { fanSpeedPct: Infinity }, { fanSpeedPct: 200 }, { ambientC: 30 }, { fanSpeedPct: 50, fan: false }]) {
    assert.throws(() => run.changeControl(patch));
    assert.deepEqual(run.getSnapshot(), before);
  }
  for (const edit of [p => { p.experiment.config.ambientC = 55; }, p => { p.experiment.config.fanSpeedPct = 5; },
    p => { p.experiment.events = [{ timeS: 0, powerW: 8, fan: false, ambientC: 30 }]; },
    p => { p.experiment.events = [{ timeS: 0, powerW: 8, fan: false, fanSpeedPct: 25 }]; }]) {
    const project = createProject(); edit(project);
    assert.throws(() => parseProject(JSON.stringify(project)), error => error instanceof ProjectError && error.code === 'INVALID_EXPERIMENT');
  }
  assert.throws(() => new ThermalRun().changeControl({ fanSpeedPct: 50 }), RangeError);
});

test('the cooling lesson uses the full-speed switch and custom conditions enter free exploration', () => {
  const guide = createGuide('cooling'), run = new ThermalRun(createExperiment(fins));
  guide.stage = 2;
  const before = run.advance(123.5), partial = structuredClone(guide);
  guideControlChange(partial, { ...fins, fan: true, fanSpeedPct: 50 }, before);
  assert.equal(partial.status, 'interrupted');
  guideControlChange(guide, { ...fins, fan: true }, before);
  assert.equal(guide.status, 'active');
  assert.equal(guide.stageStartedS, 123.5);
  const custom = createGuide('cooling');
  guideControlChange(custom, { ...DEFAULT_CONFIG, ambientC: 35 }, new ThermalRun().getSnapshot());
  assert.equal(custom.status, 'interrupted');
});
