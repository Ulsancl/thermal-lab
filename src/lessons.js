const copy = value => structuredClone(value);
export const LESSONS = {
  storage: { title: '열은 어디에 남을까?', steps: 2, config: { module: 'plate', contact: 'good', fan: false, powerW: 12 } },
  cooling: { title: '평판, 핀, 그리고 팬', steps: 3, config: { module: 'plate', contact: 'good', fan: false, powerW: 12 } },
  contact: { title: '맞닿은 면의 차이', steps: 2, config: { module: 'fins', contact: 'good', fan: true, powerW: 12 } },
};
export function createGuide(id) {
  if (!LESSONS[id]) throw new RangeError('Unknown lesson');
  return { id, stage: 0, status: 'active', observed: [], stageStartedS: 0, powerOff: null };
}
function expected(guide) {
  if (guide.id === 'storage') return { ...LESSONS.storage.config, powerW: guide.stage ? 0 : 12 };
  if (guide.id === 'cooling') return { module: guide.stage ? 'fins' : 'plate', contact: 'good', fan: guide.stage === 2, powerW: 12 };
  return { ...LESSONS.contact.config, contact: guide.stage ? 'poor' : 'good' };
}
const matches = (a, b) => Object.keys(b).every(key => a[key] === b[key]);
/** Called only for an actual user control change, before replacing the run. */
export function guideControlChange(guide, next, snapshot) {
  if (!guide || guide.status !== 'active') return;
  if (!matches(next, expected(guide))) {
    guide.status = 'interrupted';
    guide.notice = '안내의 조건을 바꿨습니다. 현재 실험을 자유롭게 관찰하거나 안내를 다시 시작하세요.';
    return;
  }
  if (guide.id === 'storage' && guide.stage === 1 && next.powerW === 0 && !guide.powerOff) {
    guide.powerOff = { timeS: snapshot.timeS, storedEnergyJ: snapshot.storedEnergyJ };
  }
  if (guide.id === 'cooling' && guide.stage === 2 && !snapshot.config.fan && next.fan) guide.stageStartedS = snapshot.timeS;
}
export function lessonReady(guide, snapshot) {
  if (guide?.status !== 'active' || !matches(snapshot.config, expected(guide))) return false;
  if (guide.id === 'storage') return guide.stage === 0
    ? snapshot.timeS >= 120 && snapshot.heaterC > snapshot.sinkC && snapshot.sinkC > 25
    : !!guide.powerOff && snapshot.timeS >= guide.powerOff.timeS + 120 && snapshot.storedEnergyJ < guide.powerOff.storedEnergyJ;
  return snapshot.timeS >= guide.stageStartedS + 1800
    && Math.abs(snapshot.heaterC - snapshot.steady.heaterC) <= 1
    && Math.abs(snapshot.sinkC - snapshot.steady.sinkC) <= 1;
}
export function confirmObservation(guide, snapshot, experiment) {
  if (!lessonReady(guide, snapshot)) return false;
  guide.observed.push(copy({ snapshot, experiment }));
  if (guide.stage === LESSONS[guide.id].steps - 1) {
    guide.status = 'completed';
    guide.evidence = copy(guide.observed);
  } else { guide.stage++; guide.stageStartedS = 0; }
  return true;
}
export function guideText(guide) {
  if (!guide) return { action: '', result: '' };
  if (guide.status === 'interrupted') return { action: guide.notice, result: '' };
  const f = x => x.toFixed(1), pair = s => `발열체 ${f(s.heaterC)} / 방열판 ${f(s.sinkC)} °C`;
  if (guide.status === 'completed') {
    const s = guide.evidence.map(item => item.snapshot);
    return { action: '완료 시점의 관찰값입니다. 이후 실험을 바꿔도 이 결과는 유지됩니다.', result: guide.id === 'storage'
      ? `처음 가열 관찰: ${pair(s[0])}. 냉각 관찰: ${pair(s[1])}. 차단 시 남은 열 ${f(guide.powerOff.storedEnergyJ)} → 냉각 뒤 ${f(s[1].storedEnergyJ)} J. 방열판은 꺼진 직후 잠시 더 따뜻해질 수 있습니다.`
      : s.map((value, index) => `${guide.id === 'cooling' ? ['평판', '핀', '핀 + 팬'][index] : ['좋은 접촉', '나쁜 접촉'][index]}: ${pair(value)}`).join('\n') };
  }
  const action = guide.id === 'storage' ? [
    '12 W로 120초 이상 가열하세요. 재생하거나 +60초를 두 번 누른 뒤 두 온도의 차이를 확인합니다.',
    '발열 전력을 0 W로 바꾸고 120초 이상 더 관찰하세요. 전원이 꺼져도 부품에는 열이 남아 있습니다.',
  ][guide.stage] : guide.id === 'cooling' ? [
    '평판에 12 W를 공급해 1,800초 이상 관찰하세요. +300초를 여섯 번 누르면 30분입니다. 예상 정상온도와 1 °C 이내가 되면 확인합니다.',
    '방열 모듈을 핀 방열판으로 교체하세요. 25 °C에서 다시 1,800초 이상 가열하고 평판과 비교합니다. 팬은 꺼 둡니다.',
    '냉각팬을 켜세요. 온도를 이어서 1,800초 이상 더 관찰합니다. 같은 전력인데 두 온도가 내려가는지 확인하세요.',
  ][guide.stage] : [
    '핀·팬·좋은 접촉에서 12 W로 1,800초 이상 관찰하세요. 발열체와 방열판의 온도 차이를 확인합니다.',
    '접촉면을 나쁜 접촉으로 교체하세요. 25 °C에서 1,800초 이상 다시 가열해, 특히 발열체 온도의 차이를 비교합니다.',
  ][guide.stage];
  return { action, result: guide.observed.length ? `직전 관찰: ${pair(guide.observed.at(-1).snapshot)}` : '' };
}
