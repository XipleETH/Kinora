import React from 'react';
import { allBrushPresets, BrushPreset } from '../brushes';
import { ChevronLeft, ChevronRight, MoveUp, MoveDown, Save, Trash2, Undo2, Pencil, Eraser, PaintBucket, Clock } from 'lucide-react';

// Minimal clapperboard icons (open/closed) tailored for start/finalize actions
const ClapperOpen: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M3 11h18v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9Z" />
    <path d="m3 7 2.5 2M7 5l2.5 4M11 5l2.5 4M15 5l2.5 4M19 5l2 4" />
    <path d="M3 7V5a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .8.4L10 7" />
  </svg>
);
const ClapperClosed: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M3 10h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10Z" />
    <path d="M3 6h18v4H3z" />
    <path d="m5 6 2.5 4M9 6l2.5 4M13 6l2.5 4M17 6l2 4" />
  </svg>
);

export type PanelKey = 'actions' | 'tools' | 'brushSize' | 'brushMode' | 'palette';

interface SidePanelsProps {
  side: 'left' | 'right';
  toggleSide: () => void;
  order: PanelKey[];
  setOrder: (o: PanelKey[]) => void;
  // navigation
  // drawing related
  tool: 'draw' | 'erase' | 'fill';
  setTool: (t: 'draw' | 'erase' | 'fill') => void;
  brushSize: number;
  setBrushSize: (n: number) => void;
  brushSpacing?: number;
  setBrushSpacing?: (n: number) => void;
  brushOpacity?: number; // 0..1 override
  setBrushOpacity?: (n: number) => void;
  // (brush-related props removed)
  colors: string[];
  activeColor: string;
  setActiveColor: (c: string) => void;
  currentWeek: number;
  onSave: () => void;
  onClear: () => void;
  onUndo?: () => void;
  disabled?: boolean;
  // session controls
  timeLeft?: number; // seconds until window end
  // Lobby
  // lobbyToggleButton removed
  // Deprecated: lobby & external artist action button removed
  // New turn control callbacks & state
  onStartTurn?: () => void;
  onFinalizeTurn?: () => void;
  canStart?: boolean;
  isArtist?: boolean;
  currentArtist?: string | null;
  // Brush preset control
  brushPresetId?: string;
  setBrushPresetId?: (id: string) => void;
  // Allowed brushes gating (winners)
  allowedBrushIds?: string[];
}

const PanelWrapper: React.FC<{
  title: string;
  side: 'left' | 'right';
  onToggleSide: () => void;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  children: React.ReactNode;
}> = ({ title, side, onToggleSide, canUp, canDown, onUp, onDown, children }) => (
  <div className="sketch-border panel-hatch rounded-xl overflow-hidden flex flex-col">
  <div className="flex items-center justify-between px-2.5 py-1.5 border-b-2 border-black/70">
      <span className="text-white/90 text-[10px] font-semibold tracking-wide flex items-center gap-1">{title}</span>
      <div className="flex items-center gap-0.5">
  <button onClick={onUp} disabled={!canUp} className="p-1 rounded-md pencil-btn disabled:opacity-30" aria-label="Mover arriba">
          <MoveUp className="w-3 h-3" />
        </button>
  <button onClick={onDown} disabled={!canDown} className="p-1 rounded-md pencil-btn disabled:opacity-30" aria-label="Mover abajo">
          <MoveDown className="w-3 h-3" />
        </button>
  <button onClick={onToggleSide} className="p-1 rounded-md pencil-btn" aria-label="Cambiar lado" title="Cambiar lado">
          {side === 'right' ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  <div className="p-2.5 flex flex-col gap-2.5">{children}</div>
  </div>
);

export const SidePanels: React.FC<SidePanelsProps> = ({
  side,
  toggleSide,
  order,
  setOrder,
  tool,
  setTool,
  brushSize,
  setBrushSize,
  brushSpacing,
  setBrushSpacing,
  brushOpacity,
  setBrushOpacity,
  colors,
  activeColor,
  setActiveColor,
  currentWeek,
  onSave,
  onClear,
  onUndo,
  disabled,
  timeLeft,
  onStartTurn,
  onFinalizeTurn,
  canStart,
  isArtist,
  currentArtist,
  brushPresetId,
  setBrushPresetId,
  allowedBrushIds,
}) => {
  const move = (key: PanelKey, dir: -1 | 1) => {
    const idx = order.indexOf(key);
    const target = idx + dir;
    if (target < 0 || target >= order.length) return;
    const newOrder = [...order];
    const [k] = newOrder.splice(idx, 1);
    newOrder.splice(target, 0, k);
    setOrder(newOrder);
  };

  const renderPanel = (key: PanelKey, idx: number) => {
    const common = {
      side,
      onToggleSide: toggleSide,
      canUp: idx > 0,
      canDown: idx < order.length - 1,
      onUp: () => move(key, -1 as const),
      onDown: () => move(key, 1 as const),
    };


    if (key === 'actions') {
      return (
        <PanelWrapper key={key} title="Actions" {...common}>
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-center gap-2.5">
              {(() => {
                // Determine button state: finalize (artist), start (idle), wait (someone else is artist)
                const state: 'finalize' | 'start' | 'wait' = isArtist ? 'finalize' : (canStart ? 'start' : 'wait');
                const isDisabled = state === 'finalize' ? !!disabled : (state === 'wait');
                const onClick = () => {
                  if (isDisabled) return;
                  if (state === 'finalize' && onFinalizeTurn) return onFinalizeTurn();
                  if (state === 'start') return onStartTurn?.();
                };
                const aria = state === 'finalize' ? 'Finalize Turn' : state === 'start' ? 'Start Turn' : 'Wait Turn';
                const title = aria;
                // Background/border per state (static colors): finalize = solid black, wait = solid blue
                // Use ! to override base styles from pencil-btn if any
                const cls = state === 'wait'
                  ? '!bg-blue-600 hover:!bg-blue-600 cursor-not-allowed'
                  : state === 'finalize'
                    ? '!bg-black hover:!bg-black'
                    : 'bg-white hover:bg-white/90 border border-black/80';
                // Text/icon color per state
                const textCls = state === 'start' ? 'text-black' : 'text-white';
                // Focus ring color per state for contrast
                const ringCls = state === 'start' ? 'focus:ring-black/40' : 'focus:ring-white/50';
                const Icon = state === 'finalize' ? ClapperClosed : state === 'start' ? ClapperOpen : Clock;
                const iconCls = state === 'start' ? 'text-black' : 'text-white';
                return (
                  <button
                    onClick={onClick}
                    aria-label={aria}
                    title={title}
                    className={`p-2 rounded-full pencil-btn ${textCls} transition focus:outline-none focus:ring-2 ${ringCls} ${cls}`}
                    disabled={isDisabled}
                  >
                    <Icon className={`w-4 h-4 ${iconCls}`} />
                  </button>
                );
              })()}
              <button onClick={() => !disabled && onSave()} disabled={disabled} aria-label="Save Frame" className="p-2 rounded-full pencil-btn pencil-fill-emerald disabled:opacity-40 transition">
                <Save className="w-4 h-4" />
              </button>
              <button onClick={() => !disabled && onUndo?.()} disabled={disabled} aria-label="Undo" title="Undo" className="p-2 rounded-full pencil-btn pencil-fill-indigo disabled:opacity-40 transition">
                <Undo2 className="w-4 h-4" />
              </button>
              <button onClick={() => !disabled && onClear()} disabled={disabled} aria-label="Clear Canvas" className="p-2 rounded-full pencil-btn pencil-fill-red disabled:opacity-40 transition">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            {/* Hidden: timer and username moved to top bar; keep code for easy re-enable */}
            {false && typeof timeLeft === 'number' && (
              <div className="flex items-center justify-center gap-2 text-white/90 text-[11px] font-mono flex-wrap">
                <Clock className="w-4 h-4 text-white/80" />
                <span>{new Date((timeLeft as number) * 1000).toISOString().substring(11,19)}</span>
                <span className="text-white/60">|
                  <span className="ml-1 font-semibold text-white/90">{currentArtist ? currentArtist : '—'}</span>
                </span>
              </div>
            )}
          </div>
        </PanelWrapper>
      );
    }
    if (key === 'tools') {
      return (
        <PanelWrapper key={key} title="Tools" {...common}>
          <div className="flex flex-wrap gap-2 justify-center">
            {['draw', 'erase', 'fill'].map((t) => (
              <button
                key={t}
                onClick={() => setTool(t as any)}
                disabled={disabled}
                aria-label={t}
                title={t}
                className={`p-1.5 rounded-full pencil-btn transition flex items-center justify-center ${tool === t ? 'ring-2 ring-black' : ''} disabled:opacity-40`}
              >
                {t === 'draw' && <Pencil className="w-4 h-4" />}
                {t === 'erase' && <Eraser className="w-4 h-4" />}
                {t === 'fill' && <PaintBucket className="w-4 h-4" />}
              </button>
            ))}
          </div>
        </PanelWrapper>
      );
    }
    if (key === 'brushSize') {
      const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
      // Simple inline SVG icons for size (circle grow), spacing (dashed line), opacity (checker grid)
      const IconGrow = ({ className }: { className?: string }) => (
        <svg viewBox="0 0 24 24" className={className}><circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="2" fill="none" /></svg>
      );
      const IconShrink = ({ className }: { className?: string }) => (
        <svg viewBox="0 0 24 24" className={className}><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none" /><circle cx="12" cy="12" r="3" fill="currentColor" /></svg>
      );
      const IconSpacingMore = ({ className }: { className?: string }) => (
        <svg viewBox="0 0 24 24" className={className} stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M4 12h16" strokeDasharray="2 4" /></svg>
      );
      const IconSpacingLess = ({ className }: { className?: string }) => (
        <svg viewBox="0 0 24 24" className={className} stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M4 12h16" strokeDasharray="4 2" /></svg>
      );
      const IconOpacityHigh = ({ className }: { className?: string }) => (
        <svg viewBox="0 0 24 24" className={className} stroke="currentColor" strokeWidth="1.5" fill="none"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 12h16M12 4v16" opacity="0.6" /></svg>
      );
      const IconOpacityLow = ({ className }: { className?: string }) => (
        <svg viewBox="0 0 24 24" className={className} stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.6"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
      );
  const btnCls = "p-1 rounded-md pencil-btn disabled:opacity-30";
      return (
        <PanelWrapper key={key} title="Stroke" {...common}>
          <div className="flex flex-row justify-between gap-1">
            {/* Size column */}
            <div className="flex flex-col items-center gap-1 w-1/3">
              <button
                onClick={() => !disabled && setBrushSize(clamp(brushSize + 2, 1, 50))}
                disabled={disabled}
                className={btnCls}
                aria-label="Increase size"
                title="Increase size"
              >
                <IconGrow className="w-4 h-4" />
              </button>
              <input
                type="range"
                min={1}
                max={50}
                step={1}
                value={brushSize}
                disabled={disabled}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                className="h-12 w-1 accent-white/80 cursor-pointer rotate-180"
                aria-label="Brush size"
                style={{ writingMode: 'vertical-lr' }}
              />
              <button
                onClick={() => !disabled && setBrushSize(clamp(brushSize - 2, 1, 50))}
                disabled={disabled}
                className={btnCls}
                aria-label="Decrease size"
                title="Decrease size"
              >
                <IconShrink className="w-4 h-4" />
              </button>
              {/** numeric label removed per request */}
            </div>
            {/* Spacing column */}
            {setBrushSpacing && (
              <div className="flex flex-col items-center gap-1 w-1/3">
                <button
                  onClick={() => !disabled && setBrushSpacing(clamp((brushSpacing ?? 4) + 1, 1, 30))}
                  disabled={disabled}
                  className={btnCls}
                  aria-label="Increase spacing"
                  title="Increase spacing"
                >
                  <IconSpacingMore className="w-4 h-4" />
                </button>
                <input
                  type="range"
                  min={1}
                  max={30}
                  step={1}
                  value={brushSpacing ?? 4}
                  disabled={disabled}
                  onChange={(e) => setBrushSpacing(Number(e.target.value))}
                  className="h-12 w-1 accent-white/80 cursor-pointer rotate-180"
                  aria-label="Brush spacing"
                  style={{ writingMode: 'vertical-lr' }}
                />
                <button
                  onClick={() => !disabled && setBrushSpacing(clamp((brushSpacing ?? 4) - 1, 1, 30))}
                  disabled={disabled}
                  className={btnCls}
                  aria-label="Decrease spacing"
                  title="Decrease spacing"
                >
                  <IconSpacingLess className="w-4 h-4" />
                </button>
                {/** numeric label removed per request */}
              </div>
            )}
            {/* Opacity column */}
            {setBrushOpacity && (
              <div className="flex flex-col items-center gap-1 w-1/3">
                <button
                  onClick={() => {
                    if (disabled) return; const current = brushOpacity ?? 1; const next = clamp(current + 0.05, 0.05, 1); setBrushOpacity(next);
                  }}
                  disabled={disabled}
                  className={btnCls}
                  aria-label="Increase opacity"
                  title="Increase opacity"
                >
                  <IconOpacityHigh className="w-4 h-4" />
                </button>
                <input
                  type="range"
                  min={5}
                  max={100}
                  step={1}
                  value={Math.round((brushOpacity ?? 1) * 100)}
                  disabled={disabled}
                  onChange={(e) => setBrushOpacity(Number(e.target.value) / 100)}
                  className="h-12 w-1 accent-white/80 cursor-pointer rotate-180"
                  aria-label="Brush opacity"
                  style={{ writingMode: 'vertical-lr' }}
                />
                <button
                  onClick={() => {
                    if (disabled) return; const current = brushOpacity ?? 1; const next = clamp(current - 0.05, 0.05, 1); setBrushOpacity(next);
                  }}
                  disabled={disabled}
                  className={btnCls}
                  aria-label="Decrease opacity"
                  title="Decrease opacity"
                >
                  <IconOpacityLow className="w-4 h-4" />
                </button>
                {/** numeric label removed per request */}
              </div>
            )}
          </div>
        </PanelWrapper>
      );
    }
    if (key === 'brushMode') {
      // Only show first 4 allowed/ default brush presets as icon-only buttons
      const defaultIds = ['ink','acrylic-paint','watercolor-wash','airbrush'];
      const ids = (allowedBrushIds && allowedBrushIds.length > 0 ? allowedBrushIds : defaultIds).slice(0,4);
      const presets: BrushPreset[] = allBrushPresets.filter(p => ids.includes(p.id));
      const InkIcon = ({ active }: { active: boolean }) => (
        <svg viewBox="0 0 24 24" className="w-5 h-5" stroke="black" fill="none" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: active ? 1 : 0.85 }}>
          <path d="M5 19c4-1 7-4 9-8 1-2 2-4 2-6" />
          <path d="M15 5c0 2-1.2 3.2-2.4 4.4C10.8 11.2 9 13 8 16l-.7 2.1" />
          <path d="M4 21h16" />
        </svg>
      );
      const AcrilicoIcon = ({ active }: { active: boolean }) => (
        <svg viewBox="0 0 24 24" className="w-5 h-5" stroke="black" fill="none" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: active ? 1 : 0.8 }}>
          {/* Stylized flat brush with bristles */}
          <path d="M4 20h16" />
          <path d="M6 14h12l-1.5 4h-9z" />
          <path d="M8 4h8l2 6H6z" />
        </svg>
      );
      const AirbrushIcon = ({ active }: { active: boolean }) => (
        <svg viewBox="0 0 24 24" className="w-5 h-5" stroke="black" fill="none" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: active ? 1 : 0.85 }}>
          {/* Airbrush nozzle with diffuse spray dots */}
          <path d="M5 18h4l2-4" />
          <path d="M9 10h6l2 4H11z" />
          <path d="M13 6h-4l-1 4" />
          {/* Spray particles */}
          <circle cx="17" cy="6" r="0.8" />
          <circle cx="19" cy="5" r="0.7" />
          <circle cx="18.5" cy="7.5" r="0.6" />
          <circle cx="20.2" cy="6.8" r="0.5" />
          <circle cx="21" cy="5.8" r="0.4" />
        </svg>
      );
      const AcuarelaIcon = ({ active }: { active: boolean }) => (
        <svg viewBox="0 0 24 24" className="w-5 h-5" stroke="black" fill="none" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: active ? 1 : 0.8 }}>
          {/* Droplet + soft stroke */}
          <path d="M12 3c-2.5 3-4 5.5-4 7.5A4 4 0 0 0 12 15a4 4 0 0 0 4-4.5C16 8.5 14.5 6 12 3Z" />
          <path d="M5 19c4-1.2 10-.8 14 0" />
        </svg>
      );
      const LapiceroIcon = ({ active }: { active: boolean }) => (
        <svg viewBox="0 0 24 24" className="w-5 h-5" stroke="black" fill="none" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: active ? 1 : 0.8 }}>
          {/* Ballpoint pen silhouette */}
          <path d="M5 16 14.5 6.5a2.2 2.2 0 0 1 3 3L8 19l-4 1 1-4Z" />
          <path d="m14.5 6.5 3 3" />
          <path d="M11 21h2" />
        </svg>
      );
      const MarkerIcon = ({ active }: { active: boolean }) => (
        <svg viewBox="0 0 24 24" className="w-5 h-5" stroke="black" fill="none" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: active ? 1 : 0.8 }}>
          <path d="M4 20h16" />
          <path d="M7 16 15.5 4.5a2.1 2.1 0 0 1 3 2.9L11 19l-4 1 1-4Z" />
        </svg>
      );
      const CharcoalIcon = ({ active }: { active: boolean }) => (
        <svg viewBox="0 0 24 24" className="w-5 h-5" stroke="black" fill="none" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: active ? 1 : 0.8 }}>
          <path d="M5 19c2.5-1.2 5-2.4 7.2-5.2 1.8-2.2 2.8-4.4 3.3-6.5" />
          <path d="M9 18c1.2-.6 2.4-1.3 3.5-2.4 2.4-2.3 3.8-5.3 4.3-8.1" />
          <path d="M4 21h16" />
        </svg>
      );
      return (
        <PanelWrapper key={key} title="Brushes" {...common}>
          <div className="flex flex-nowrap gap-2 justify-between">
            {presets.map(p => {
              const active = p.id === brushPresetId;
              const Icon = p.id === 'ink'
                ? InkIcon
                : p.id === 'acrylic-paint'
                  ? AcrilicoIcon
                  : p.id === 'watercolor-wash'
                    ? AcuarelaIcon
                    : p.id === 'pencil'
                      ? LapiceroIcon
                      : p.id === 'airbrush'
                        ? AirbrushIcon
                        : p.id === 'marker'
                          ? MarkerIcon
                          : CharcoalIcon;
              return (
                <button
                  key={p.id}
                  disabled={disabled}
                  onClick={() => {
                    setBrushPresetId?.(p.id);
                    setBrushSize(p.size);
                    if (setBrushSpacing) setBrushSpacing(p.spacing ?? 4);
                    if (setBrushOpacity) setBrushOpacity(p.opacity ?? 1);
                  }}
                  className={`p-1 rounded-full pencil-btn flex items-center justify-center transition ${active ? 'ring-2 ring-black' : ''} disabled:opacity-40`}
                  aria-label={p.name}
                  title={p.name}
                >
                  <Icon active={active} />
                </button>
              );
            })}
          </div>
        </PanelWrapper>
      );
    }
    return (
      <PanelWrapper key={key} title={`Palette W${currentWeek}`} {...common}>
        <div className="grid grid-cols-3 gap-2 justify-items-center">
          {colors.map((color) => {
            const active = activeColor === color;
            return (
              <button
                key={color}
                onClick={() => setActiveColor(color)}
                className={`palette-swatch w-8 h-8 rounded-full relative transition-all duration-200 focus:outline-none hover:scale-110 ${active ? 'scale-110 ring-2 ring-black' : ''}`}
                style={{ backgroundColor: color }}
                title={color}
              >
                {active && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="w-2 h-2 bg-white rounded-full mix-blend-overlay" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </PanelWrapper>
    );
  };

  return <div className={`w-44 shrink-0 flex flex-col gap-3 ${side === 'right' ? '' : ''}`}>{order.map((k, idx) => renderPanel(k, idx))}</div>;
};
