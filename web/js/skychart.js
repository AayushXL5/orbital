// Polar sky chart: the horizon is the outer ring, straight up is the centre,
// north is up and east is to the right, as when lying on your back facing north.

const DEG = Math.PI / 180;

export function skyChartSvg(path, marks = [], size = 300) {
  const cx = size / 2, cy = size / 2, R = size / 2 - 26;
  const xy = (az, el) => {
    const r = (R * (90 - Math.max(0, el))) / 90;
    return [cx + r * Math.sin(az * DEG), cy - r * Math.cos(az * DEG)];
  };
  const parts = [];
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${R}" class="sky-bg"/>`);
  for (const el of [30, 60]) {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${(R * (90 - el)) / 90}" class="sky-ring"/>`);
    parts.push(`<text x="${cx + 3}" y="${cy - (R * (90 - el)) / 90 - 3}" class="sky-tick">${el}°</text>`);
  }
  for (let az = 0; az < 360; az += 45) {
    const [x, y] = xy(az, 0);
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="sky-ring"/>`);
  }
  for (const [label, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
    const r = R + 14;
    parts.push(`<text x="${cx + r * Math.sin(az * DEG)}" y="${cy - r * Math.cos(az * DEG) + 4}" class="sky-card">${label}</text>`);
  }
  // Segments: bright while visible, faint while in shadow or daylight.
  let seg = [], segVis = null;
  const flush = () => {
    if (seg.length > 1) parts.push(`<polyline points="${seg.map((p) => p.join(",")).join(" ")}" class="${segVis ? "sky-vis" : "sky-dim"}"/>`);
  };
  for (const s of path) {
    const vis = s.lit && s.dark;
    const pt = xy(s.az, s.el);
    if (segVis !== null && vis !== segVis) { seg.push(pt); flush(); seg = [pt]; }
    else seg.push(pt);
    segVis = vis;
  }
  flush();
  for (const m of marks) {
    const [x, y] = xy(m.az, m.el);
    const right = x > cx + R * 0.35;  // keep labels inside the chart
    parts.push(`<circle cx="${x}" cy="${y}" r="4" class="sky-mark ${m.kind || ""}"/>`);
    parts.push(`<text x="${right ? x - 7 : x + 7}" y="${y + 4}" text-anchor="${right ? "end" : "start"}" class="sky-label">${m.label}</text>`);
  }
  return `<svg viewBox="0 0 ${size} ${size}" class="skychart" role="img" aria-label="Sky chart">${parts.join("")}</svg>`;
}
