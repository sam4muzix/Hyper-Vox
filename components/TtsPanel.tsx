import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Dialect, Emotion, SpeechPacing, VoiceGender, VoiceOption } from '../types';
import { generateSpotAudio, clearAudioCache, optimizeScript } from '../services/geminiService';
import { logGenerationToFirestore } from '../services/firebaseService';
import { getBrandFilename } from '../utils/audio';
import { RealtimeProgress } from './RealtimeProgress';
import { SpeechToTextDictation } from './SpeechToTextDictation';
import { CustomSelect, SelectOption } from './CustomSelect';

const DIALECT_OPTIONS: SelectOption[] = [
  { value: Dialect.CHENNAI_TAMIL, label: 'Chennai Tamil (Local Style)', sublabel: 'Colloquial Madras Bashai regional dialect' },
  { value: Dialect.CLASSIC_TAMIL, label: 'Classic Tamil (Formal Style)', sublabel: 'Traditional formal Senthamizh' },
  { value: Dialect.INDIAN_ENGLISH, label: 'Indian English (Urban)', sublabel: 'Standard Indian accent' },
  { value: Dialect.REGULAR_ENGLISH, label: 'Regular English (Neutral)', sublabel: 'Neutral international English' },
];

const AVAILABLE_VOICES: VoiceOption[] = [
  { id: 'm_chennai_1', name: 'Arjun - Chennai Gethu', gender: VoiceGender.MALE, apiVoiceName: 'Puck', persona: 'Bold, street-smart Chennai local male' },
  { id: 'f_classic_1', name: 'Anitha - Formal Tamil', gender: VoiceGender.FEMALE, apiVoiceName: 'Kore', persona: 'Traditional, elegant Tamil female anchor' },
  { id: 'm_rj_1', name: 'Vikram - Energetic RJ', gender: VoiceGender.MALE, apiVoiceName: 'Puck', persona: 'Fast-talking, high-energy radio host' },
  { id: 'f_modern_1', name: 'Priya - Urban Modern', gender: VoiceGender.FEMALE, apiVoiceName: 'Aoede', persona: 'Modern, bubbly city girl voice' },
  { id: 'm_corp_1', name: 'Sam - Indian English Pro', gender: VoiceGender.MALE, apiVoiceName: 'Charon', persona: 'Professional corporate announcer (Indian English)' },
  { id: 'f_warm_1', name: 'Scarlett - Cinematic Warm', gender: VoiceGender.FEMALE, apiVoiceName: 'Kore', persona: 'Warm, breathy, and cinematic female voice' },
  { id: 'f_power_1', name: 'Scarlett - Power Ad', gender: VoiceGender.FEMALE, apiVoiceName: 'Aoede', persona: 'Commanding commercial voice, deep and punchy' },
  { id: 'f_narrative_1', name: 'Scarlett - Smooth Narration', gender: VoiceGender.FEMALE, apiVoiceName: 'Kore', persona: 'Velvety smooth narration voice' },
  { id: 'f_husky_1', name: 'Scarlett - Sultry Husky', gender: VoiceGender.FEMALE, apiVoiceName: 'Aoede', persona: 'Signature deep, husky cinematic voice' },
  { id: 'm_narrator_1', name: 'Kabir - Deep Narrator', gender: VoiceGender.MALE, apiVoiceName: 'Charon', persona: 'Deep, authoritative professional narrator' },
  { id: 'f_soft_1', name: 'Maya - Gentle Storyteller', gender: VoiceGender.FEMALE, apiVoiceName: 'Kore', persona: 'Soft-spoken narrator for stories' },
  { id: 'm_deepbass_1', name: 'Titan - Deep Bass Commander', gender: VoiceGender.MALE, apiVoiceName: 'Fenrir', persona: 'Ultra-deep bass voice with subwoofer authority' },
  { id: 'm_cinematic_1', name: 'Rajan - Cinematic Trailer Voice', gender: VoiceGender.MALE, apiVoiceName: 'Fenrir', persona: 'Epic Hollywood movie trailer narrator' },
  { id: 'f_cinematic_1', name: 'Zara - Epic Narration Queen', gender: VoiceGender.FEMALE, apiVoiceName: 'Aoede', persona: 'Deep, commanding female cinematic narrator' },
  { id: 'm_deepbass_2', name: 'Anand - Velvet Thunder', gender: VoiceGender.MALE, apiVoiceName: 'Charon', persona: 'Smooth baritone — like velvet wrapped around thunder' },
  { id: 'f_parrot_1', name: 'Koko - Cute Parrot', gender: VoiceGender.FEMALE, apiVoiceName: 'Aoede', persona: 'High-pitched parrot with squawks and whistles' },
];

/** Minimalist SVG Icons for Pacing */
const PACING_ICONS: Record<SpeechPacing, React.ReactNode> = {
  [SpeechPacing.SLOW]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  [SpeechPacing.MEDIUM]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 8.25h16.5" />
    </svg>
  ),
  [SpeechPacing.FAST]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  ),
};

/** Categorized Emotion Delivery Vibes */
const VIBE_CATEGORIES = [
  {
    category: 'High Energy',
    items: [
      { vibe: Emotion.SHOUTING, label: 'Shout' },
      { vibe: Emotion.PEPPY, label: 'Peppy' },
      { vibe: Emotion.EXCITED, label: 'Excited' },
      { vibe: Emotion.CRICKET_STADIUM, label: 'Stadium' },
      { vibe: Emotion.ANNOUNCEMENT, label: 'Announce' },
    ]
  },
  {
    category: 'Cinematic & Deep',
    items: [
      { vibe: Emotion.DRAMATIC, label: 'Dramatic' },
      { vibe: Emotion.DEEP_BASS, label: 'Deep Bass' },
      { vibe: Emotion.CINEMATIC_NARRATION, label: 'Cinematic' },
    ]
  },
  {
    category: 'Natural & Casual',
    items: [
      { vibe: Emotion.HAPPY, label: 'Happy' },
      { vibe: Emotion.NEUTRAL, label: 'Neutral' },
      { vibe: Emotion.CONVERSATIONAL, label: 'Casual' },
    ]
  },
  {
    category: 'Stylized',
    items: [
      { vibe: Emotion.SARCASM, label: 'Sarcasm' },
      { vibe: Emotion.SAD, label: 'Sad' },
      { vibe: Emotion.LUXURY, label: 'Luxury' },
    ]
  }
];

/** Minimalist SVG Icons for Emotion Vibes */
const EMOTION_ICONS: Record<Emotion, React.ReactNode> = {
  [Emotion.SHOUTING]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z" />
    </svg>
  ),
  [Emotion.PEPPY]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 0L15.75 18m3.75-12v12m-13.5-3a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5z" />
    </svg>
  ),
  [Emotion.EXCITED]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 21l-1.81-4.096L3 15l5.096-1.81L9 9.813l1.81 5.096L15 17l-5.187 1.096z" />
    </svg>
  ),
  [Emotion.CRICKET_STADIUM]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5" />
    </svg>
  ),
  [Emotion.ANNOUNCEMENT]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.34 15.84c-.688-.06-1.38-.09-2.072-.09H6a2.25 2.25 0 01-2.25-2.25v-3C3.75 9.25 4.757 8.25 6 8.25h2.268c.69 0 1.384-.03 2.072-.09l7.007-2.628c.677-.254 1.403.245 1.403.966v11.004c0 .72-.726 1.22-1.403.966l-7.007-2.628z" />
    </svg>
  ),
  [Emotion.DRAMATIC]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h1.5m15.75 0a1.125 1.125 0 001.125-1.125M20.625 19.5h-1.5" />
    </svg>
  ),
  [Emotion.DEEP_BASS]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.375 9L15 12l-5.625 3V9zM21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  [Emotion.CINEMATIC_NARRATION]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-2.36a.75.75 0 011.03.69v7.34a.75.75 0 01-1.03.69l-4.72-2.36V10.5zM4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
    </svg>
  ),
  [Emotion.HAPPY]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.182 15.182a4.5 4.5 0 01-6.364 0M21 12a9 9 0 11-18 0 9 9 0 0118 0zM9.75 9.75c0 .414-.168.75-.375.75S9 10.164 9 9.75 9.168 9 9.375 9s.375.336.375.75zm6 0c0 .414-.168.75-.375.75s-.375-.336-.375-.75.168-.75.375-.75.375.336.375.75z" />
    </svg>
  ),
  [Emotion.NEUTRAL]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5-3h7.5M8.25 6.75h1.5" />
    </svg>
  ),
  [Emotion.SARCASM]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  [Emotion.SAD]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0zM9.75 9.75c0 .414-.168.75-.375.75S9 10.164 9 9.75 9.168 9 9.375 9s.375.336.375.75zm6 0c0 .414-.168.75-.375.75s-.375-.336-.375-.75.168-.75.375-.75.375.336.375.75zm-6.75 4.5a3.75 3.75 0 017.5 0" />
    </svg>
  ),
  [Emotion.LUXURY]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21V3m0 0L7.5 7.5M12 3l4.5 4.5" />
    </svg>
  ),
  [Emotion.CONVERSATIONAL]: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
    </svg>
  ),
};

const AudioVisualizerMeter: React.FC<{ isPlaying: boolean }> = ({ isPlaying }) => {
  return (
    <div className="flex items-end justify-center gap-[3px] h-8 px-3 py-1 bg-black/40 rounded-xl border border-white/10">
      {[40, 70, 30, 85, 60, 95, 45, 75, 55, 90, 65, 35, 80, 50, 60].map((height, i) => (
        <div
          key={i}
          className={`w-1 rounded-full transition-all duration-300 ${
            isPlaying ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600/40'
          }`}
          style={{
            height: isPlaying ? `${Math.max(20, Math.sin(i + Date.now()) * 100)}%` : `${height / 3.5}%`,
            animationDelay: `${i * 0.08}s`
          }}
        />
      ))}
    </div>
  );
};

const TtsPanel: React.FC = () => {
  const [script, setScript] = useState('');
  const [selectedVoice, setSelectedVoice] = useState<VoiceOption>(AVAILABLE_VOICES[0]);
  const [emotion, setEmotion] = useState<Emotion>(Emotion.NEUTRAL);
  const [dialect, setDialect] = useState<Dialect>(Dialect.CHENNAI_TAMIL);
  const [pacing, setPacing] = useState<SpeechPacing>(SpeechPacing.MEDIUM);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [notes, setNotes] = useState('');
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handleResetEngine = () => {
    clearAudioCache();
    setAudioUrl(null);
    setError(null);
    setToastMessage("Speech engine cache purged successfully.");
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleOptimize = async () => {
    if (!script.trim()) {
      setError({ message: 'Script cannot be empty. Type or paste your script first.' });
      return;
    }
    setIsOptimizing(true);
    setError(null);
    try {
      const optimized = await optimizeScript(script, dialect);
      setScript(optimized);
    } catch (err: any) {
      console.error("Optimization error:", err);
      setError({ message: 'Failed to auto-match vibes.' });
    } finally {
      setIsOptimizing(false);
    }
  };

  const MAX_STABLE_CHARS = 5000;

  const handleGenerate = async () => {
    if (!script.trim()) {
      setError({ message: 'Script cannot be empty.' });
      return;
    }
    setIsLoading(true);
    setError(null);
    setProgress({ current: 0, total: 0 });
    if (audioUrl) URL.revokeObjectURL(audioUrl);

    try {
      const blob = await generateSpotAudio(
        script, 
        selectedVoice, 
        emotion, 
        dialect, 
        false, 
        notes, 
        (current, total) => setProgress({ current, total }),
        pacing
      );
      setAudioUrl(URL.createObjectURL(blob));
      logGenerationToFirestore({
        voiceId: selectedVoice.id,
        emotion: String(emotion),
        dialect: String(dialect),
        scriptLength: script.length
      });
    } catch (err: any) {
      console.error("Synthesis error:", err);
      let parsedError = err;
      try {
        if (err.message && err.message.startsWith('{')) {
          parsedError = JSON.parse(err.message);
        }
      } catch (e) {
        // Ignore
      }

      let errorMessage = parsedError.message || (parsedError.error && parsedError.error.message) || err.message || 'An unexpected error occurred.';
      const status = parsedError.status || parsedError.code || (parsedError.error && parsedError.error.code) || err.status || err.code;
      
      if (errorMessage.includes('TTS_ENGINE_ERROR: OTHER')) {
        errorMessage = "Neural engine bottleneck. Simplify your script or select another voice.";
      } else if (errorMessage.includes('TTS_ENGINE_ERROR: SAFETY')) {
        errorMessage = "Generation filtered. Ensure your script content meets standard safety policies.";
      } else if (status === 429) {
        errorMessage = "API quota reached. Please check billing or try again in a minute.";
      }
      
      setError({ message: errorMessage, code: status?.toString() });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start animate-fade-in">
      
      {/* ── Left Column: Performance Parameters + Voice Conversion (Stacked) ── */}
      <div className="lg:col-span-5 space-y-6">
        
        {/* Card 1: Performance Parameters */}
        <div className="liquid-glass p-5 space-y-5">
          <div className="pb-3 border-b border-white/10">
            <h2 className="text-xs font-bold text-white uppercase tracking-wider">
              Performance Parameters
            </h2>
          </div>
          
          <div className="space-y-4">
            {/* Dialect Profile */}
            <CustomSelect
              label="Dialect Profile"
              options={DIALECT_OPTIONS}
              value={dialect}
              onChange={(val) => setDialect(val as Dialect)}
              disabled={isLoading}
            />

            {/* Speech Pacing Control */}
            <div>
              <label className="block text-gray-400 text-xs font-semibold uppercase mb-1.5 tracking-wider">
                Speech Pacing & Tempo
              </label>
              <div className="grid grid-cols-3 gap-2 bg-black/30 p-1 rounded-xl border border-white/10">
                {([
                  { speed: SpeechPacing.SLOW,   label: 'Slow' },
                  { speed: SpeechPacing.MEDIUM,  label: 'Medium' },
                  { speed: SpeechPacing.FAST,    label: 'Fast' },
                ] as const).map(({ speed, label }) => {
                  const isSelected = pacing === speed;
                  return (
                    <button
                      key={speed}
                      onClick={() => setPacing(speed)}
                      className={`py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 select-none ${
                        isSelected
                          ? 'bg-emerald-500 text-black font-bold shadow-sm'
                          : 'text-gray-400 hover:text-white hover:bg-white/5'
                      }`}
                    >
                      {PACING_ICONS[speed]}
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Categorized Emotional Delivery Vibe Matrix */}
            <div>
              <label className="block text-gray-400 text-xs font-semibold uppercase mb-1.5 tracking-wider">
                Emotional Delivery Vibe
              </label>
              <div className="space-y-2.5 max-h-[160px] overflow-y-auto pr-1 custom-scrollbar">
                {VIBE_CATEGORIES.map(cat => (
                  <div key={cat.category} className="space-y-1">
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">
                      {cat.category}
                    </span>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                      {cat.items.map(({ vibe, label }) => {
                        const isSelected = emotion === vibe;
                        return (
                          <button
                            key={vibe}
                            onClick={() => setEmotion(vibe)}
                            title={vibe}
                            className={`px-2 py-1.5 rounded-lg border text-left transition-all flex items-center gap-1.5 select-none text-xs ${
                              isSelected
                                ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 font-bold'
                                : 'bg-black/30 border-white/5 text-gray-400 hover:border-white/20 hover:text-white'
                            }`}
                          >
                            <span className="flex-shrink-0">{EMOTION_ICONS[vibe]}</span>
                            <span className="truncate">{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Voice Artist Profile */}
            <div>
              <label className="block text-gray-400 text-xs font-semibold uppercase mb-1.5 tracking-wider">
                Voice Artist Profile
              </label>
              <div className="grid grid-cols-2 gap-1.5 max-h-[140px] overflow-y-auto pr-1 custom-scrollbar">
                {AVAILABLE_VOICES.map((v) => {
                  const isSelected = selectedVoice.id === v.id;
                  return (
                    <button
                      key={v.id}
                      onClick={() => setSelectedVoice(v)}
                      title={v.persona}
                      className={`p-2 rounded-xl border text-left transition-all select-none relative ${
                        isSelected 
                          ? 'bg-emerald-500/15 border-emerald-500 text-white font-bold' 
                          : 'bg-black/30 border-white/5 text-gray-400 hover:border-white/20 hover:text-white'
                      }`}
                    >
                      <div className="text-xs truncate">{v.name}</div>
                      <div className="text-[10px] text-gray-400 capitalize mt-0.5 truncate">{v.gender}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>



      </div>

      {/* ── Right Column: Script Console & Action Trigger + Output ────────── */}
      <div className="lg:col-span-7 space-y-6">
        
        {/* Error Alert */}
        {error && (
          <div className="bg-red-950/40 border border-red-500/40 p-4 rounded-2xl flex items-start gap-3">
            <div className="flex-grow min-w-0">
              <div className="flex items-center justify-between mb-1">
                <p className="text-red-200 text-xs font-bold uppercase">
                  Engine Notice {error.code && `[${error.code}]`}
                </p>
                <button onClick={() => setError(null)} className="text-[10px] text-red-400 hover:text-white uppercase">
                  Dismiss
                </button>
              </div>
              <p className="text-gray-300 text-xs leading-relaxed">{error.message}</p>
            </div>
          </div>
        )}

        {/* Script Console Card */}
        <div className="liquid-glass p-1 flex flex-col min-h-[440px]">
          
          <div className="bg-black/40 rounded-t-[18px] px-5 py-3 border-b border-white/10 flex flex-wrap items-center justify-between gap-4">
            <span className="text-xs font-bold text-white uppercase tracking-wider">
              Script Production Console
            </span>
            
            <div className="flex items-center gap-3 flex-wrap">
              {isLoading && progress.total > 0 && (
                <span className="text-xs font-semibold text-emerald-400 animate-pulse">
                  Synthesizing Part {progress.current} of {progress.total}
                </span>
              )}

              <SpeechToTextDictation
                disabled={isLoading}
                onTranscript={(text) => setScript((prev) => prev ? prev + ' ' + text : text)}
              />

              <button
                onClick={handleResetEngine}
                disabled={isLoading}
                className="px-3 py-1 bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 hover:text-white rounded-lg text-xs font-medium transition-all"
              >
                Clear Cache
              </button>

              <button
                onClick={handleOptimize}
                disabled={isLoading || isOptimizing}
                className={`px-3 py-1 border rounded-lg text-xs font-medium transition-all ${
                  isOptimizing 
                    ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 animate-pulse' 
                    : 'bg-white/5 hover:bg-white/10 border-white/10 text-gray-300 hover:text-white'
                }`}
              >
                {isOptimizing ? 'Matching Vibe...' : 'Auto Vibe Match'}
              </button>

              <span className={`text-xs font-medium ${script.length > MAX_STABLE_CHARS ? 'text-emerald-400' : 'text-gray-400'}`}>
                {script.length} / {MAX_STABLE_CHARS} CHARS
              </span>
            </div>
          </div>

          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            disabled={isLoading}
            placeholder="Type or paste your speech script here...
Tip: Use (Style) tags for per-sentence emotion delivery — e.g. (Shouting) Massive sale today! (Dramatic) Offer ends tonight."
            className="flex-grow bg-transparent text-white p-5 focus:outline-none text-sm resize-none leading-relaxed placeholder:text-gray-500 custom-scrollbar disabled:opacity-50 min-h-[280px]"
          />

          <div className="p-4 bg-black/40 border-t border-white/5">
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-gray-400 flex-shrink-0">Sync Notes:</span>
              <input 
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes: e.g. 'Pronounce brand name slowly'"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500 transition-all"
              />
            </div>
          </div>
        </div>

        {/* Real-Time Live Visual Progress Bar */}
        <RealtimeProgress 
          isProcessing={isLoading} 
          current={progress.current} 
          total={progress.total} 
          title="HyperVox Neural Speech Engine" 
        />

        {/* Single-Word Strong Action Button */}
        <button
          onClick={handleGenerate}
          disabled={isLoading}
          className={`w-full py-4 rounded-xl font-bold text-base uppercase tracking-widest transition-all ${
            isLoading ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 cursor-wait' : 'liquid-btn-primary'
          }`}
        >
          {isLoading ? `SYNTHESIZING... (${progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0}%)` : 'SYNTHESIZE'}
        </button>

        {/* Audio Player & Visualizer */}
        {audioUrl && (
          <div className="liquid-glass-accent p-5 space-y-4 animate-fade-in">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div>
                <h4 className="text-emerald-400 font-bold uppercase text-xs tracking-wider">
                  Audio Output Ready
                </h4>
                <p className="text-[11px] text-gray-400 mt-0.5">Lossless Segment-Merged Output</p>
              </div>

              <AudioVisualizerMeter isPlaying={isPlayingAudio} />
            </div>
            
            <audio 
              ref={audioRef}
              controls 
              src={audioUrl} 
              onPlay={() => setIsPlayingAudio(true)}
              onPause={() => setIsPlayingAudio(false)}
              onEnded={() => setIsPlayingAudio(false)}
              className="w-full custom-audio-player" 
            />
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <a 
                href={audioUrl} 
                download={getBrandFilename(script, 'synthesized_audio', 'mp3')} 
                className="liquid-btn-primary text-center font-bold py-3 rounded-xl text-xs uppercase tracking-wider flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Download MP3
              </a>
              <button 
                onClick={() => { setAudioUrl(null); setScript(''); setIsPlayingAudio(false); }} 
                className="liquid-btn-secondary py-3 rounded-xl text-xs font-bold uppercase tracking-wider"
              >
                Reset Console
              </button>
            </div>
          </div>
        )}

      </div>
      
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 liquid-glass text-white px-5 py-3 rounded-xl shadow-2xl flex items-center gap-3 font-semibold text-xs border border-white/10">
          <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
          {toastMessage}
        </div>
      )}
    </div>
  );
};

export default TtsPanel;
