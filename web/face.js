// The host: a soft, squishy gradient blob drawn on a canvas each frame.
// It breathes when idle, leans in and widens its eyes while listening, wobbles
// while thinking, and its mouth opens with the output amplitude while talking.
// Eyebrows aren't a thing for blobs, so punchlines get a change of expression.

export class Face {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
    // render at the size it is shown (capped at 1.5x: sharp but cheap),
    // not a fixed 640x640 that is scaled down every frame
    const fit = () => {
      const r = canvas.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 1.5);
      const px = Math.round(Math.min(r.width, r.height) * d);
      if (px >= 120 && canvas.width !== px) { canvas.width = px; canvas.height = px; }
    };
    fit();
    new ResizeObserver(fit).observe(canvas);
    this.level = 0;
    this.blink = 0;
    this.nextBlink = 2;
    this.hop = 0;          // punchline bounce 0..1
    this.listening = false;
    this.thinking = false;
    this.mood = "idle";    // idle | smug | shocked
    this.t = 0;
    this.lookX = 0;
  }

  punch(mood = "smug") { this.mood = mood; this.moodT = 1.2; } // expression only: the mascot stays put

  /** Mouth shape from amplitude: closed, small, open, wide. */
  static shape(level) { return level < 0.08 ? 0 : level < 0.25 ? 1 : level < 0.55 ? 2 : 3; }

  draw(amplitude, dt) {
    const { g, c } = this;
    const W = c.width, H = c.height;
    this.t += dt;
    const k = amplitude > this.level ? 0.55 : 0.2;
    this.level += (amplitude - this.level) * k;
    this.hop = Math.max(0, this.hop - dt * 1.6);
    this.moodT = Math.max(0, (this.moodT ?? 0) - dt);
    if (this.moodT === 0 && this.mood !== "idle") this.mood = "idle";
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) { this.blink = 0.13; this.nextBlink = 2.2 + Math.random() * 3; }
    this.blink = Math.max(0, this.blink - dt);
    this.lookX += ((this.listening ? -0.12 : this.thinking ? Math.sin(this.t * 1.7) * 0.18 : 0) - this.lookX) * 0.08;

    g.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H * 0.52, R = Math.min(W, H) * 0.3;
    // squash and stretch: breathing, talking, and the punchline hop
    const breathe = Math.sin(this.t * 2.2) * 0.025;
    const hopY = -Math.sin(this.hop * Math.PI) * R * 0.35;
    const sx = 1 + breathe + this.level * 0.06 + (this.hop > 0.6 ? 0.08 : 0);
    const sy = 1 - breathe + this.level * 0.03 - (this.hop > 0.6 ? 0.06 : 0) + (this.listening ? 0.04 : 0);
    const wob = this.thinking ? Math.sin(this.t * 6) * 0.06 : 0;

    // soft shadow on the ground
    g.fillStyle = "rgba(60,40,80,.08)";
    g.beginPath();
    g.ellipse(cx, cy + R * 1.08, R * (0.8 - this.hop * 0.25), R * 0.12, 0, 0, Math.PI * 2);
    g.fill();

    g.save();
    g.translate(cx, cy + hopY);
    g.rotate(wob);
    g.scale(sx, sy);

    // body: a slightly lumpy circle with little arm nubs
    const grad = g.createLinearGradient(-R, -R, R, R);
    grad.addColorStop(0, "#ffc4a3");
    grad.addColorStop(0.5, "#ff7f6e");
    grad.addColorStop(1, "#de4f8f");
    g.fillStyle = grad;
    g.beginPath();
    const N = 48;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = R * (1 + 0.025 * Math.sin(a * 3 + this.t * 1.5) + 0.015 * Math.sin(a * 5 - this.t));
      const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.96;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.fill();
    for (const side of [-1, 1]) {
      const wave = side === 1 && this.level > 0.3 ? Math.sin(this.t * 10) * 0.25 : 0;
      g.beginPath();
      g.ellipse(side * R * 0.98, R * 0.25, R * 0.22, R * 0.16, side * (0.5 + wave), 0, Math.PI * 2);
      g.fill();
    }
    // glossy highlight
    const hl = g.createRadialGradient(-R * 0.35, -R * 0.45, 0, -R * 0.35, -R * 0.45, R * 0.8);
    hl.addColorStop(0, "rgba(255,255,255,.55)");
    hl.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = hl;
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();

    // rim light along the lower edge: reads as a soft, glossy 3D surface
    const rim = g.createRadialGradient(R * 0.2, R * 0.35, R * 0.5, 0, 0, R * 1.02);
    rim.addColorStop(0, "rgba(255,255,255,0)");
    rim.addColorStop(1, "rgba(255,220,235,.45)");
    g.fillStyle = rim;
    g.beginPath(); g.arc(0, 0, R * 0.99, 0, Math.PI * 2); g.fill();

    // eyes: tall white ovals that squash to lines when blinking
    const eyeH = this.blink > 0 ? 0.04 : this.mood === "shocked" ? 0.24 : this.listening ? 0.22 : 0.18;
    const ex = R * this.lookX;
    g.fillStyle = "#fff";
    for (const side of [-1, 1]) {
      g.beginPath();
      const tilt = this.mood === "smug" ? side * 0.25 : 0;
      g.ellipse(side * R * 0.27 + ex, -R * 0.16, R * 0.095, R * eyeH * 1.1, tilt, 0, Math.PI * 2);
      g.fill();
    }
    // mouth follows the voice
    const s = Face.shape(this.level);
    g.fillStyle = "#7a2343";
    g.strokeStyle = "#7a2343";
    g.lineWidth = R * 0.045;
    g.lineCap = "round";
    const my = R * 0.2;
    if (s === 0) {
      g.beginPath();
      if (this.mood === "smug") { g.moveTo(-R * 0.12 + ex, my); g.quadraticCurveTo(ex, my + R * 0.06, R * 0.16 + ex, my - R * 0.04); }
      else g.arc(ex, my - R * 0.04, R * 0.1, 0.2 * Math.PI, 0.8 * Math.PI);
      g.stroke();
    } else {
      const w = [0, 0.1, 0.13, 0.15][s] * R, h = [0, 0.05, 0.1, 0.16][s] * R;
      g.beginPath(); g.ellipse(ex, my + h * 0.3, w, h, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#ff9fb0";
      g.beginPath(); g.ellipse(ex, my + h * 0.75, w * 0.6, h * 0.35, 0, 0, Math.PI * 2); g.fill();
    }
    // cheeks
    g.fillStyle = "rgba(255,255,255,.22)";
    for (const side of [-1, 1]) { g.beginPath(); g.ellipse(side * R * 0.5 + ex, R * 0.08, R * 0.1, R * 0.06, 0, 0, Math.PI * 2); g.fill(); }
    g.restore();
    return s;
  }
}
