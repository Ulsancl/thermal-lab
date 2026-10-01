import { ThermalRun } from './experiment.js';
export class TemperatureChart {
  constructor(canvas) { this.canvas = canvas; this.savedKey = ''; this.saved = []; this.debug = null; }
  draw(samples, comparison, { display = 'both', events = [] } = {}) {
    const key = JSON.stringify(comparison);
    if (key !== this.savedKey) { this.savedKey = key; this.saved = comparison ? new ThermalRun(comparison.experiment).getSamples() : []; }
    const bounds = this.canvas.getBoundingClientRect(), width = bounds.width, height = bounds.height;
    if (!width || !height) return;
    const dpr = Math.min(devicePixelRatio || 1, 2), ctx = this.canvas.getContext('2d');
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr); ctx.scale(dpr, dpr);
    const left = 43, right = width - 14, top = 15, bottom = height - 35;
    const end = Math.max(60, samples.at(-1)?.timeS ?? 0, this.saved.at(-1)?.timeS ?? 0);
    const x = t => left + (right - left) * t / end, y = t => bottom - (bottom - top) * (t - 25) / 85;
    ctx.font = '11px system-ui'; ctx.lineWidth = 1;
    for (const value of [25, 45, 65, 85, 110]) {
      ctx.strokeStyle = '#30434a'; ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke();
      ctx.fillStyle = '#9ab0b8'; ctx.textAlign = 'right'; ctx.fillText(String(value), left - 7, y(value) + 4);
    }
    const ticks = width < 430 ? 3 : 5;
    for (let index = 0; index <= ticks; index++) {
      const seconds = end * index / ticks, value = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
      ctx.textAlign = index === 0 ? 'left' : index === ticks ? 'right' : 'center'; ctx.fillText(value, x(seconds), bottom + 18);
    }
    ctx.textAlign = 'left'; ctx.fillText('°C', 6, 12); ctx.textAlign = 'right'; ctx.fillText('모의 시간 [분:초]', right, height - 2);
    const renderedCurrent = !comparison || display !== 'saved', renderedSaved = !!comparison && display !== 'current';
    const currentEvents = new Set(events.map(event => event.timeS)), savedEvents = new Set(comparison?.experiment.events.map(event => event.timeS) ?? []);
    const line = (data, field, color, dashed, eventTimes) => {
      if (!data.length) return;
      // Keep the recorded trace intact; only coarsen drawing to the canvas width.
      const stride = Math.max(1, Math.floor(data.length / Math.max(200, width * 2)));
      ctx.beginPath(); ctx.setLineDash(dashed ? [5, 5] : []);
      data.forEach((point, i) => { if (i % stride && i !== data.length - 1 && Number.isInteger(point.timeS) && !eventTimes.has(point.timeS)) return; const px = x(point.timeS), py = y(point[field]); if (!i) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      if (dashed) { ctx.strokeStyle = '#10232d'; ctx.lineWidth = 4.5; ctx.stroke(); }
      ctx.strokeStyle = color; ctx.lineWidth = dashed ? 1.8 : 2.3; ctx.stroke(); ctx.setLineDash([]);
      const last = data.at(-1), px = x(last.timeS), py = y(last[field]); ctx.fillStyle = color; ctx.beginPath();
      if (dashed) { ctx.moveTo(px, py - 5); ctx.lineTo(px + 5, py); ctx.lineTo(px, py + 5); ctx.lineTo(px - 5, py); ctx.closePath(); ctx.fillStyle = '#10232d'; ctx.fill(); ctx.lineWidth = 2; ctx.stroke(); }
      else { ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill(); }
    };
    if (renderedCurrent) { line(samples, 'heaterC', '#f3a16c', false, currentEvents); line(samples, 'sinkC', '#78d5e4', false, currentEvents); }
    if (renderedSaved) { line(this.saved, 'heaterC', '#f3a16c', true, savedEvents); line(this.saved, 'sinkC', '#78d5e4', true, savedEvents); }
    this.debug = { timeRange: [0, end], temperatureRange: [25, 110], currentCount: samples.length, savedCount: this.saved.length, currentEnd: samples.at(-1), savedEnd: this.saved.at(-1) ?? null,
      display: comparison ? display : 'both', renderedCurrent, renderedSaved,
      endpointMarkers: { current: renderedCurrent ? 'filled-circle' : null, saved: renderedSaved ? 'hollow-diamond' : null } };
  }
}
