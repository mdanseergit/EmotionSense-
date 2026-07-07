import { useCallback, useEffect, useRef, useState } from "react";
import * as faceapi from "face-api.js";

// ------- Types & constants -------
type EmotionKey =
  | "happy"
  | "sad"
  | "angry"
  | "disgusted"
  | "fearful"
  | "neutral"
  | "surprised";

const EMOTION_META: Record<
  EmotionKey,
  { emoji: string; label: string; color: string; bar: string; rgb: string }
> = {
  happy: {
    emoji: "😊",
    label: "Happy",
    color: "text-amber-400",
    bar: "from-amber-500 to-yellow-400",
    rgb: "245, 158, 11",
  },
  sad: {
    emoji: "😢",
    label: "Sad",
    color: "text-blue-400",
    bar: "from-blue-600 to-blue-400",
    rgb: "59, 130, 246",
  },
  angry: {
    emoji: "😠",
    label: "Angry",
    color: "text-red-400",
    bar: "from-red-700 to-rose-500",
    rgb: "220, 20, 60",
  },
  disgusted: {
    emoji: "🤢",
    label: "Disgusted",
    color: "text-green-400",
    bar: "from-green-700 to-green-500",
    rgb: "34, 197, 94",
  },
  fearful: {
    emoji: "😨",
    label: "Fearful",
    color: "text-purple-400",
    bar: "from-purple-700 to-purple-500",
    rgb: "147, 51, 234",
  },
  neutral: {
    emoji: "😐",
    label: "Neutral",
    color: "text-gray-400",
    bar: "from-gray-600 to-gray-500",
    rgb: "107, 114, 128",
  },
  surprised: {
    emoji: "😲",
    label: "Surprised",
    color: "text-orange-400",
    bar: "from-orange-600 to-amber-500",
    rgb: "249, 115, 22",
  },
};

const EMOTION_KEYS = Object.keys(EMOTION_META) as EmotionKey[];
const MODEL_URL = "https://justadudewhohacks.github.io/face-api.js/models";

type Status =
  | { kind: "idle" }
  | { kind: "loading-models"; progress: number }
  | { kind: "requesting-camera" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function formatTime(s: number) {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

// Ember particle config — randomised positions & timings
const EMBERS = Array.from({ length: 18 }, (_, i) => ({
  left: `${(i * 5.7 + 2) % 97}%`,
  delay: `${((i * 0.43) % 4).toFixed(2)}s`,
  duration: `${(2.8 + (i * 0.55) % 2.4).toFixed(2)}s`,
  size: `${2 + (i % 3)}px`,
  drift: i % 2 === 0 ? "16px" : "-22px",
}));

// ------- Main App -------
export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [running, setRunning] = useState(false);
  const [expressions, setExpressions] = useState<Record<EmotionKey, number> | null>(null);
  const [fps, setFps] = useState(0);
  const [faceBox, setFaceBox] = useState<{ w: number; h: number } | null>(null);
  const [sessionTime, setSessionTime] = useState(0);

  // ------- Load models + open camera -------
  const start = useCallback(async () => {
    try {
      setStatus({ kind: "loading-models", progress: 15 });
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
      ]);
      setStatus({ kind: "requesting-camera" });
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 720, height: 540, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStatus({ kind: "ready" });
      setRunning(true);
      setSessionTime(0);
      timerRef.current = setInterval(() => setSessionTime((t) => t + 1), 1000);
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
  }, []);

  const stop = useCallback(() => {
    setRunning(false);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setExpressions(null);
    setFaceBox(null);
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ------- Detection loop -------
  useEffect(() => {
    if (!running) return;
    let lastFpsTime = performance.now();
    let frames = 0;

    const tick = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (canvas.width !== vw) canvas.width = vw;
      if (canvas.height !== vh) canvas.height = vh;

      try {
        const detection = await faceapi
          .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 }))
          .withFaceExpressions();

        const ctx = canvas.getContext("2d");
        if (!ctx) { rafRef.current = requestAnimationFrame(tick); return; }
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (detection) {
          const { x, y, width, height } = detection.detection.box;
          const expressionsObj = detection.expressions as unknown as Record<string, number>;
          const topEntry = (Object.entries(expressionsObj) as [EmotionKey, number][])
            .sort((a, b) => b[1] - a[1])[0];
          const emotionRgb = EMOTION_META[topEntry[0]]?.rgb ?? "220, 20, 60";

          // ── Bounding box: emotion-reactive red glow ──
          ctx.lineWidth = Math.max(2, Math.round(vw / 270));
          ctx.strokeStyle = `rgba(${emotionRgb}, 0.92)`;
          ctx.shadowColor = `rgba(${emotionRgb}, 0.85)`;
          ctx.shadowBlur = 22;
          ctx.strokeRect(x, y, width, height);

          // ── Corner accents: fire gold ──
          const c = Math.min(28, width * 0.15);
          ctx.lineWidth = Math.max(3, Math.round(vw / 200));
          ctx.strokeStyle = "#fbbf24";
          ctx.shadowColor = "rgba(251, 191, 36, 1)";
          ctx.shadowBlur = 28;
          ctx.beginPath();
          ctx.moveTo(x, y + c);         ctx.lineTo(x, y);              ctx.lineTo(x + c, y);
          ctx.moveTo(x + width - c, y); ctx.lineTo(x + width, y);      ctx.lineTo(x + width, y + c);
          ctx.moveTo(x + width, y + height - c); ctx.lineTo(x + width, y + height); ctx.lineTo(x + width - c, y + height);
          ctx.moveTo(x + c, y + height); ctx.lineTo(x, y + height);    ctx.lineTo(x, y + height - c);
          ctx.stroke();
          ctx.shadowBlur = 0;

          // ── Label text: UN-MIRRORED + Leo styling ──
          const labelText = `${EMOTION_META[topEntry[0]].emoji} ${EMOTION_META[topEntry[0]].label.toUpperCase()}  ${Math.round(topEntry[1] * 100)}%`;
          const fontSize = Math.max(18, Math.round(vw / 40));
          ctx.font = `700 ${fontSize}px Inter, ui-sans-serif`;
          const padX = 14, padY = 10;
          const textW = ctx.measureText(labelText).width;
          const labelY = Math.max(fontSize + padY * 2, y - 14);

          // Apply inverse of CSS scaleX(-1) so text renders readable
          ctx.save();
          ctx.translate(vw, 0);
          ctx.scale(-1, 1);
          const visRightEdge = vw - x;
          const visLabelX = Math.max(4, visRightEdge - textW - padX * 2);

          // Label bg — near-black with gold border
          ctx.fillStyle = "rgba(2, 0, 0, 0.93)";
          ctx.strokeStyle = "rgba(251, 191, 36, 0.85)";
          ctx.lineWidth = 1.8;
          roundRect(ctx, visLabelX, labelY - fontSize - padY, textW + padX * 2, fontSize + padY * 2, 6);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "#fbbf24"; // fire gold text
          ctx.fillText(labelText, visLabelX + padX, labelY);
          ctx.restore();

          setExpressions(expressionsObj as Record<EmotionKey, number>);
          setFaceBox({ w: width, h: height });
        } else {
          setExpressions(null);
          setFaceBox(null);
        }
      } catch (_e) { /* ignore transient errors */ }

      frames++;
      const now = performance.now();
      if (now - lastFpsTime >= 1000) {
        setFps(Math.round((frames * 1000) / (now - lastFpsTime)));
        frames = 0;
        lastFpsTime = now;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [running]);

  // Dominant emotion
  const dominant: { key: EmotionKey; value: number } | null = expressions
    ? (() => {
        const sorted = (Object.entries(expressions) as [EmotionKey, number][]).sort((a, b) => b[1] - a[1]);
        return sorted[0] ? { key: sorted[0][0], value: sorted[0][1] } : null;
      })()
    : null;

  const glowRgb = dominant ? EMOTION_META[dominant.key].rgb : "220, 20, 60";

  return (
    <div className="min-h-screen bg-leo text-white overflow-x-hidden">

      {/* ── Film grain SVG overlay ── */}
      <svg
        className="fixed inset-0 w-full h-full pointer-events-none z-50 opacity-[0.038]"
        xmlns="http://www.w3.org/2000/svg"
      >
        <filter id="grain-filter">
          <feTurbulence type="fractalNoise" baseFrequency="0.68" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain-filter)" className="grain-anim" />
      </svg>

      {/* ── Floating ember particles ── */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-10">
        {EMBERS.map((e, i) => (
          <div
            key={i}
            className="ember absolute rounded-full"
            style={{
              left: e.left,
              bottom: "-4px",
              width: e.size,
              height: e.size,
              animationDelay: e.delay,
              animationDuration: e.duration,
              "--drift": e.drift,
            } as React.CSSProperties}
          />
        ))}
      </div>

      {/* ── Page vignette ── */}
      <div className="fixed inset-0 pointer-events-none z-20 vignette" />

      {/* ── Animated dot grid ── */}
      <div className="fixed inset-0 pointer-events-none z-0 grid-overlay" />

      <div className="mx-auto max-w-6xl px-5 py-10 md:py-14 relative z-30">

        <Header running={running} />

        {/* ── Divider ── */}
        <div className="mt-8 flex items-center gap-4">
          <div className="flex-1 h-px bg-gradient-to-r from-transparent via-red-800/50 to-transparent" />
          <span className="text-[9px] font-bold tracking-[0.35em] text-red-700/70 uppercase">Beast Mode Interface</span>
          <div className="flex-1 h-px bg-gradient-to-r from-transparent via-red-800/50 to-transparent" />
        </div>

        <main className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">

          {/* ── Video card ── */}
          <section className="lg:col-span-3">
            <div
              className="relative overflow-hidden rounded-2xl glass"
              style={{
                boxShadow: `0 0 0 1px rgba(${glowRgb}, 0.28), 0 28px 80px -20px rgba(${glowRgb}, 0.55), 0 10px 40px -10px rgba(245, 158, 11, 0.18)`,
                transition: "box-shadow 0.9s ease",
              }}
            >
              {/* Status bar */}
              <div className="flex items-center justify-between border-b border-red-900/40 px-5 py-3 bg-black/50">
                <div className="flex items-center gap-3">
                  <span className={`h-2 w-2 rounded-full ${running ? "bg-red-500 pulse-red" : "bg-gray-700"}`} />
                  <span className="text-[10px] font-bold tracking-[0.22em] uppercase text-red-400/80">
                    {running ? "◉ LIVE" : "◎ STANDBY"} · BEAST CAM
                  </span>
                  {running && (
                    <span className="font-mono text-[10px] text-amber-600/70 border border-amber-900/40 rounded px-2 py-0.5 tabular-nums">
                      ⏱ {formatTime(sessionTime)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {running && (
                    <span className="flex items-center gap-1.5 text-[10px] font-bold text-red-500 tracking-[0.15em]">
                      <span className="h-1.5 w-1.5 rounded-full bg-red-500 pulse-red" />
                      SCANNING
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-amber-700/70 tabular-nums">{fps} FPS</span>
                </div>
              </div>

              {/* Video viewport */}
              <div className="relative aspect-[4/3] w-full bg-black">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="absolute inset-0 h-full w-full scale-x-[-1] object-cover"
                />
                <canvas
                  ref={canvasRef}
                  className="absolute inset-0 h-full w-full scale-x-[-1]"
                />

                {/* Red tactical scanline */}
                <div className="scanline absolute inset-0 pointer-events-none z-10" />

                {/* Inner video vignette */}
                <div className="absolute inset-0 pointer-events-none z-10 video-vignette" />

                {/* Gold HUD corner brackets */}
                {[
                  "top-3 left-3 border-t-2 border-l-2",
                  "top-3 right-3 border-t-2 border-r-2",
                  "bottom-3 left-3 border-b-2 border-l-2",
                  "bottom-3 right-3 border-b-2 border-r-2",
                ].map((pos, i) => (
                  <div key={i} className={`absolute ${pos} w-6 h-6 border-amber-500/75 pointer-events-none z-20`} />
                ))}

                {/* Center crosshair — only when not running */}
                {!running && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                    <div className="relative w-16 h-16">
                      <div className="absolute inset-0 border border-red-600/30 rounded-full" />
                      <div className="absolute top-1/2 left-0 right-0 h-px bg-red-600/30 -translate-y-1/2" />
                      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-red-600/30 -translate-x-1/2" />
                      <div className="absolute inset-3 border border-amber-600/20 rounded-full" />
                    </div>
                  </div>
                )}

                <StatusOverlay status={status} running={running} onStart={start} />
              </div>

              {/* Bottom bar */}
              <div className="flex items-center justify-between gap-3 border-t border-red-900/40 px-5 py-4 bg-black/50">
                <div className="text-[11px] text-gray-600 tracking-wide">
                  Powered by <span className="text-amber-700">face-api.js</span> · 100% local · no uploads
                </div>
                <div className="flex gap-2">
                  {running ? (
                    <button
                      onClick={stop}
                      className="rounded bg-red-950/70 border border-red-700/50 px-4 py-2 text-sm font-bold tracking-widest text-red-400 transition hover:bg-red-900/70 font-cinematic"
                    >
                      ■ STOP
                    </button>
                  ) : (
                    <button
                      onClick={start}
                      disabled={status.kind === "loading-models" || status.kind === "requesting-camera"}
                      className="btn-leo rounded px-6 py-2.5 text-sm"
                    >
                      {status.kind === "loading-models" || status.kind === "requesting-camera"
                        ? "⚙ LOADING..."
                        : "▶ ACTIVATE BEAST"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* ── Emotion panel ── */}
          <section className="lg:col-span-2 space-y-5">
            <DominantCard dominant={dominant} faceBox={faceBox} glowRgb={glowRgb} />
            <EmotionBars expressions={expressions} />
            <InfoCard />
          </section>
        </main>

        <footer className="mt-10 text-center text-[10px] font-bold tracking-[0.3em] text-red-900/60 uppercase">
          Your video never leaves your device · All detection happens locally
        </footer>
      </div>
    </div>
  );
}

// ------- Sub-components -------

function Header({ running }: { running: boolean }) {
  return (
    <header className="flex flex-col items-start justify-between gap-5 md:flex-row md:items-center">
      <div className="flex items-center gap-4">
        {/* Tiger icon */}
        <div className="relative">
          <div className="grid h-14 w-14 place-items-center rounded-xl bg-gradient-to-br from-red-950 via-red-800 to-amber-700 fire-glow float-emoji">
            <span className="text-3xl select-none">🐅</span>
          </div>
          {running && (
            <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500 pulse-red border-2 border-black" />
          )}
        </div>

        <div>
          <div className="text-[9px] font-bold tracking-[0.4em] text-red-600/80 uppercase mb-0.5">
            ⚡ Thalapathy &nbsp;·&nbsp; Beast Mode
          </div>
          <h1 className="font-cinematic text-5xl md:text-6xl leading-none tracking-wide">
            <span className="text-gradient">EmotionSense</span>
          </h1>
          <p className="text-[10px] text-gray-600 tracking-[0.25em] mt-0.5 uppercase">
            Real-time AI · Facial Detection
          </p>
        </div>
      </div>

      {/* Status badge */}
      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center gap-2 rounded bg-red-950/50 border border-red-800/40 px-4 py-2.5">
          <span className={`h-2 w-2 rounded-full ${running ? "bg-red-500 pulse-red" : "bg-gray-700"}`} />
          <span className="text-[10px] font-bold tracking-[0.22em] text-red-400 uppercase">
            {running ? "Beast Active" : "Standby"} · On-Device
          </span>
        </div>
        {/* Decorative gold line */}
        <div className="w-full h-0.5 bg-gradient-to-r from-transparent via-amber-700/50 to-transparent" />
      </div>
    </header>
  );
}

function StatusOverlay({
  status,
  running,
  onStart,
}: {
  status: Status;
  running: boolean;
  onStart: () => void;
}) {
  if (running && status.kind === "ready") return null;

  return (
    <div className="absolute inset-0 grid place-items-center bg-black/70 backdrop-blur-sm z-30">
      {status.kind === "idle" && (
        <div className="flex flex-col items-center gap-6 px-6 text-center">
          <div className="float-emoji text-7xl select-none">🐅</div>
          <div>
            <h3 className="font-cinematic text-3xl text-gradient tracking-widest">BEAST MODE READY</h3>
            <p className="mt-2 max-w-xs text-sm text-gray-500 tracking-wide">
              Activate your camera to begin real-time emotion detection
            </p>
          </div>
          <button onClick={onStart} className="btn-leo rounded px-8 py-3 text-base">
            ▶ ACTIVATE NOW
          </button>
          <div className="flex gap-6 text-[10px] text-gray-700 tracking-widest uppercase">
            <span>🔒 No uploads</span>
            <span>⚡ On-device AI</span>
            <span>🎯 7 emotions</span>
          </div>
        </div>
      )}

      {status.kind === "loading-models" && (
        <div className="flex flex-col items-center gap-5 text-center">
          <div className="relative h-14 w-14">
            <div className="h-14 w-14 rounded-full border-2 border-red-900/40 border-t-red-500 spin-slow" />
            <div className="absolute inset-2 rounded-full border border-amber-800/30 border-t-amber-500/60 spin-slow" style={{ animationDirection: "reverse", animationDuration: "1.5s" }} />
          </div>
          <div>
            <p className="font-cinematic text-2xl text-red-400 tracking-[0.2em]">LOADING MODULES</p>
            <p className="mt-1 text-[11px] text-gray-600 tracking-widest">TinyFaceDetector · FaceExpressionNet</p>
          </div>
          <div className="w-56 h-1.5 overflow-hidden rounded-none bg-red-950/60 border border-red-900/30">
            <div
              className="progress-leo h-full"
              style={{ width: `${status.progress}%`, transition: "width 0.4s ease" }}
            />
          </div>
        </div>
      )}

      {status.kind === "requesting-camera" && (
        <div className="flex flex-col items-center gap-5 text-center">
          <div className="float-emoji text-6xl select-none">🎥</div>
          <div>
            <p className="font-cinematic text-2xl text-amber-500 tracking-[0.2em]">ACCESSING FEED</p>
            <p className="mt-1 text-xs text-gray-600 tracking-widest">Allow camera permission in your browser</p>
          </div>
        </div>
      )}

      {status.kind === "error" && (
        <div className="flex max-w-sm flex-col items-center gap-5 px-6 text-center">
          <div className="text-5xl">⚠️</div>
          <div>
            <p className="font-cinematic text-2xl text-red-500 tracking-widest">DETECTION FAILED</p>
            <p className="mt-2 text-xs text-gray-500">{status.message}</p>
          </div>
          <button onClick={onStart} className="rounded border border-red-700/60 bg-red-950/60 px-5 py-2 text-sm font-bold tracking-widest text-red-400 hover:bg-red-900/60 font-cinematic">
            ↺ RETRY
          </button>
        </div>
      )}
    </div>
  );
}

function DominantCard({
  dominant,
  faceBox,
  glowRgb,
}: {
  dominant: { key: EmotionKey; value: number } | null;
  faceBox: { w: number; h: number } | null;
  glowRgb: string;
}) {
  const meta = dominant ? EMOTION_META[dominant.key] : null;
  return (
    <div
      className="rounded-2xl glass p-5"
      style={{
        boxShadow: `0 0 0 1px rgba(${glowRgb}, 0.22), 0 20px 60px -20px rgba(${glowRgb}, 0.45)`,
        transition: "box-shadow 0.9s ease",
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <p className="text-[9px] font-bold tracking-[0.28em] uppercase text-red-600">
          ◈ Beast Emotion Scan
        </p>
        <span className="text-[9px] font-bold text-amber-700 tracking-[0.2em] uppercase">Real-time</span>
      </div>

      {dominant && meta ? (
        <div className="flex items-center gap-4">
          <div
            className="grid h-20 w-20 place-items-center rounded-xl text-5xl shrink-0 select-none"
            style={{
              background: `radial-gradient(circle at 40% 35%, rgba(${glowRgb}, 0.28), rgba(0,0,0,0.7))`,
              boxShadow: `0 0 28px rgba(${glowRgb}, 0.4), inset 0 0 20px rgba(${glowRgb}, 0.12)`,
              border: `1px solid rgba(${glowRgb}, 0.32)`,
              transition: "all 0.9s ease",
            }}
          >
            {meta.emoji}
          </div>
          <div className="flex-1">
            <div className={`font-cinematic text-4xl tracking-wider ${meta.color}`}>
              {meta.label.toUpperCase()}
            </div>
            {/* Power meter bar */}
            <div className="mt-2 h-2 w-full overflow-hidden bg-black/60 border border-white/5 rounded-sm">
              <div
                className={`h-full bg-gradient-to-r ${meta.bar} transition-[width] duration-300`}
                style={{
                  width: `${dominant.value * 100}%`,
                  boxShadow: `0 0 12px rgba(${glowRgb}, 0.8)`,
                }}
              />
            </div>
            <div className="mt-1.5 font-mono text-[11px] text-amber-700/80 tracking-wider">
              POWER: {(dominant.value * 100).toFixed(1)}%
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-4 rounded-xl bg-black/40 border border-red-900/25 p-4">
          <div className="text-4xl select-none float-emoji">🐅</div>
          <div>
            <p className="font-cinematic text-lg text-red-500/80 tracking-[0.18em]">TARGET SCAN INITIATED</p>
            <p className="mt-1 text-[11px] text-gray-700 tracking-wide">Position your face to begin detection</p>
          </div>
        </div>
      )}

      {faceBox && (
        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-red-900/25 pt-4">
          <div>
            <div className="text-[8px] font-bold tracking-[0.25em] text-gray-700 uppercase">Target Size</div>
            <div className="mt-1 font-mono text-sm text-amber-600">{Math.round(faceBox.w)} × {Math.round(faceBox.h)}px</div>
          </div>
          <div>
            <div className="text-[8px] font-bold tracking-[0.25em] text-gray-700 uppercase">Lock Status</div>
            <div className="mt-1 flex items-center gap-2 font-mono text-sm text-red-400">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500 pulse-red" />
              LOCKED ON
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmotionBars({ expressions }: { expressions: Record<EmotionKey, number> | null }) {
  const sorted = expressions
    ? (Object.entries(expressions) as [EmotionKey, number][]).sort((a, b) => b[1] - a[1])
    : null;

  return (
    <div className="rounded-2xl glass p-5">
      <div className="flex items-center justify-between mb-4">
        <p className="text-[9px] font-bold tracking-[0.28em] uppercase text-red-600">
          ◈ Emotion Power Levels
        </p>
        <span className="text-[9px] font-bold text-gray-700 tracking-widest">7 CLASSES</span>
      </div>

      <div className="space-y-2.5">
        {EMOTION_KEYS.map((key) => {
          const meta = EMOTION_META[key];
          const val = sorted ? (sorted.find(([k]) => k === key)?.[1] ?? 0) : 0;
          const pct = val * 100;
          const isTop = sorted && sorted[0][0] === key;
          return (
            <div key={key}>
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span className={`flex items-center gap-1.5 font-bold tracking-wider ${isTop ? "text-white" : "text-gray-600"}`}>
                  <span>{meta.emoji}</span>
                  <span className={isTop ? "font-cinematic text-sm" : ""}>{meta.label.toUpperCase()}</span>
                  {isTop && (
                    <span className="ml-1 rounded-sm bg-red-900/60 border border-red-700/50 px-1.5 py-0.5 text-[8px] font-bold tracking-widest text-red-400">
                      TOP
                    </span>
                  )}
                </span>
                <span className={`font-mono tabular-nums ${isTop ? "text-amber-500" : "text-gray-700"}`}>
                  {pct.toFixed(1)}%
                </span>
              </div>
              {/* Power meter */}
              <div className="h-1.5 w-full overflow-hidden bg-black/60 border border-white/5 rounded-none">
                <div
                  className={`h-full bg-gradient-to-r ${meta.bar} transition-[width] duration-500 ease-out`}
                  style={{
                    width: `${pct}%`,
                    boxShadow: isTop ? `0 0 10px rgba(${meta.rgb}, 0.7)` : undefined,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InfoCard() {
  return (
    <div className="rounded-2xl glass p-5">
      <p className="text-[9px] font-bold tracking-[0.28em] uppercase text-red-600 mb-4">◈ How It Works</p>
      <ul className="space-y-3 text-[12px] text-gray-500">
        <li className="flex gap-3">
          <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded bg-red-900/40 border border-red-800/50 text-[9px] font-bold text-red-400 font-cinematic">1</span>
          <span><span className="text-amber-600">TinyFaceDetector</span> neural network locates your face via WebGL in real-time.</span>
        </li>
        <li className="flex gap-3">
          <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded bg-red-900/40 border border-red-800/50 text-[9px] font-bold text-red-400 font-cinematic">2</span>
          <span>Face is analysed by <span className="text-amber-600">FaceExpressionNet</span> — outputs 7 emotion probabilities.</span>
        </li>
        <li className="flex gap-3">
          <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded bg-red-900/40 border border-red-800/50 text-[9px] font-bold text-red-400 font-cinematic">3</span>
          <span>Results overlaid in real-time. <span className="text-amber-600">No frame ever leaves your device.</span></span>
        </li>
      </ul>
    </div>
  );
}

// ------- Canvas helper -------
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
