import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, parseProject, serializeProject, normalizeView, normalizePlaybackRate, DEFAULT_VIEW, ProjectError } from '../src/project.js';
import { DEFAULT_CONFIG, MODEL_VERSION } from '../src/model.js';
import { createExperiment, ThermalRun, MAX_TIME_S, MAX_EVENTS } from '../src/experiment.js';
import { COMPONENTS } from '../src/geometry.js';

const roundtrip = value => parseProject(serializeProject(value));
const fixture = () => ({ config: { module: 'fins', contact: 'poor', fan: false, powerW: 8 }, elapsedS: 420.875,
  events: [{ timeS: 120.125, powerW: 12, fan: true }, { timeS: 300.5, powerW: 0, fan: true }] });
const rejects = edit => { const value = createProject(); edit(value); const raw = JSON.stringify(value); assert.throws(() => parseProject(raw), e => e instanceof ProjectError && e.preserveOriginal); assert.equal(JSON.stringify(value), raw); };

test('default project stores initial conditions, timeline and speed without derived temperatures or running state', () => {
  const value = createProject();
  assert.deepEqual(value, { type: 'thermal-lab-project', schemaVersion: 1, modelVersion: MODEL_VERSION,
    experiment: createExperiment(), comparison: null, playbackRate: 60, observation: { view: { ...DEFAULT_VIEW }, camera: null } });
  assert.deepEqual(roundtrip(value), value);
});

test('fractional event timeline roundtrips exactly and reproduces snapshots and samples', () => {
  const experiment = fixture(), before = new ThermalRun(experiment);
  const project = createProject({ experiment, playbackRate: 10, comparison: { label: '판형 기준', experiment: { config: { ...DEFAULT_CONFIG }, elapsedS: 1800, events: [] } } });
  const saved = roundtrip(project), after = new ThermalRun(saved.experiment);
  assert.deepEqual(saved, project); assert.deepEqual(after.getSnapshot(), before.getSnapshot()); assert.deepEqual(after.getSamples(), before.getSamples());
  assert.equal(saved.experiment.config.powerW, 8); assert.equal(after.getSnapshot().config.powerW, 0);
  assert.equal(saved.experiment.config.fan, false); assert.equal(after.getSnapshot().config.fan, true);
  before.advance(75.25); after.advance(75.25); assert.deepEqual(after.exportExperiment(), before.exportExperiment()); assert.deepEqual(after.getSnapshot(), before.getSnapshot());
});

test('time-zero and redundant valid imported events retain their exact original order and values', () => {
  const experiment = { config: { ...DEFAULT_CONFIG }, elapsedS: 10, events: [{ timeS: 0, powerW: 8, fan: false }, { timeS: 2.5, powerW: 8, fan: false }] };
  assert.deepEqual(roundtrip(createProject({ experiment })).experiment, experiment);
});

test('the full supported timeline and event capacity remain serializable without truncation', () => {
  const experiment = { config: { module: 'fins', contact: 'good', fan: false, powerW: 12 }, elapsedS: MAX_TIME_S,
    events: Array.from({ length: MAX_EVENTS }, (_, i) => ({ timeS: i * 20, powerW: i % 2 ? 4 : 12, fan: i % 3 === 0 })) };
  const saved = roundtrip(createProject({ experiment }));
  assert.deepEqual(saved.experiment, experiment); assert.equal(saved.experiment.events.length, 256); assert.equal(saved.experiment.elapsedS, 7200);
});

test('strict imports reject impossible chronology, controls and hidden derived data without repair', () => {
  for (const edit of [p => { p.experiment.elapsedS = -1; }, p => { p.experiment.elapsedS = 7200.1; },
    p => { p.experiment.events = [{ timeS: 1, powerW: 4, fan: false }]; },
    p => { p.experiment = fixture(); p.experiment.events[1].timeS = 120.125; },
    p => { p.experiment = fixture(); p.experiment.events.reverse(); },
    p => { p.experiment.events = [{ timeS: 0, powerW: 4, fan: true }]; },
    p => { p.experiment.config.fan = true; }, p => { p.experiment.config.powerW = 6; },
    p => { p.experiment.events = [{ timeS: 0, powerW: '4', fan: false }]; },
    p => { p.experiment.events = Array.from({ length: 257 }, (_, i) => ({ timeS: i, powerW: 4, fan: false })); p.experiment.elapsedS = 300; },
    p => { p.experiment.heaterC = 40; }, p => { p.experiment.events = [{ timeS: 0, powerW: 4, fan: false, module: 'fins' }]; },
    p => { p.running = true; }, p => { p.samples = []; }, p => { p.observation.playbackRate = 1; }]) rejects(edit);
  const value = createProject(); value.experiment.elapsedS = NaN; assert.throws(() => serializeProject(value), ProjectError);
});

test('live invalid history starts a coherent ambient experiment while valid history is never normalized', () => {
  const malformed = fixture(); malformed.elapsedS = -5; malformed.config.powerW = 99;
  const value = createProject({ experiment: malformed });
  assert.deepEqual(value.experiment, { config: { module: 'fins', contact: 'poor', fan: false, powerW: 12 }, elapsedS: 0, events: [] });
  const snapshot = new ThermalRun(value.experiment).getSnapshot(); assert.equal(snapshot.heaterC, 25); assert.equal(snapshot.sinkC, 25);
  const valid = fixture(); assert.deepEqual(createProject({ experiment: valid }).experiment, valid);
});

test('playback is one of the three explicit model-time rates, never an imported clamp', () => {
  for (const value of [1, 10, 60]) { assert.equal(normalizePlaybackRate(value), value); assert.equal(roundtrip(createProject({ playbackRate: value })).playbackRate, value); }
  for (const value of [0, 2, 100, '10', null, NaN]) assert.equal(normalizePlaybackRate(value), 60);
  for (const value of [0, 2, 100, '10', null]) rejects(p => { p.playbackRate = value; });
});

test('all sixteen parts and observation flags persist with independent live defaults', () => {
  assert.equal(COMPONENTS.length, 16); assert.deepEqual(normalizeView(null), DEFAULT_VIEW);
  for (const { id } of COMPONENTS) { const view = { temperature: false, flows: false, exploded: true, labels: false, selectedPart: id }; assert.deepEqual(roundtrip(createProject({ view })).observation.view, view); }
  rejects(p => { p.observation.view.selectedPart = 'lens-glass'; }); rejects(p => { p.observation.view.exploded = 1; });
});

test('manual camera and endpoints are exact, with invalid geometry rejected', () => {
  for (const camera of [null, { position: [.05, 0, 0], target: [0, 0, 0] }, { position: [100, 100, 100], target: [90, 100, 100], zoom: .25 },
    { position: [.7323456789, .55, 1.4], target: [.1, .2, -.3], zoom: 4 }]) assert.deepEqual(roundtrip(createProject({ camera })).observation.camera, camera);
  for (const camera of [{ position: [0, 0, 0], target: [0, 0, 0] }, { position: [.049, 0, 0], target: [0, 0, 0] },
    { position: [10.01, 0, 0], target: [0, 0, 0] }, { position: [1, 0], target: [0, 0, 0] }, { position: [1, 0, 0], target: [0, 0, 0], zoom: 5 }]) rejects(p => { p.observation.camera = camera; });
});

test('comparison validates its own full experiment and neither creation nor parsing aliases inputs', () => {
  const experiment = fixture(), comparison = { label: ' 냉각 조건 ', experiment: fixture() }, camera = { position: [1, 1, 1], target: [0, 0, 0] };
  const input = { experiment, comparison, camera }, original = structuredClone(input), project = createProject(input);
  project.experiment.events[0].powerW = 4; project.comparison.experiment.events[0].powerW = 0; project.observation.camera.position[0] = 2;
  assert.deepEqual(input, original); assert.equal(roundtrip(project).comparison.label, comparison.label);
  for (const label of ['', '  ', 'a'.repeat(81), 'bad\nlabel']) rejects(p => { p.comparison = { label, experiment: createExperiment() }; });
  rejects(p => { p.comparison = { label: 'bad history', experiment: { ...fixture(), elapsedS: 10 } }; });
  rejects(p => { p.comparison = { label: 'derived', experiment: fixture(), temperature: 40 }; });
});

test('future versions carry original-protection flags and old products are rejected', () => {
  for (const [key, value, code] of [['schemaVersion', 2, 'FUTURE_SCHEMA'], ['modelVersion', 'thermal-two-node-2', 'FUTURE_MODEL']]) {
    assert.throws(() => parseProject(JSON.stringify({ ...createProject(), [key]: value })), e => e instanceof ProjectError && e.futureVersion && e.preserveOriginal && e.code === code);
  }
  rejects(p => { p.modelVersion = 'thin-lens-paraxial-1'; }); rejects(p => { p.schemaVersion = '1'; }); rejects(p => { delete p.comparison; });
});

test('one BOM and UTF-8 size limit protect malformed originals without modifying input', () => {
  const project = createProject(), raw = serializeProject(project); assert.deepEqual(parseProject('\ufeff' + raw), project);
  for (const input of ['\ufeff\ufeff' + raw, '{원본\r\n', null, 4]) assert.throws(() => parseProject(input), e => e.code === 'INVALID_JSON');
  for (const input of [' '.repeat(10 * 1024 * 1024 + 1), '가'.repeat(4 * 1024 * 1024)]) assert.throws(() => parseProject(input), e => e.code === 'PROJECT_TOO_LARGE');
});
