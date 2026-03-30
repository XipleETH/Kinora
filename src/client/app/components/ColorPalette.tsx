import React from 'react';
import { Palette, ChevronLeft, ChevronRight, Save, Trash2, Brush, Droplet, Wind, Sparkles } from 'lucide-react';

interface ColorPaletteProps {
  colors: string[];
  activeColor: string;
  setActiveColor: (color: string) => void;
  currentWeek: number;
  side?: 'left' | 'right';
  onToggleSide?: () => void;
  variant?: 'floating' | 'sidebar';
  brushSize: number;
  setBrushSize: (n: number) => void;
  disabled?: boolean;
  brushMode: 'solid' | 'soft' | 'fade' | 'spray';
  setBrushMode: (m: 'solid' | 'soft' | 'fade' | 'spray') => void;
  onSave?: () => void;
  onClear?: () => void;
}

export const ColorPalette: React.FC<ColorPaletteProps> = ({
  colors,
  activeColor,
  setActiveColor,
  currentWeek,
  side = 'right',
  onToggleSide,
  variant = 'sidebar',
  brushSize,
  setBrushSize,
  disabled,
  brushMode,
  setBrushMode,
  onSave,
  onClear
}) => {

  const basePanel = (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-1 text-white/90">
          <Palette className="w-4 h-4" />
          <span className="font-semibold text-[11px] tracking-wide">W{currentWeek}</span>
        </div>
        {onToggleSide && (
          <button
            onClick={onToggleSide}
            className="p-1 rounded-md bg-white/10 hover:bg-white/30 transition text-white"
            title="Mover al otro lado"
          >
            {side === 'right' ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        )}
      </div>
      <div className="p-3 overflow-y-auto max-h-[80vh] space-y-5">
        {/* Actions */}
        {(onSave || onClear) && (
          <div className="flex flex-col gap-2 bg-white/10 rounded-lg p-2">
            <span className="text-white/70 text-xs font-semibold tracking-wide">Actions</span>
            <div className="flex items-center gap-3 justify-center">
              {onSave && (
                <button
                  onClick={() => !disabled && onSave()}
                  disabled={disabled}
                  aria-label="Save Frame"
                  title="Save Frame"
                  className="p-2 rounded-full bg-emerald-500/70 hover:bg-emerald-500 text-white disabled:opacity-40 transition"
                >
                  <Save className="w-4 h-4" />
                </button>
              )}
              {onClear && (
                <button
                  onClick={() => !disabled && onClear()}
                  disabled={disabled}
                  aria-label="Clear Canvas"
                  title="Clear Canvas"
                  className="p-2 rounded-full bg-red-500/70 hover:bg-red-500 text-white disabled:opacity-40 transition"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2 bg-white/10 rounded-lg p-2">
          <span className="text-white/70 text-xs font-semibold tracking-wide">Brush Size</span>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => !disabled && setBrushSize(Math.max(1, brushSize - 2))}
              disabled={disabled}
              aria-label="Decrease brush size"
              className="px-2 py-1 text-xs rounded-md bg-white/15 hover:bg-white/30 text-white disabled:opacity-40"
            >-</button>
            <span className="text-white font-mono text-sm w-10 text-center select-none">{brushSize}</span>
            <button
              onClick={() => !disabled && setBrushSize(Math.min(50, brushSize + 2))}
              disabled={disabled}
              aria-label="Increase brush size"
              className="px-2 py-1 text-xs rounded-md bg-white/15 hover:bg-white/30 text-white disabled:opacity-40"
            >+</button>
          </div>
          <div className="flex justify-center py-1">
            <div
              className="rounded-full border border-white/50 shadow-sm"
              style={{
                width: `${Math.max(8, Math.min(34, brushSize))}px`,
                height: `${Math.max(8, Math.min(34, brushSize))}px`,
                backgroundColor: activeColor,
                transition: 'width .15s ease, height .15s ease'
              }}
            />
          </div>
          <input
            type="range"
            min={1}
            max={50}
            value={brushSize}
            disabled={disabled}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="w-full h-1 accent-white/80 cursor-pointer"
          />
        </div>
        <div className="flex flex-col gap-2 bg-white/10 rounded-lg p-2">
          <span className="text-white/70 text-xs font-semibold tracking-wide">Brushes</span>
          <div className="flex flex-wrap gap-3 justify-center">
            {[
              { key: 'solid', icon: <Brush className="w-4 h-4" />, label: 'Solid' },
              { key: 'soft', icon: <Droplet className="w-4 h-4" />, label: 'Soft' },
              { key: 'fade', icon: <Wind className="w-4 h-4" />, label: 'Fade' },
              { key: 'spray', icon: <Sparkles className="w-4 h-4" />, label: 'Spray' }
            ].map(m => (
              <button
                key={m.key}
                onClick={() => setBrushMode(m.key as any)}
                disabled={disabled}
                aria-label={m.label}
                title={m.label}
                className={`p-2 rounded-full border transition flex items-center justify-center ${
                  brushMode === m.key
                    ? 'bg-white/30 border-white/60 text-white'
                    : 'bg-white/10 border-white/20 text-white/70 hover:bg-white/20'
                } disabled:opacity-40`}
              >
                {m.icon}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 justify-items-center">
          {colors.map(color => {
            const active = activeColor === color;
            return (
              <button
                key={color}
                onClick={() => setActiveColor(color)}
                className={`w-10 h-10 rounded-full relative transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-white/70 shadow-sm hover:scale-110 ${
                  active ? 'ring-4 ring-white/70 scale-110' : 'ring-2 ring-white/10'
                }`}
                style={{ backgroundColor: color }}
                title={color}
              >
                {active && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="w-2.5 h-2.5 bg-white rounded-full mix-blend-overlay" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  if (variant === 'sidebar') {
    return (
      <aside
        className={`w-40 shrink-0 bg-white/15 backdrop-blur-xl border border-white/20 rounded-2xl shadow-lg h-fit max-h-[80vh] flex flex-col`}
      >
        {basePanel}
      </aside>
    );
  }
  return null;
};