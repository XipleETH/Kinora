import React, { useEffect, useRef, useState } from 'react';
import { Frame } from '../App';

interface WeekVideoProps {
  frames: Frame[]; // frames belonging to a single week, chronological ascending
  fps?: number;
  autoPlay?: boolean;
  loop?: boolean;
  title?: string;
}

export const WeekVideo: React.FC<WeekVideoProps> = ({ frames, fps = 12, autoPlay = true, loop = true, title }) => {
  const [index,setIndex] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(()=>{
    if(!autoPlay || frames.length===0) return; 
    if(timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(()=>{
      setIndex(i=>{
        const next = i+1; 
        if(next >= frames.length) return loop ? 0 : i; 
        return next; 
      });
    }, 1000/fps);
    return ()=>{ if(timerRef.current) window.clearInterval(timerRef.current); };
  },[autoPlay, fps, frames.length, loop]);

  const current = frames[index];
  return (
    <div className="flex flex-col items-center">
      {title && <div className="text-white/80 text-xs mb-1">{title}</div>}
  <div className="relative aspect-[480/640] bg-black/40 rounded-2xl overflow-hidden border border-white/20 flex items-center justify-center w-[220px] sm:w-[260px] md:w-[300px] lg:w-[340px] xl:w-[380px] transition-shadow shadow-[0_0_0_0_rgba(255,255,255,0.1)] hover:shadow-[0_0_0_3px_rgba(255,255,255,0.15)]">
        {current && <img src={current.imageData} alt="week frame" className="object-contain max-w-full max-h-full" />}
        {frames.length===0 && <div className="text-white/30 text-xs">No frames</div>}
      </div>
  <div className="mt-2 text-[11px] text-white/60">{frames.length} f</div>
    </div>
  );
};
