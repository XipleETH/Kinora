import React, { useRef } from 'react';

// A touch/mouse friendly HSV color wheel: pick hue (angle) + saturation (radius) on
// the wheel, brightness on the slider. Replaces the native <input type="color">,
// which renders a poor picker inside the Reddit mobile app.

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

function hexToRgb(hex: string) {
  const h = (hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  const n = parseInt(full, 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r: number, g: number, b: number) {
  const to = (x: number) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0');
  return ('#' + to(r) + to(g) + to(b)).toUpperCase();
}
function rgbToHsv(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}
function hsvToRgb(h: number, s: number, v: number) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
function hsvToHex(h: number, s: number, v: number) {
  const { r, g, b } = hsvToRgb(h, s, v);
  return rgbToHex(r, g, b);
}

export const ColorWheelPicker: React.FC<{ value: string; onChange: (hex: string) => void }> = ({ value, onChange }) => {
  const wheelRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const rgb = hexToRgb(value || '#FF6B6B');
  const { h, s, v } = rgbToHsv(rgb.r, rgb.g, rgb.b);

  const pick = (clientX: number, clientY: number) => {
    const el = wheelRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const radius = rect.width / 2;
    const dx = clientX - rect.left - radius, dy = clientY - rect.top - radius;
    const dist = Math.min(radius, Math.hypot(dx, dy));
    const sat = radius ? dist / radius : 0;
    let hue = Math.atan2(dy, dx) * 180 / Math.PI + 90;
    hue = (hue + 360) % 360;
    onChange(hsvToHex(hue, sat, v || 1));
  };

  // Marker position in %, so the wheel can be any (responsive) size.
  const markerAngle = (h - 90) * Math.PI / 180;
  const leftPct = 50 + s * 50 * Math.cos(markerAngle);
  const topPct = 50 + s * 50 * Math.sin(markerAngle);
  const fullValHex = hsvToHex(h, s, 1);

  return (
    <div className="flex flex-col items-center gap-3 w-full max-w-[240px]">
      <div
        ref={wheelRef}
        onPointerDown={(e) => { dragging.current = true; try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {} pick(e.clientX, e.clientY); }}
        onPointerMove={(e) => { if (dragging.current) pick(e.clientX, e.clientY); }}
        onPointerUp={() => { dragging.current = false; }}
        onPointerCancel={() => { dragging.current = false; }}
        style={{
          width: 'min(72vw, 220px)', aspectRatio: '1', borderRadius: '50%', position: 'relative',
          touchAction: 'none', cursor: 'crosshair', border: '2px solid #000', boxShadow: '2px 2px 0 #000',
          background: 'radial-gradient(circle at center, #fff, rgba(255,255,255,0) 100%), conic-gradient(from 0deg, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))',
        }}
      >
        {/* brightness dim overlay */}
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#000', opacity: 1 - (v || 1), pointerEvents: 'none' }} />
        {/* selection marker */}
        <div style={{ position: 'absolute', left: `${leftPct}%`, top: `${topPct}%`, transform: 'translate(-50%,-50%)', width: 18, height: 18, borderRadius: '50%', border: '3px solid #fff', boxShadow: '0 0 0 2px #000', background: value, pointerEvents: 'none' }} />
      </div>

      {/* brightness slider */}
      <div className="w-full flex items-center gap-2">
        <span className="text-[10px] font-bold text-black/50">DARK</span>
        <input
          type="range" min={0} max={100} value={Math.round((v || 1) * 100)}
          onChange={(e) => onChange(hsvToHex(h, s, parseInt(e.target.value, 10) / 100))}
          aria-label="Brightness"
          className="flex-1 cursor-pointer h-2"
          style={{ accentColor: fullValHex }}
        />
        <span className="text-[10px] font-bold text-black/50">LIGHT</span>
      </div>

      {/* preview + hex readout */}
      <div className="flex items-center gap-2 w-full">
        <div className="w-8 h-8 rounded-md sketch-border shrink-0" style={{ background: value }} />
        <span className="text-xs font-mono font-bold text-black tracking-wide">{value}</span>
      </div>
    </div>
  );
};
