import { assertConfig, parametersFor, steadyState } from './model.js';
import { MAX_TIME_S } from './experiment.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const scalarKeys = ['timeS', 'heaterC', 'sinkC', 'contactHeatW', 'airHeatW', 'heaterRateKPerS', 'sinkRateKPerS', 'storedEnergyJ', 'inputEnergyJ', 'releasedEnergyJ'];
function checkedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('A solved thermal snapshot is required');
  assertConfig(snapshot.config);
  if (!scalarKeys.every(key => finite(snapshot[key])) || typeof snapshot.atLimit !== 'boolean') throw new TypeError('Thermal snapshot values must be finite');
  if (snapshot.timeS < 0 || snapshot.timeS > MAX_TIME_S || snapshot.inputEnergyJ < 0 || snapshot.atLimit !== (snapshot.timeS === MAX_TIME_S)) throw new RangeError('Invalid thermal snapshot time or input energy');
  const parameters = parametersFor(snapshot.config), steady = steadyState(snapshot.config);
  if (!snapshot.parameters || Object.entries(parameters).some(([key, value]) => snapshot.parameters[key] !== value)) throw new RangeError('Snapshot parameters must match its applied configuration');
  if (!snapshot.steady || Object.entries(steady).some(([key, value]) => snapshot.steady[key] !== value)) throw new RangeError('Snapshot steady reference must match its applied configuration');
  return snapshot;
}

/** Read-only SI observations of an already solved state. No time integration or event changes. */
export function thermalDetail(snapshot) {
  const s = checkedSnapshot(snapshot), p = s.parameters;
  const ch = p.heaterCapacityJPerK, cs = p.sinkCapacityJPerK, rc = p.contactResistanceKPerW, ga = p.airConductanceWPerK;
  const heaterJ = ch * (s.heaterC - p.ambientC), sinkJ = cs * (s.sinkC - p.ambientC);
  const heaterStorageW = ch * s.heaterRateKPerS, sinkStorageW = cs * s.sinkRateKPerS;
  const totalStorageW = heaterStorageW + sinkStorageW;
  const node = (temperatureC, steadyC, rateKPerS, capacityJPerK, storedEnergyJ, storagePowerW) => ({
    temperatureC, aboveAmbientK: temperatureC - p.ambientC, steadyC, errorToSteadyK: steadyC - temperatureC,
    rateKPerS, capacityJPerK, storedEnergyJ, storagePowerW,
  });

  // The two positive decay rates are eigenvalues of -A. The product form avoids
  // subtracting close positive numbers to obtain the slow rate.
  const a = 1 / rc / ch, b = 1 / rc / cs, c = ga / cs;
  const gap = Math.hypot(a - b - c, 2 * Math.sqrt(a) * Math.sqrt(b));
  const fastRatePerS = (a + b + c + gap) / 2, slowRatePerS = a / fastRatePerS * c;
  const modesFor = (temperature, steady, rate) => {
    const deviation = temperature - steady;
    const slow = (rate + fastRatePerS * deviation) / gap;
    const fast = -(rate + slowRatePerS * deviation) / gap;
    return { slow, fast };
  };
  const hModes = modesFor(s.heaterC, s.steady.heaterC, s.heaterRateKPerS);
  const sModes = modesFor(s.sinkC, s.steady.sinkC, s.sinkRateKPerS);
  return {
    timeS: s.timeS, atLimit: s.atLimit, ambientC: p.ambientC,
    nodes: {
      heater: node(s.heaterC, s.steady.heaterC, s.heaterRateKPerS, ch, heaterJ, heaterStorageW),
      sink: node(s.sinkC, s.steady.sinkC, s.sinkRateKPerS, cs, sinkJ, sinkStorageW),
    },
    path: {
      contactDeltaK: s.heaterC - s.sinkC, airDeltaK: s.sinkC - p.ambientC,
      contactResistanceKPerW: rc, airResistanceKPerW: 1 / ga, totalResistanceKPerW: rc + 1 / ga,
      contactConductanceWPerK: 1 / rc, airConductanceWPerK: ga,
      steadyContactDeltaK: s.config.powerW * rc, steadyAirDeltaK: s.config.powerW / ga,
    },
    power: {
      inputW: s.config.powerW, contactW: s.contactHeatW, airW: s.airHeatW,
      heaterStorageW, sinkStorageW, totalStorageW,
      heaterResidualW: s.config.powerW - s.contactHeatW - heaterStorageW,
      sinkResidualW: s.contactHeatW - s.airHeatW - sinkStorageW,
      balanceResidualW: s.config.powerW - s.airHeatW - totalStorageW,
    },
    energy: {
      heaterJ, sinkJ, storedJ: heaterJ + sinkJ, inputJ: s.inputEnergyJ, releasedJ: s.releasedEnergyJ,
      balanceResidualJ: s.inputEnergyJ - s.releasedEnergyJ - heaterJ - sinkJ,
      snapshotStorageResidualJ: s.storedEnergyJ - heaterJ - sinkJ,
    },
    modes: {
      fastRatePerS, slowRatePerS, fastTauS: 1 / fastRatePerS, slowTauS: 1 / slowRatePerS,
      heaterFastK: hModes.fast, heaterSlowK: hModes.slow, sinkFastK: sModes.fast, sinkSlowK: sModes.slow,
    },
  };
}

const fact = (label, value, unit = '', digits = 2) => ({ label, value, unit, digits });
const timeNote = '변화율과 열률은 현재 조건에서 모형 시간을 진행할 때의 값이며, 일시정지·기록 종료 중 실제 진행을 뜻하지 않습니다.';
const modeNote = '두 시간척도는 각 감쇠 성분이 1/e로 줄어드는 시간이며 정상온도 도달 시간이나 남은 기록 시간이 아닙니다.';

/** Each value belongs to an existing lumped node/path, never a new local sensor or material model. */
export function describeThermalDetail(partId, snapshot, detail = thermalDetail(snapshot)) {
  const d = detail, { heater: h, sink: s } = d.nodes, { path: p, power: w, energy: e, modes: m } = d;
  const fanState = snapshot.config.module === 'plate' ? '평판 · 팬 사용 안 함' : snapshot.config.fan ? '켜짐' : '꺼짐';
  const contactState = snapshot.config.contact === 'good' ? '좋음' : '나쁨';
  const moduleName = snapshot.config.module === 'plate' ? '평판' : '핀';
  const nodeFacts = (label, node) => [fact(`${label} 평균온도`, node.temperatureC, '°C'), fact(`${label} 정상온도`, node.steadyC, '°C'),
    fact(`${label} 변화율`, node.rateKPerS, 'K/s', 4), fact(`${label} 열용량`, node.capacityJPerK, 'J/K', 0),
    fact(`${label} 저장열`, node.storedEnergyJ, 'J'), fact(`${label} 저장 변화율`, node.storagePowerW, 'W')];
  const fanFacts = () => [fact('팬 상태', fanState), fact('공기 열전달도', p.airConductanceWPerK, 'W/K'),
    fact('공기 열저항', p.airResistanceKPerW, 'K/W'), fact('모듈−주변 온도차', p.airDeltaK, 'K'),
    fact('공기 전달 열률', w.airW, 'W'), fact('모듈 정상온도', s.steadyC, '°C')];
  const descriptors = {
    'bench-base': () => ({ facts: [fact('입력 열전력', w.inputW, 'W'), fact('공기 전달 열률', w.airW, 'W'),
      fact('전체 저장 변화율', w.totalStorageW, 'W'), fact('순간 열수지 잔차', w.balanceResidualW, 'W', 6),
      fact('빠른 모드 시간척도', m.fastTauS, 's'), fact('느린 모드 시간척도', m.slowTauS, 's')],
    note: `입력 = 공기 전달 + 두 물체의 저장 변화율입니다. 실험대 자체의 열용량은 계산하지 않습니다. ${modeNote}` }),
    'insulator': () => ({ facts: [fact('히터→받침 열경로', '모형에서 생략'), fact('주변온도', d.ambientC, '°C'),
      fact('블록 평균온도', h.temperatureC, '°C'), fact('블록 열용량', h.capacityJPerK, 'J/K', 0),
      fact('블록 저장열', e.heaterJ, 'J')], note: '받침 온도·열전도율·누설열은 계산하지 않습니다. 생략된 경로를 실제 단열 성능 0 W로 해석하지 마세요.' }),
    'heater-block': () => ({ facts: nodeFacts('블록', h), note: `저장열은 주변 25 °C를 기준으로 한 블록 전체의 값입니다. 국소 표면 온도나 재료 시험값이 아닙니다. ${timeNote}` }),
    'heater-leads': () => ({ facts: [fact('히터 입력 열전력', w.inputW, 'W'), fact('누적 입력열', e.inputJ, 'J'),
      fact('블록 저장 변화율', w.heaterStorageW, 'W'), fact('접촉 전달 열률', w.contactW, 'W')],
    note: '선택한 전력은 히터 노드에 들어가는 열입니다. 전압·전류·배선 저항·배선 발열·팬 소비전력은 이 모형에 없습니다.' }),
    'contact-pad': () => ({ facts: [fact('접촉 상태', contactState), fact('블록−모듈 온도차', p.contactDeltaK, 'K'),
      fact('접촉 열저항', p.contactResistanceKPerW, 'K/W'), fact('접촉 열전달도', p.contactConductanceWPerK, 'W/K'),
      fact('접촉 전달 열률', w.contactW, 'W'), fact('정상 접촉 온도차', p.steadyContactDeltaK, 'K')],
    note: '접촉 전달 = 현재 온도차 ÷ 접촉 열저항입니다. 양수는 블록→모듈, 음수는 반대입니다. 패드 자체의 온도·열용량은 없으며 표시 치수에서 계수를 계산하지 않습니다.' }),
    'heat-sink': () => ({ facts: nodeFacts('모듈', s), note: `모듈 전체의 평균온도와 주변 기준 저장열입니다. 핀 끝 온도나 핀별 열률을 나누어 계산하지 않습니다. ${timeNote}` }),
    'cartridge-handle': () => ({ facts: [fact('방열 모듈', moduleName), fact('모듈 열용량', s.capacityJPerK, 'J/K', 0),
      fact('모듈 평균온도', s.temperatureC, '°C'), fact('모듈 정상온도', s.steadyC, '°C'),
      fact('공기 열전달도', p.airConductanceWPerK, 'W/K'), fact('공기 전달 열률', w.airW, 'W')],
    note: '값은 연결된 방열 모듈의 값입니다. 손잡이 온도·접촉 안전성은 계산하지 않습니다. 모듈 교체는 새 25 °C 실험을 시작합니다.' }),
    'clamp-screws': () => ({ facts: [fact('접촉 상태', contactState), fact('접촉 열저항', p.contactResistanceKPerW, 'K/W'),
      fact('현재 접촉 온도차', p.contactDeltaK, 'K'), fact('정상 접촉 온도차', p.steadyContactDeltaK, 'K'),
      fact('접촉 전달 열률', w.contactW, 'W')], note: '조임 토크·압력·나사별 열전도는 계산하지 않습니다. 접촉 상태는 지정된 교육용 저항 계수이며 나사 형상으로 결정되지 않습니다.' }),
    'fan-frame': () => ({ facts: fanFacts(), note: '열전달도 W/K는 모듈 전체에서 공기로 전달되는 유효 계수입니다. 면적당 대류 계수 W/(m²·K)나 프레임 온도가 아닙니다.' }),
    'fan-rotor': () => ({ facts: fanFacts(), note: '팬은 핀 모듈의 유효 열전달도만 바꿉니다. 회전 그림에서 RPM·풍속·유량·팬 동력을 추정할 수 없습니다. 켜고 끌 때 현재 온도와 저장열은 이어집니다.' }),
    'fan-guard': () => ({ facts: fanFacts(), note: '보호망 자체의 온도·저항·압력 손실은 계산하지 않습니다. 공기 전달 열률의 양수는 모듈→주변 공기 방향입니다.' }),
    'probe-heater': () => ({ facts: [fact('블록 평균온도', h.temperatureC, '°C'), fact('현재 조건 정상온도', h.steadyC, '°C'),
      fact('정상−현재 온도차', h.errorToSteadyK, 'K'), fact('블록 변화율', h.rateKPerS, 'K/s', 4),
      fact('주변 대비 상승', h.aboveAmbientK, 'K')], note: `이상적인 평균값 표시입니다. 프로브의 국소 측정·응답 지연·오차를 추가하지 않습니다. ${timeNote}` }),
    'probe-sink': () => ({ facts: [fact('모듈 평균온도', s.temperatureC, '°C'), fact('현재 조건 정상온도', s.steadyC, '°C'),
      fact('정상−현재 온도차', s.errorToSteadyK, 'K'), fact('모듈 변화율', s.rateKPerS, 'K/s', 4),
      fact('주변 대비 상승', s.aboveAmbientK, 'K')], note: `프로브 위치와 관계없이 모듈 평균값 하나를 표시합니다. 정상값은 현재 입력을 오래 유지할 때의 참조입니다. ${timeNote}` }),
    'probe-cables': () => ({ facts: [fact('블록 평균온도', h.temperatureC, '°C'), fact('모듈 평균온도', s.temperatureC, '°C'),
      fact('블록−모듈 온도차', p.contactDeltaK, 'K'), fact('모형 시각', d.timeS, 's')],
    note: '두 프로브가 같은 모형 시각의 평균값을 표시합니다. 케이블의 열 이동·전기 신호·측정 오차나 지연은 계산하지 않습니다.' }),
    'power-unit': () => ({ facts: [fact('입력 열전력', w.inputW, 'W'), fact('블록 저장열', e.heaterJ, 'J'),
      fact('모듈 저장열', e.sinkJ, 'J'), fact('누적 입력열', e.inputJ, 'J'), fact('누적 공기 전달열', e.releasedJ, 'J'),
      fact('누적 열수지 잔차', e.balanceResidualJ, 'J', 6)], note: '누적 공기 전달열은 입력열−저장열의 회계값입니다. 잔차가 작다는 것만으로 독립 측정 검증을 뜻하지 않습니다. 벽면 전기 소비량이나 팬 소비전력은 포함하지 않습니다.' }),
    'power-dial': () => ({ facts: [fact('입력 열전력', w.inputW, 'W'), fact('전체 경로 열저항', p.totalResistanceKPerW, 'K/W'),
      fact('정상 블록 온도', h.steadyC, '°C'), fact('정상 모듈 온도', s.steadyC, '°C'),
      fact('현재 전체 저장 변화율', w.totalStorageW, 'W')], note: '정상 블록 상승온도 = 전력 × (접촉 저항 + 공기 저항)입니다. 전력 변경은 현재 온도·누적 에너지를 초기화하지 않으며 0 W와 일시정지는 다릅니다.' }),
  };
  if (!Object.hasOwn(descriptors, partId)) throw new RangeError(`Unknown thermal component: ${partId}`);
  return descriptors[partId]();
}
