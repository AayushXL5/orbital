// The sheet on phones. Drag the handle to any height and it stays there; a quick
// flick carries it to the top, or down to a slim handle so the whole Earth shows.
// Tap the handle to fold it down or bring it back. The app hides it completely
// when you tap the tab you're already on.

const FLICK = 0.9;      // px/ms: a release faster than this carries on to the end
const MINI = 44;        // the folded sheet: just the handle

export class Sheet {
  constructor(panel, handle, grabber, { onChange, initial } = {}) {
    this.panel = panel;
    this.onChange = onChange;
    this.height = null;
    this.open = initial || null;     // last unfolded height, restored by show()
    this.enabled = false;
    this.drag = null;
    handle.addEventListener("pointerdown", (e) => this.start(e));
    handle.addEventListener("pointermove", (e) => this.move(e));
    handle.addEventListener("pointerup", (e) => this.end(e));
    handle.addEventListener("pointercancel", (e) => this.end(e));
    grabber.addEventListener("click", () => { if (!this.moved) this.toggleFold(); });
    grabber.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.toggleFold(); }
      if (e.key === "ArrowUp") { e.preventDefault(); this.set((this.height || 0) + 80); }
      if (e.key === "ArrowDown") { e.preventDefault(); this.set(Math.max(MINI, (this.height || 0) - 80)); }
    });
    window.addEventListener("resize", () => this.enabled && this.set(this.height, false));
  }

  limits() {
    const vh = window.innerHeight;
    return { mini: MINI, max: Math.round(vh - 150),
      preferred: Math.round(Math.max(200, Math.min(vh * 0.44, vh - 392))) };
  }

  get hidden() { return this.height === 0; }
  get folded() { return this.height !== null && this.height <= MINI + 20; }

  enable(on) {
    this.enabled = on;
    if (on) this.set(this.height ?? this.open ?? this.limits().preferred, false);
    else document.documentElement.style.removeProperty("--sheet-h");
  }

  clamp(h) {
    const { mini, max } = this.limits();
    return h <= 0 ? 0 : Math.max(mini, Math.min(max, h));
  }

  set(h, animate = true) {
    h = this.clamp(h ?? this.limits().preferred);
    this.height = h;
    if (h > MINI + 20) this.open = h;
    this.panel.classList.toggle("dragging", !animate);
    this.apply(h, true);
    if (!animate) requestAnimationFrame(() => this.panel.classList.remove("dragging"));
  }

  apply(h, final) {
    document.documentElement.style.setProperty("--sheet-h", `${Math.round(h)}px`);
    this.panel.classList.toggle("is-hidden", h === 0);
    this.onChange?.(h, final);
  }

  show() { this.set(this.open && this.open > MINI + 20 ? this.open : this.limits().preferred); }
  hide() { this.set(0); }
  fold() { this.set(MINI); }
  toggleFold() { if (this.folded || this.hidden) this.show(); else this.fold(); }
  ensureOpen() { if ((this.height ?? 0) < 200) this.set(Math.max(this.open || 0, this.limits().preferred)); }

  start(e) {
    if (!this.enabled || e.target.closest("button:not(.grabber), a, input")) return;
    const h = this.panel.getBoundingClientRect().height;
    this.drag = { y: e.clientY, h, id: e.pointerId, samples: [{ y: e.clientY, t: performance.now() }] };
    this.moved = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    this.panel.classList.add("dragging");
  }

  move(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dy = d.y - e.clientY;
    if (Math.abs(dy) > 4) this.moved = true;
    const now = performance.now();
    d.samples.push({ y: e.clientY, t: now });
    while (d.samples.length > 2 && now - d.samples[0].t > 100) d.samples.shift();
    const { mini, max } = this.limits();
    this.apply(Math.max(mini - 16, Math.min(max + 24, d.h + dy)), false);
  }

  end(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.panel.classList.remove("dragging");
    if (!this.moved) return this.apply(this.height, true);
    const first = d.samples[0], last = d.samples[d.samples.length - 1];
    const recent = performance.now() - last.t < 80;
    const velocity = recent && last.t > first.t ? (first.y - last.y) / (last.t - first.t) : 0;
    const { mini, max } = this.limits();
    // A drag never hides the sheet: at the bottom it folds to the handle.
    let h = Math.max(mini, d.h + (d.y - e.clientY));
    if (velocity > FLICK) h = max;
    else if (velocity < -FLICK) h = mini;
    this.set(h);
  }
}
