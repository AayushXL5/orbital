// The sheet on compact widths: three detents. Drag the grabber to resize (a
// fling carries it to the next detent) and tap it to cycle, as on iOS.

const ORDER = ["small", "medium", "large"];

export class Sheet {
  constructor(panel, handle, grabber, { onChange } = {}) {
    this.panel = panel;
    this.onChange = onChange;
    this.detent = "medium";
    this.drag = null;
    this.enabled = false;
    handle.addEventListener("pointerdown", (e) => this.start(e));
    handle.addEventListener("pointermove", (e) => this.move(e));
    handle.addEventListener("pointerup", (e) => this.end(e));
    handle.addEventListener("pointercancel", (e) => this.end(e));
    grabber.addEventListener("click", () => { if (!this.moved) this.cycle(); });
    grabber.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.cycle(); }
      if (e.key === "ArrowUp") { e.preventDefault(); this.step(1); }
      if (e.key === "ArrowDown") { e.preventDefault(); this.step(-1); }
    });
    window.addEventListener("resize", () => this.enabled && this.set(this.detent, false));
  }

  heights() {
    const vh = window.innerHeight;
    // Medium leaves room above for the capsule, map controls and the playback bar.
    return { small: 148, medium: Math.round(Math.max(200, Math.min(vh * 0.44, vh - 392))), large: Math.round(vh - 200) };
  }

  enable(on) {
    this.enabled = on;
    if (on) this.set(this.detent, false);
    else document.documentElement.style.removeProperty("--sheet-h");
  }

  set(name, animate = true) {
    this.detent = name;
    this.panel.classList.toggle("dragging", !animate);
    this.apply(this.heights()[name]);
    if (!animate) requestAnimationFrame(() => this.panel.classList.remove("dragging"));
    this.onChange?.(name);
  }

  apply(h) {
    document.documentElement.style.setProperty("--sheet-h", `${Math.round(h)}px`);
  }

  cycle() { this.set(ORDER[(ORDER.indexOf(this.detent) + 1) % ORDER.length]); }
  step(dir) { this.set(ORDER[Math.max(0, Math.min(ORDER.length - 1, ORDER.indexOf(this.detent) + dir))]); }

  start(e) {
    if (!this.enabled || e.target.closest("button:not(.grabber), a, input")) return;
    this.drag = { y: e.clientY, h: this.panel.getBoundingClientRect().height, t: performance.now(), id: e.pointerId };
    this.moved = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    this.panel.classList.add("dragging");
  }

  move(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const dy = this.drag.y - e.clientY;
    if (Math.abs(dy) > 4) this.moved = true;
    const hs = this.heights();
    this.apply(Math.max(hs.small - 40, Math.min(hs.large + 24, this.drag.h + dy)));
  }

  end(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const dy = this.drag.y - e.clientY;
    const velocity = dy / Math.max(1, performance.now() - this.drag.t);
    const projected = this.drag.h + dy + velocity * 200;
    this.drag = null;
    this.panel.classList.remove("dragging");
    if (!this.moved) return;
    const hs = this.heights();
    const name = ORDER.reduce((best, k) => (Math.abs(hs[k] - projected) < Math.abs(hs[best] - projected) ? k : best), "small");
    this.set(name);
  }
}
