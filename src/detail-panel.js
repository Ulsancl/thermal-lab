import { thermalDetail, describeThermalDetail } from './detail-model.js';

const format = (value, digits = 2) => typeof value === 'number'
  ? (Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : String(value);

export class ThermalDetailPanel {
  constructor(root, facts, note, onSelect) {
    this.root = root; this.facts = facts; this.note = note;
    root.innerHTML = `<div class="section-heading"><div><span class="eyebrow">HEAT BALANCE / 열의 흐름</span><h2 id="thermal-detail-title">들어온 열은 어디에 남을까요?</h2></div><span class="tag">현재 조건의 값</span></div>
      <p class="detail-explainer">W는 열이 이동하거나 저장되는 속도, J는 지금까지 쌓인 열입니다. 부품을 눌러 계산값을 살펴보세요.</p>
      <div class="thermal-circuit" aria-label="입력, 접촉 전달, 공기 전달과 두 물체의 저장 변화율">
        <div class="circuit-transfer"><span>입력 → 발열체</span><b data-value="power.inputW"></b></div>
        <div class="circuit-transfer"><span>접촉면 → 방열판</span><b data-value="power.contactW"></b></div>
        <div class="circuit-transfer"><span>방열판 → 공기</span><b data-value="power.airW"></b></div>
        <button type="button" class="circuit-node heater-node" data-part="heater-block"><span>발열체에 저장되는 속도</span><strong data-value="power.heaterStorageW"></strong><small>남은 열 <b data-value="energy.heaterJ"></b></small></button>
        <button type="button" class="circuit-node sink-node" data-part="heat-sink"><span>방열판에 저장되는 속도</span><strong data-value="power.sinkStorageW"></strong><small>남은 열 <b data-value="energy.sinkJ"></b></small></button>
        <button type="button" class="circuit-node air-node" data-part="fan-frame"><span>공기로 전달되는 속도</span><strong data-value="power.airW"></strong><small>지금까지 <b data-value="energy.releasedJ"></b></small></button>
      </div>
      <p class="detail-balance" id="thermal-balance"></p><p class="detail-explainer" id="thermal-rate-note"></p>
      <details class="thermal-resistance"><summary>접촉면과 공기의 열저항 비교</summary><div class="resistance-labels"><button type="button" data-part="contact-pad">접촉 <b data-value="path.contactResistanceKPerW"></b></button><button type="button" data-part="fan-frame">공기 <b data-value="path.airResistanceKPerW"></b></button></div><div class="resistance-bar" aria-hidden="true"><i id="contact-resistance-share"></i></div><p id="resistance-explanation"></p></details>
      <details class="thermal-modes"><summary>서로 다른 두 응답 시간</summary><p>같은 전력·팬 조건을 유지하면 현재 온도와 정상온도의 차이는 각각 감쇠하는 빠른 성분과 느린 성분의 합으로 표현됩니다.</p><div class="mode-pair"><div><span>빠른 성분의 시간상수</span><strong data-value="modes.fastTauS"></strong><small>발열체 <b data-value="modes.heaterFastK"></b> · 방열판 <b data-value="modes.sinkFastK"></b></small></div><div><span>느린 성분의 시간상수</span><strong data-value="modes.slowTauS"></strong><small>발열체 <b data-value="modes.heaterSlowK"></b> · 방열판 <b data-value="modes.sinkSlowK"></b></small></div></div><p>각 시간상수 뒤에는 해당 성분이 약 36.8% 남습니다. 표시된 K는 현재 성분의 크기이며, 시간상수는 정상온도에 도달하는 시각이 아닙니다.</p></details>`;
    root.querySelectorAll('[data-part]').forEach(button => button.addEventListener('click', () => onSelect(button.dataset.part)));
  }
  render(snapshot, partId, running) {
    const detail = thermalDetail(snapshot);
    this.root.querySelectorAll('[data-value]').forEach(element => {
      const [group, key] = element.dataset.value.split('.'), value = detail[group][key];
      const unit = key.endsWith('KPerW') ? 'K/W' : key.endsWith('W') ? 'W' : key.endsWith('J') ? 'J' : key.endsWith('TauS') ? 's' : 'K';
      element.textContent = `${format(value)} ${unit}`; element.dataset.raw = String(value);
    });
    const { power: w, path: p } = detail;
    this.root.querySelector('#thermal-balance').textContent = `${format(w.inputW)} W 입력 − ${format(w.airW)} W 공기 전달 = ${format(w.totalStorageW)} W 전체 저장 변화율`;
    this.root.querySelector('#thermal-rate-note').textContent = running ? '양수는 더 저장하는 중, 음수는 저장된 열을 내보내는 중입니다.' : '일시정지·기록 종료 중의 변화율은 현재 조건에서 시간을 진행할 때의 값입니다. 멈춘 상태에서 열이 계속 변하지는 않습니다.';
    this.root.querySelector('#contact-resistance-share').style.width = `${p.contactResistanceKPerW / p.totalResistanceKPerW * 100}%`;
    this.root.querySelector('#resistance-explanation').textContent = `전체 경로 ${format(p.totalResistanceKPerW)} K/W. 같은 열률이 흐르는 정상 상태에서 접촉 온도차는 ${format(p.steadyContactDeltaK)} K, 방열판과 공기 사이는 ${format(p.steadyAirDeltaK)} K입니다. 막대는 열저항 비율이며 현재 온도나 형상 길이가 아닙니다.`;
    const description = describeThermalDetail(partId, snapshot, detail);
    this.facts.replaceChildren(...description.facts.map(fact => {
      const pair = document.createElement('div'), term = document.createElement('dt'), value = document.createElement('dd');
      term.textContent = fact.label; value.textContent = `${format(fact.value, fact.digits)}${fact.unit ? ` ${fact.unit}` : ''}`; value.dataset.raw = String(fact.value);
      pair.append(term, value); return pair;
    }));
    this.note.textContent = description.note;
    return detail;
  }
}
