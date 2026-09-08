import React, { useEffect, useState } from 'react';

interface RealtimeProgressProps {
  current: number;
  total: number;
  title?: string;
  statusMessage?: string;
  isProcessing?: boolean;
}

export const RealtimeProgress: React.FC<RealtimeProgressProps> = ({
  current,
  total,
  title = "Real-Time Neural Engine Progress",
  statusMessage,
  isProcessing = true
}) => {
  const [smoothPercentage, setSmoothPercentage] = useState(0);

  useEffect(() => {
    if (!isProcessing) {
      setSmoothPercentage(0);
      return;
    }

    let targetPct = 0;
    if (total > 0) {
      targetPct = Math.min(100, Math.max(5, Math.round((current / total) * 100)));
    } else {
      targetPct = 15;
    }

    setSmoothPercentage(targetPct);
  }, [current, total, isProcessing]);

  if (!isProcessing) return null;

  // Determine stage label
  let stageLabel = statusMessage;
  if (!stageLabel) {
    if (total > 0) {
      if (current === 0) stageLabel = "Initializing Neural Audio Engine & Decoding Input...";
      else if (current < total) stageLabel = `Synthesizing Audio Segment ${current} of ${total}...`;
      else stageLabel = "Merging Segment PCM Buffers & Encoding Lossless MP3...";
    } else {
      stageLabel = "Connecting to Neural Processing Stream...";
    }
  }

  return (
    <div className="w-full bg-gradient-to-br from-black/80 via-[#06140e]/90 to-black/80 border border-emerald-500/30 rounded-2xl p-4 shadow-[0_0_25px_rgba(16,185,129,0.15)] backdrop-blur-xl space-y-3 animate-fade-in my-3">
      
      {/* Header Info */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="relative flex h-3 w-3 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
          </span>
          <div className="min-w-0">
            <h4 className="text-xs font-bold text-emerald-400 uppercase tracking-wider truncate">
              {title}
            </h4>
            <p className="text-[11px] text-gray-300 truncate font-medium mt-0.5">
              {stageLabel}
            </p>
          </div>
        </div>

        {/* Digital Percentage Counter */}
        <div className="flex flex-col items-end flex-shrink-0">
          <span className="text-lg font-black text-white tracking-tight drop-shadow-[0_0_8px_rgba(16,185,129,0.5)] font-mono">
            {smoothPercentage}%
          </span>
          <span className="text-[10px] text-gray-400 uppercase tracking-widest font-semibold">
            {total > 0 ? `${current} / ${total} Chunks` : 'Live Stream'}
          </span>
        </div>
      </div>

      {/* Progress Track */}
      <div className="w-full bg-black/60 border border-white/10 rounded-full h-3.5 p-0.5 relative overflow-hidden shadow-inner">
        {/* Animated Fill Bar */}
        <div
          className="bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-300 h-full rounded-full transition-all duration-500 ease-out shadow-[0_0_12px_rgba(16,185,129,0.6)] relative overflow-hidden"
          style={{ width: `${smoothPercentage}%` }}
        >
          {/* Shimmer Effect */}
          <div className="absolute inset-0 w-full h-full bg-[linear-gradient(90deg,transparent_0%,rgba(255,255,255,0.4)_50%,transparent_100%)] animate-pulse" />
        </div>
      </div>

      {/* Footer Meter & Audio Wave Animation */}
      <div className="flex items-center justify-between text-[10px] text-gray-400 pt-0.5 font-medium">
        <div className="flex items-center gap-1.5 text-emerald-400/80">
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span>Real-time Neural Audio Pipeline</span>
        </div>

        <div className="flex items-center gap-1">
          {[40, 80, 50, 90, 60].map((h, idx) => (
            <div
              key={idx}
              className="w-0.5 bg-emerald-400 rounded-full animate-pulse"
              style={{
                height: `${h / 7}px`,
                animationDelay: `${idx * 0.15}s`
              }}
            />
          ))}
        </div>
      </div>

    </div>
  );
};
