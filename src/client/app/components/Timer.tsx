import React from 'react';
import { Clock, Play } from 'lucide-react';

interface TimerProps {
  timeLeft: number;
  isActive: boolean;
  onStart: () => void;
  compact?: boolean;
  orientation?: 'horizontal' | 'vertical';
  showProgress?: boolean;
}

export const Timer: React.FC<TimerProps> = ({ timeLeft, isActive, onStart, compact = false, orientation = 'horizontal', showProgress = true }) => {
  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getProgressPercentage = () => {
    return ((7200 - timeLeft) / 7200) * 100;
  };

  const baseTextColor = timeLeft < 300 && isActive ? 'text-red-400 animate-pulse' : 'text-white';
  const isVertical = orientation === 'vertical';

  if (compact) {
    return (
      <div className={`flex ${isVertical ? 'flex-col items-center gap-2' : 'items-center gap-3'}`}>
        <div className={`flex ${isVertical ? 'flex-col items-center gap-0' : 'items-center gap-2'}`}>
          <Clock className={`${isVertical ? 'w-4 h-4' : 'w-5 h-5'} text-white`} />
          {isVertical ? (
            <div className="flex flex-col items-center" aria-label={formatTime(timeLeft)}>
              <span className={`font-mono font-semibold ${baseTextColor} text-base leading-none`}>{Math.floor(timeLeft / 3600).toString().padStart(2, '0')}</span>
              <span className={`font-mono font-semibold ${baseTextColor} text-base leading-none`}>{Math.floor((timeLeft % 3600) / 60).toString().padStart(2, '0')}</span>
              <span className={`font-mono font-semibold ${baseTextColor} text-base leading-none`}>{(timeLeft % 60).toString().padStart(2, '0')}</span>
            </div>
          ) : (
            <span className={`text-base font-mono font-semibold ${baseTextColor}`}>{formatTime(timeLeft)}</span>
          )}
        </div>
        {!isActive && timeLeft > 0 && (
          <button
            onClick={onStart}
            className={`flex items-center justify-center ${isVertical ? 'w-8 h-8' : 'px-3 py-1.5'} bg-green-500 hover:bg-green-600 text-white rounded-full transition-colors`}
            title="Start Session"
            aria-label="Start Session"
          >
            <Play className="w-4 h-4" />
            {!isVertical && <span className="ml-2 text-sm">Start</span>}
          </button>
        )}
  {showProgress && isActive && (
          <div className={`${isVertical ? 'w-16' : 'w-24'} bg-white/20 rounded-full h-1.5`}>
            <div
              className="bg-gradient-to-r from-green-400 to-blue-500 h-1.5 rounded-full transition-all duration-1000"
              style={{ width: `${getProgressPercentage()}%` }}
            />
          </div>
        )}
        {timeLeft === 0 && (
          <span className="text-red-400 font-medium text-xs">Session Ended</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center space-x-4">
      <div className="flex items-center space-x-2">
        <Clock className="w-5 h-5 text-white" />
        <span className={`text-xl font-mono font-bold ${baseTextColor}`}>
          {formatTime(timeLeft)}
        </span>
      </div>
      {!isActive && timeLeft > 0 && (
        <button
          onClick={onStart}
          className="flex items-center space-x-2 bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-lg transition-colors"
        >
          <Play className="w-4 h-4" />
          <span>Start Session</span>
        </button>
      )}
  {showProgress && isActive && (
        <div className="w-32 bg-white/20 rounded-full h-2">
          <div
            className="bg-gradient-to-r from-green-400 to-blue-500 h-2 rounded-full transition-all duration-1000"
            style={{ width: `${getProgressPercentage()}%` }}
          />
        </div>
      )}
      {timeLeft === 0 && (
        <span className="text-red-400 font-semibold">Session Ended</span>
      )}
    </div>
  );
};