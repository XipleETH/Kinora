import React from 'react';
import { Palette, Play, Image, Vote, MessageCircle, ChevronRight } from 'lucide-react';

interface HeaderProps {
  currentView: 'draw' | 'gallery' | 'video' | 'voting' | 'chat';
  setCurrentView: (view: 'draw' | 'gallery' | 'video' | 'voting' | 'chat') => void;
}

export const Header: React.FC<HeaderProps> = ({ currentView, setCurrentView }) => {
  const LogoKinora: React.FC<{ className?: string }> = ({ className }) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Film negative frame */}
      <rect x="2" y="3" width="20" height="18" rx="2.2" ry="2.2" stroke="currentColor" strokeWidth="1.8" fill="none"/>
      {/* Perforations top */}
      <g fill="currentColor" opacity="0.9">
        <rect x="4" y="4.2" width="1.1" height="1.1" rx="0.2" />
        <rect x="7" y="4.2" width="1.1" height="1.1" rx="0.2" />
        <rect x="10" y="4.2" width="1.1" height="1.1" rx="0.2" />
        <rect x="13" y="4.2" width="1.1" height="1.1" rx="0.2" />
        <rect x="16" y="4.2" width="1.1" height="1.1" rx="0.2" />
        <rect x="19" y="4.2" width="1.1" height="1.1" rx="0.2" />
      </g>
      {/* Perforations bottom */}
      <g fill="currentColor" opacity="0.9">
        <rect x="4" y="18.7" width="1.1" height="1.1" rx="0.2" />
        <rect x="7" y="18.7" width="1.1" height="1.1" rx="0.2" />
        <rect x="10" y="18.7" width="1.1" height="1.1" rx="0.2" />
        <rect x="13" y="18.7" width="1.1" height="1.1" rx="0.2" />
        <rect x="16" y="18.7" width="1.1" height="1.1" rx="0.2" />
        <rect x="19" y="18.7" width="1.1" height="1.1" rx="0.2" />
      </g>
      {/* Inside: hand drawing motif (minimal) */}
      {/* Drawn stroke */}
      <path d="M5.8 13.2 C7.6 11.6 9.2 10.9 11.1 11.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* Pencil */}
      <path d="M13.2 10.8 L17.6 14.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M17.6 14.2 L16.9 13.1 L16.3 13.7 Z" fill="currentColor" />
      {/* Hand arc suggesting knuckles gripping pencil */}
      <path d="M12.6 11.9 C12.0 12.6 11.3 13.3 10.8 13.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  );
  const navigation = [
    { key: 'draw', label: 'Draw', icon: Palette },
    { key: 'gallery', label: 'Gallery', icon: Image },
    { key: 'video', label: 'Video', icon: Play },
    { key: 'voting', label: 'Vote', icon: Vote },
    { key: 'chat', label: 'Chat', icon: MessageCircle }
  ] as const;

  return (
    <aside
      className="fixed top-0 left-0 h-screen w-[60px] hidden md:flex flex-col bg-[#FAF3E0] panel-hatch border-r-2 border-black shadow-xl z-40 overflow-hidden"
    >
      <div className="flex items-center justify-center px-2 py-4 select-none border-b-2 border-black">
        <div className="w-9 h-9 bg-gradient-to-tr from-purple-500 via-fuchsia-500 to-pink-500 rounded-xl flex items-center justify-center shadow-inner flex-shrink-0 border-2 border-black">
          <LogoKinora className="w-5 h-5 text-white" />
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-4 flex flex-col gap-2">
        {navigation.map(({ key, label, icon: Icon }) => {
          const active = currentView === key;
          return (
            <button
              key={key}
              onClick={() => setCurrentView(key as any)}
              title={label}
              style={active ? { backgroundColor: '#FDE047' } : undefined}
              className="pencil-btn flex items-center justify-center rounded-md py-2 outline-none focus:ring-2 focus:ring-black/40"
              aria-label={label}
            >
              <Icon className="w-5 h-5 flex-shrink-0 text-black" />
            </button>
          );
        })}
      </nav>
      <div className="px-2 py-3 text-[10px] text-black/40 border-t-2 border-black font-mono tracking-wide flex items-center justify-center gap-1">
        <ChevronRight className="w-3 h-3 text-black/40" />
      </div>
    </aside>
  );
};