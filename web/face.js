// The on-screen host: a chunky pixel character drawn on a canvas each frame.
// Mouth opening follows output amplitude (four shapes), the eyes blink on a
// random timer and look toward the speaker when listening, and the eyebrows
// jump on a punchline sting.

const INK = "#1c1b18", PAPER = "#efe9dc", AMBER = "#ffb000", SKIN = "#d9a066", SHADE = "#b47b45";

export class Face {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
    this.level = 0;        // smoothed mouth opening 0..1
    this.blink = 0;
    this.nextBlink = 2;
    this.brow = 0;         // eyebrow raise 0..1, decays
    this.listening = false;
    this.mood = "idle";    // idle | smug | shocked
    this.t = 0;
  }

  punch(mood = "smug") { this.brow = 1; this.mood = mood; }

  /** Mouth shape from amplitude: closed, slit, open, wide "O". */
  static shape(level) { return level < 0.08 ? 0 : level < 0.25 ? 1 : level < 0.55 ? 2 : 3; }

  draw(amplitude, dt) {
    const { g, c } = this;
    const P = Math.floor(Math.min(c.width / 48, c.height / 48)); // one art pixel
    const ox = Math.floor((c.width - 48 * P) / 2), oy = Math.floor((c.height - 48 * P) / 2);
    const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(ox + x * P, oy + y * P, w * P, h * P); };
    this.t += dt;
    // attack fast, release slower: reads as speech instead of flicker
    const k = amplitude > this.level ? 0.6 : 0.25;
    this.level += (amplitude - this.level) * k;
    this.brow = Math.max(0, this.brow - dt * 1.4);
    if (this.brow === 0) this.mood = "idle";
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) { this.blink = 0.14; this.nextBlink = 2 + Math.random() * 3; }
    this.blink = Math.max(0, this.blink - dt);

    g.fillStyle = PAPER;
    g.fillRect(0, 0, c.width, c.height);
    // scanlines, like a CRT preview monitor
    g.fillStyle = "rgba(0,0,0,.05)";
    for (let y = 0; y < c.height; y += 3) g.fillRect(0, y, c.width, 1);

    const bob = Math.round(Math.sin(this.t * 2) * 0.6 + this.level * 1.2);
    // head
    px(12, 8 + bob, 24, 30, INK);
    px(13, 9 + bob, 22, 28, SKIN);
    px(13, 31 + bob, 22, 6, SHADE);
    // hair, headset band and mic
    px(11, 6 + bob, 26, 6, INK);
    px(10, 14 + bob, 3, 10, INK);
    px(35, 14 + bob, 3, 10, INK);
    px(8, 18 + bob, 3, 2, INK); px(8, 20 + bob, 2, 9, INK); px(9, 29 + bob, 6, 2, INK);
    px(14, 29 + bob, 3, 2, this.level > 0.1 ? AMBER : "#7a6a4a"); // tally light on the mic
    // eyes
    const look = this.listening ? -1 : 0;
    const eyeH = this.blink > 0 ? 1 : this.mood === "shocked" ? 5 : 4;
    for (const ex of [17, 27]) {
      px(ex, 18 + bob + (4 - eyeH), 4, eyeH, "#fff");
      if (eyeH > 1) px(ex + 1 + look + (this.mood === "smug" ? 1 : 0), 19 + bob + (4 - eyeH) / 2, 2, 2, INK);
    }
    // eyebrows: raised by the sting, tilted when smug
    const by = 15 + bob - Math.round(this.brow * 3);
    px(16, by + (this.mood === "smug" ? 1 : 0), 6, 1, INK);
    px(26, by - (this.mood === "smug" ? 1 : 0), 6, 1, INK);
    // nose
    px(23, 23 + bob, 2, 3, SHADE);
    // mouth
    const s = Face.shape(this.level);
    const my = 28 + bob;
    if (s === 0) px(19, my + 1, this.mood === "smug" ? 8 : 10, 1, INK);
    else if (s === 1) { px(19, my, 10, 2, INK); px(20, my, 8, 1, "#7a2a20"); }
    else if (s === 2) { px(19, my - 1, 10, 4, INK); px(20, my, 8, 2, "#7a2a20"); px(20, my, 8, 1, "#fff"); }
    else { px(20, my - 2, 8, 6, INK); px(21, my - 1, 6, 4, "#7a2a20"); px(21, my - 1, 6, 1, "#fff"); }
    // shoulders and shirt
    px(8, 38, 32, 10, INK);
    px(9, 39, 30, 9, "#3b4a5c");
    px(22, 39, 4, 9, PAPER);
    return s;
  }
}
