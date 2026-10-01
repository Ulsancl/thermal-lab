const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export const COMPONENTS = freeze([
  { id: 'bench-base', name: '실험대', description: '발열부·팬·전원 장치를 고정하는 금속 실험대입니다.', material: '분체 도장 금속 · 고무 받침' },
  { id: 'insulator', name: '단열 받침', description: '발열 블록을 지지하는 대표 단열 받침입니다. 모형은 블록에서 받침·공기로 직접 빠지는 열을 계산하지 않습니다.', material: '대표 단열재' },
  { id: 'heater-block', name: '발열 블록', description: '입력 전력을 열로 받는 첫 번째 열용량입니다. 색과 프로브 값은 블록 전체의 평균온도 하나를 나타냅니다.', material: '구리 구조 표현' },
  { id: 'heater-leads', name: '전원 배선', description: '전원 장치와 발열 블록의 단자를 잇고 팬 뒤쪽에도 공급선을 연결합니다. 전기 저항·전압·선의 발열은 이번 열 모형에 포함하지 않습니다.', material: '절연 전선 · 금속 단자' },
  { id: 'contact-pad', name: '접촉 패드', description: '블록과 방열 모듈 사이의 접촉 열저항을 나타냅니다. 양호·불량 계수는 교육용 설정이며 그려진 패드 치수로 산출한 값이 아닙니다.', material: '대표 열접촉 패드' },
  { id: 'heat-sink', name: '방열 모듈', description: '평판 또는 핀 카트리지가 두 번째 열용량입니다. 핀 하나하나의 온도차는 계산하지 않으며 모듈 전체에 같은 평균온도를 표시합니다.', material: '알루미늄 구조 표현' },
  { id: 'cartridge-handle', name: '카트리지 손잡이', description: '교체식 방열 모듈에 연결된 손잡이입니다. 모듈 교체는 명시적 조작에서만 진행되며 새 실험으로 시작합니다.', material: '금속 스템 · 절연 그립' },
  { id: 'clamp-screws', name: '고정 나사', description: '방열 모듈의 네 모서리 구멍을 관통해 받침에 고정합니다. 나사 조임 힘을 접촉 저항으로 계산하지 않습니다.', material: '스테인리스 나사 · 와셔' },
  { id: 'fan-frame', name: '팬 프레임', description: '모듈 뒤에 장착된 대표 축류 팬입니다. 평판 실험에서는 팬이 작동하지 않습니다.', material: '도장 프레임 · 고무 마운트' },
  { id: 'fan-rotor', name: '팬 회전자', description: '팬 켜짐을 보여 주는 예시 회전입니다. 실제 RPM·유속·유동장은 계산하지 않습니다.', material: '대표 성형 블레이드' },
  { id: 'fan-guard', name: '팬 보호망', description: '회전자 앞뒤의 고정 보호망입니다. 회전자와 함께 돌지 않습니다.', material: '금속 와이어' },
  { id: 'probe-heater', name: '블록 온도 프로브', description: '발열 블록에 삽입된 프로브입니다. 표시값은 지점별 측정 대신 모형의 블록 평균온도입니다.', material: '스테인리스 프로브 · 주황 식별부' },
  { id: 'probe-sink', name: '모듈 온도 프로브', description: '방열 모듈 바닥판에 삽입된 프로브입니다. 표시값은 모듈의 평균온도입니다.', material: '스테인리스 프로브 · 청록 식별부' },
  { id: 'probe-cables', name: '프로브 케이블', description: '두 프로브의 신호선을 표시 장치까지 연결합니다. 분해 상태에서는 분리된 구조를 보여 주기 위해 경로가 늘어납니다.', material: '절연 신호선' },
  { id: 'power-unit', name: '전원·온도 표시 장치', description: '선택한 입력 전력과 두 평균온도를 표시합니다. 전력·팬 변경은 열 이력을 유지하며 명시적 조작으로 적용합니다.', material: '금속 하우징 · 표시창' },
  { id: 'power-dial', name: '전력 다이얼', description: '0·4·8·12 W 설정을 보여 줍니다. 부품을 선택하는 동작은 실험 조건을 바꾸지 않습니다.', material: '금속 노브 · 눈금' },
]);
export const DEFAULT_VIEW = freeze({ temperature: true, flows: true, exploded: false, labels: true, selectedPart: 'heat-sink' });

export const GEOMETRY = freeze({
  bench: { center: [0, .015, 0], size: [.440, .018, .280], topY: .024 },
  insulator: { center: [-.070, .030, 0], size: [.064, .012, .064] },
  heater: { center: [-.070, .046, 0], size: [.052, .020, .052] },
  pad: { center: [-.070, .05675, 0], size: [.052, .0015, .052] },
  sink: { center: [-.070, .061, 0], size: [.092, .007, .078], holeRadius: .0025, boltX: .038, boltZ: .029 },
  fins: { count: 9, pitch: .0076, thickness: .0024, height: .047, length: .064, bottomY: .0645 },
  clamp: { radius: .002, bottomY: .024, topY: .074 },
  fan: { center: [-.070, .104, -.108], size: [.088, .088, .023], openingRadius: .038, rotorRadius: .034, hubRadius: .010, guardRadius: .001 },
  power: { center: [.130, .065, .009], size: [.112, .082, .110] },
  probeHeater: { tip: [-.070, .050, .019], outlet: [-.070, .050, .080], radius: .0013 },
  probeSink: { tip: [-.045, .061, .029], outlet: [-.045, .061, .088], radius: .0013 },
  temperatureRangeC: [25, 110],
});

export function finCenters() {
  const { fins, sink } = GEOMETRY;
  return Array.from({ length: fins.count }, (_, i) => [sink.center[0] + (i - (fins.count - 1) / 2) * fins.pitch, fins.bottomY + fins.height / 2, 0]);
}
export function clampPositions() {
  const s = GEOMETRY.sink;
  return [-1, 1].flatMap(x => [-1, 1].map(z => [s.center[0] + x * s.boltX, (GEOMETRY.clamp.topY + GEOMETRY.clamp.bottomY) / 2, z * s.boltZ]));
}
export function assemblyOffsets(exploded = false) {
  if (typeof exploded !== 'boolean') throw new TypeError('exploded must be boolean');
  return { heater: [0, exploded ? .026 : 0, 0], pad: [0, exploded ? .056 : 0, 0], sink: [0, exploded ? .094 : 0, 0], clamps: [0, exploded ? .112 : 0, 0] };
}
export function temperatureColor(celsius) {
  if (!Number.isFinite(celsius)) throw new TypeError('Temperature must be finite');
  const value = Math.min(110, Math.max(25, celsius));
  const stops = [[25, [105, 200, 232]], [65, [245, 214, 117]], [110, [240, 107, 67]]];
  const [low, high] = value <= 65 ? stops.slice(0, 2) : stops.slice(1, 3), t = (value - low[0]) / (high[0] - low[0]);
  return '#' + low[1].map((n, i) => Math.round(n + (high[1][i] - n) * t).toString(16).padStart(2, '0')).join('');
}
