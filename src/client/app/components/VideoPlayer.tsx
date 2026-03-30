import React, { useMemo, useState } from 'react';
import { Frame } from '../App';
import { WeekVideo } from './WeekVideo';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface VideoPlayerProps { frames: Frame[]; }

// Group frames by paletteWeek (placeholder property)
export const VideoPlayer: React.FC<VideoPlayerProps> = ({ frames }) => {
  const groups = useMemo(()=>{
    const map = new Map<number, Frame[]>();
    for(const f of frames){
      const arr = map.get(f.paletteWeek) || [];
      arr.push(f);
      map.set(f.paletteWeek, arr);
    }
    const list = Array.from(map.entries()).map(([week, arr])=>({ week, frames: arr.sort((a,b)=>a.timestamp-b.timestamp) }));
    list.sort((a,b)=>a.week-b.week);
    return list;
  },[frames]);
  const currentWeek = groups.length? groups[groups.length-1].week : 1;
  const [focusWeek,setFocusWeek] = useState<number>(currentWeek);
  const weekIndex = groups.findIndex(g=>g.week===focusWeek);
  const prev = weekIndex>0? groups[weekIndex-1]: null;
  const current = weekIndex>=0? groups[weekIndex]: null;
  const next = (weekIndex>=0 && weekIndex < groups.length-1)? groups[weekIndex+1]: null;
  const recentWeeks = groups.slice(-8); // bottom selector (up to 8)
  if(groups.length===0){
    return <div className="text-center py-12 text-white/60">No frames yet</div>;
  }
  return (
    <div className="space-y-6">
      <h2 className="text-center text-3xl font-bold text-white">Weekly Carousel</h2>
      <div className="flex items-center justify-center gap-4">
        <button onClick={()=> prev && setFocusWeek(prev.week)} disabled={!prev} className={`p-2 rounded-full border border-white/20 text-white/70 hover:text-white hover:bg-white/10 ${!prev? 'opacity-30 cursor-not-allowed':''}`}><ChevronLeft className="w-5 h-5"/></button>
        <div className="flex gap-8 flex-wrap justify-center max-w-full">
          {prev && <WeekVideo frames={prev.frames} title={`Week ${prev.week}`}/>} 
          {current && <WeekVideo frames={current.frames} title={`Week ${current.week}`}/>} 
          {next && <WeekVideo frames={next.frames} title={`Week ${next.week}`}/>}
        </div>
        <button onClick={()=> next && setFocusWeek(next.week)} disabled={!next} className={`p-2 rounded-full border border-white/20 text-white/70 hover:text-white hover:bg-white/10 ${!next? 'opacity-30 cursor-not-allowed':''}`}><ChevronRight className="w-5 h-5"/></button>
      </div>
      <div className="pt-2">
        <div className="flex flex-wrap gap-2 justify-center">
          {recentWeeks.map(g=> (
            <button key={g.week} onClick={()=>setFocusWeek(g.week)} className={`px-3 py-1 rounded-full text-xs border transition ${g.week===focusWeek? 'bg-white/30 text-white border-white/60':'bg-white/10 text-white/70 border-white/20 hover:bg-white/20'}`}>Week {g.week}<span className="ml-1 text-white/50">({g.frames.length})</span></button>
          ))}
        </div>
      </div>
    </div>
  );
};