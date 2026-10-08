// One-shot confetti burst on a self-removing canvas overlay. No dependency.
//
// Lifted out of DailyTaskList so the lead page can fire it too: the moment
// an estimate actually goes out is the win a VA works toward on that page,
// and it deserves more than a toast.
export function fireConfetti() {
  if (typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) { canvas.remove(); return; }
  const colors = ["#2563eb", "#ec4899", "#16a34a", "#f59e0b", "#8b5cf6", "#ef4444"];
  const parts = Array.from({ length: 150 }, () => ({
    x: canvas.width / 2 + (Math.random() - 0.5) * 240,
    y: canvas.height / 3,
    vx: (Math.random() - 0.5) * 13,
    vy: Math.random() * -15 - 4,
    size: Math.random() * 7 + 4,
    color: colors[(Math.random() * colors.length) | 0],
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
  }));
  const start = performance.now();
  const DURATION = 2400;
  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - t / DURATION);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (t < DURATION) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
