import test from 'node:test';
import assert from 'node:assert/strict';
import { ThermalRun, createExperiment } from '../src/experiment.js';
import { LESSONS, createGuide, guideControlChange, lessonReady, confirmObservation, guideText } from '../src/lessons.js';

const clone = value => structuredClone(value);
const near = (actual, expected, tolerance = 1) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (±${tolerance})`);
const start = id => ({ run: new ThermalRun(createExperiment(LESSONS[id].config)), guide: createGuide(id) });
const ready = session => lessonReady(session.guide, session.run.getSnapshot());
const confirm = session => confirmObservation(session.guide, session.run.getSnapshot(), session.run.exportExperiment());
// Same contract as the controls: evaluate the guide before changing a run;
// module/contact replacement starts at ambient, power/fan keeps the timeline.
function change(session, patch) {
  const snapshot = session.run.getSnapshot(), next = { ...snapshot.config, ...patch };
  guideControlChange(session.guide, next, snapshot);
  if (next.module !== snapshot.config.module || next.contact !== snapshot.config.contact) session.run = new ThermalRun(createExperiment(next));
  else session.run.changeControl({ powerW: next.powerW, fan: next.fan });
}
function finishStorage(delay = 0) {
  const session = start('storage'); session.run.advance(120); assert.equal(confirm(session), true);
  session.run.advance(delay); change(session, { powerW: 0 }); session.run.advance(120); assert.equal(confirm(session), true);
  return session;
}

test('storage requires actual heating, then 120 seconds after power-off and reduced stored heat', () => {
  const session = start('storage');
  assert.equal(ready(session), false); assert.equal(confirm(session), false);
  session.run.advance(119.999); assert.equal(ready(session), false);
  session.run.advance(.001); assert.equal(ready(session), true); assert.equal(confirm(session), true);
  assert.equal(session.guide.stage, 1); assert.equal(session.guide.status, 'active');
  assert.equal(ready(session), false); assert.equal(confirm(session), false);
  const hot = session.run.getSnapshot(); change(session, { powerW: 0 });
  assert.deepEqual(session.guide.powerOff, { timeS: hot.timeS, storedEnergyJ: hot.storedEnergyJ });
  assert.equal(session.run.getSnapshot().heaterC, hot.heaterC);
  session.run.advance(119.999); assert.equal(ready(session), false);
  session.run.advance(.001); assert.equal(ready(session), true); assert.equal(confirm(session), true);
  assert.equal(session.guide.status, 'completed'); assert.equal(session.guide.evidence.length, 2);
  const cool = session.guide.evidence[1].snapshot;
  assert.ok(cool.storedEnergyJ > 0 && cool.storedEnergyJ < hot.storedEnergyJ);
  assert.equal(cool.inputEnergyJ, hot.inputEnergyJ); assert.ok(cool.releasedEnergyJ > hot.releasedEnergyJ);
});

test('delayed power-off result compares actual switch-off energy with cooling evidence', () => {
  const session = finishStorage(1680), guide = session.guide;
  const first = guide.evidence[0].snapshot, last = guide.evidence[1].snapshot;
  assert.equal(guide.powerOff.timeS, 1800); assert.equal(last.timeS, 1920);
  assert.ok(last.storedEnergyJ > first.storedEnergyJ, 'continued heating makes the first confirmation an invalid cooling baseline');
  assert.ok(last.storedEnergyJ < guide.powerOff.storedEnergyJ);
  const result = guideText(guide).result;
  const comparison = result.match(/차단 시 남은 열 ([\d.]+) → 냉각 뒤 ([\d.]+) J/);
  assert.ok(comparison, 'cooling result must identify the actual switch-off and final cooling values');
  assert.deepEqual(comparison.slice(1), [guide.powerOff.storedEnergyJ.toFixed(1), last.storedEnergyJ.toFixed(1)],
    'cooling result must use the actual power-off energy, even when the user delays switching off');
});

test('cooling compares plate, fins, then fan with a full wait from the actual fan switch', () => {
  const session = start('cooling'); session.run.advance(1799); assert.equal(ready(session), false);
  session.run.advance(1); assert.equal(confirm(session), true);
  const plate = session.guide.observed[0].snapshot; near(plate.heaterC, 91); near(plate.sinkC, 85);
  session.run.advance(300); assert.equal(ready(session), false); assert.equal(confirm(session), false);
  change(session, { module: 'fins' }); assert.equal(session.guide.status, 'active');
  assert.equal(session.run.getSnapshot().timeS, 0); assert.equal(session.run.getSnapshot().heaterC, 25);
  session.run.advance(1799); assert.equal(ready(session), false); session.run.advance(1); assert.equal(confirm(session), true);
  const fins = session.guide.observed[1].snapshot; near(fins.heaterC, 55); near(fins.sinkC, 49);
  assert.equal(ready(session), false); session.run.advance(321.25); assert.equal(ready(session), false);
  const beforeFan = session.run.getSnapshot(); change(session, { fan: true });
  assert.equal(session.guide.stageStartedS, 2121.25);
  assert.equal(session.run.getSnapshot().heaterC, beforeFan.heaterC); assert.equal(session.run.getSnapshot().sinkC, beforeFan.sinkC);
  assert.equal(ready(session), false); session.run.advance(1799.999); assert.equal(ready(session), false);
  session.run.advance(.001); assert.equal(confirm(session), true); assert.equal(session.guide.status, 'completed');
  const fan = session.guide.evidence[2].snapshot; near(fan.heaterC, 43); near(fan.sinkC, 37);
  assert.ok(plate.heaterC > fins.heaterC && fins.heaterC > fan.heaterC);
  assert.ok(plate.sinkC > fins.sinkC && fins.sinkC > fan.sinkC);
  assert.deepEqual(session.guide.evidence.map(x => x.snapshot.timeS), [1800, 1800, 3921.25]);
  assert.match(guideText(session.guide).result, /평판:.*\n핀:.*\n핀 \+ 팬:/);
});

test('contact replacement starts a new ambient run and shows heater-only steady penalty', () => {
  const session = start('contact'); session.run.advance(1800); assert.equal(confirm(session), true);
  const good = session.guide.observed[0].snapshot; near(good.heaterC, 43); near(good.sinkC, 37);
  session.run.advance(600); assert.equal(ready(session), false);
  change(session, { contact: 'poor' }); assert.equal(session.guide.status, 'active');
  assert.deepEqual(session.run.exportExperiment().events, []);
  assert.equal(session.run.getSnapshot().timeS, 0); assert.equal(session.run.getSnapshot().heaterC, 25); assert.equal(session.run.getSnapshot().sinkC, 25);
  session.run.advance(1799.999); assert.equal(ready(session), false); session.run.advance(.001);
  assert.equal(confirm(session), true); assert.equal(session.guide.status, 'completed');
  const poor = session.guide.evidence[1].snapshot; near(poor.heaterC, 61); near(poor.sinkC, 37);
  near(poor.heaterC - good.heaterC, 18, .01); near(poor.sinkC - good.sinkC, 0, .01);
  assert.match(guideText(session.guide).result, /좋은 접촉:.*\n나쁜 접촉:/);
});

test('wrong conditions interrupt each active guide and reverting controls does not resume it', () => {
  for (const [id, patch] of [['storage', { powerW: 8 }], ['cooling', { module: 'fins' }], ['contact', { fan: false }]]) {
    const session = start(id), original = session.run.getSnapshot().config;
    change(session, patch); assert.equal(session.guide.status, 'interrupted');
    assert.equal(ready(session), false); assert.equal(confirm(session), false);
    change(session, original); session.run.advance(1800);
    assert.equal(session.guide.status, 'interrupted'); assert.equal(confirm(session), false); assert.deepEqual(session.guide.observed, []);
    assert.match(guideText(session.guide).action, /조건을 바꿨습니다/);
  }
  const storage = start('storage'); storage.run.advance(120); confirm(storage);
  change(storage, { powerW: 4 }); assert.equal(storage.guide.status, 'interrupted'); assert.equal(storage.guide.powerOff, null);
  const cooling = start('cooling'); cooling.run.advance(1800); confirm(cooling);
  change(cooling, { module: 'fins', fan: true }); assert.equal(cooling.guide.status, 'interrupted');
  const contact = start('contact'); contact.run.advance(1800); confirm(contact);
  change(contact, { contact: 'poor', powerW: 8 }); assert.equal(contact.guide.status, 'interrupted');
});

test('checking readiness and confirming observations cannot change model time, events or temperature', () => {
  const session = start('cooling'); session.run.advance(1800);
  const experiment = session.run.exportExperiment(), snapshot = session.run.getSnapshot(), samples = session.run.getSamples();
  for (let i = 0; i < 3; i++) { assert.equal(ready(session), true); guideText(session.guide); }
  assert.equal(confirm(session), true); const guide = clone(session.guide);
  for (let i = 0; i < 3; i++) { assert.equal(confirm(session), false); guideText(session.guide); }
  assert.deepEqual(session.guide, guide); assert.deepEqual(session.run.exportExperiment(), experiment);
  assert.deepEqual(session.run.getSnapshot(), snapshot); assert.deepEqual(session.run.getSamples(), samples);
});

test('completed evidence is detached from arguments, working observations and subsequent controls', () => {
  const session = start('storage'); session.run.advance(120);
  const firstSnapshot = session.run.getSnapshot(), firstExperiment = session.run.exportExperiment();
  assert.equal(confirmObservation(session.guide, firstSnapshot, firstExperiment), true);
  firstSnapshot.heaterC = -100; firstExperiment.config.powerW = 0;
  assert.ok(session.guide.observed[0].snapshot.heaterC > 25); assert.equal(session.guide.observed[0].experiment.config.powerW, 12);
  change(session, { powerW: 0 }); session.run.advance(120); confirm(session);
  const completed = clone(session.guide.evidence), text = guideText(session.guide);
  session.guide.observed[0].snapshot.heaterC = -200; session.guide.observed[1].experiment.events[0].powerW = 12;
  change(session, { module: 'fins', powerW: 8, fan: true }); session.run.advance(1800);
  assert.equal(confirm(session), false); assert.equal(session.guide.status, 'completed');
  assert.deepEqual(session.guide.evidence, completed); assert.deepEqual(guideText(session.guide), text);
});

test('cloned undo state restores a pending transition and independent actual switch timing', () => {
  const session = start('cooling'); session.run.advance(1800); confirm(session);
  change(session, { module: 'fins' }); session.run.advance(1800); confirm(session); session.run.advance(123.5);
  const undo = clone({ experiment: session.run.exportExperiment(), guide: session.guide });
  change(session, { fan: true }); session.run.advance(1800); assert.equal(confirm(session), true);
  const restored = { run: new ThermalRun(undo.experiment), guide: clone(undo.guide) };
  assert.equal(restored.guide.status, 'active'); assert.equal(restored.guide.stage, 2); assert.equal(ready(restored), false);
  assert.equal(restored.run.getSnapshot().config.fan, false); assert.equal(restored.run.getSnapshot().timeS, 1923.5);
  change(restored, { fan: true }); assert.equal(restored.guide.stageStartedS, 1923.5);
  restored.run.advance(1800); assert.equal(confirm(restored), true);
  assert.deepEqual(restored.guide.evidence, session.guide.evidence);
  assert.equal(undo.guide.status, 'active'); assert.equal(undo.guide.stageStartedS, 0);
  assert.equal(undo.experiment.events.length, 0);
});

test('cloned undo during cooling preserves the original power-off baseline and final evidence', () => {
  const session = start('storage'); session.run.advance(120); confirm(session); session.run.advance(40);
  change(session, { powerW: 0 }); session.run.advance(45.5);
  const undo = clone({ experiment: session.run.exportExperiment(), guide: session.guide });
  session.run.advance(74.5); assert.equal(confirm(session), true);
  const restored = { run: new ThermalRun(undo.experiment), guide: clone(undo.guide) };
  assert.equal(ready(restored), false); assert.deepEqual(restored.guide.powerOff, session.guide.powerOff);
  restored.run.advance(74.5); assert.equal(confirm(restored), true);
  assert.deepEqual(restored.run.getSnapshot(), session.run.getSnapshot()); assert.deepEqual(restored.guide.evidence, session.guide.evidence);
  assert.equal(undo.guide.status, 'active'); assert.equal(undo.experiment.elapsedS, 205.5);
});
