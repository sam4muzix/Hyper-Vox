import React, { useState, useRef, useEffect } from 'react';
import { transcribeAudio } from '../services/geminiService';
import { CustomSelect, SelectOption } from './CustomSelect';

interface SpeechToTextDictationProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

const STT_LANGUAGES: SelectOption[] = [
  { value: 'ta-IN', label: 'Tamil (தமிழ்)' },
  { value: 'hi-IN', label: 'Hindi (हिंदी)' },
  { value: 'en-IN', label: 'Indian English' },
  { value: 'en-US', label: 'English (US)' },
];

export const SpeechToTextDictation: React.FC<SpeechToTextDictationProps> = ({
  onTranscript,
  disabled = false
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [selectedLang, setSelectedLang] = useState('ta-IN');
  const [interimText, setInterimText] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch (e) { /* ignore */ }
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch (e) { /* ignore */ }
      }
    };
  }, []);

  const startWebSpeechRecognition = (): boolean => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return false;

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = selectedLang;

      recognition.onstart = () => {
        setIsRecording(true);
        setStatusMessage(`Listening in ${STT_LANGUAGES.find(l => l.value === selectedLang)?.label}... Speak now.`);
      };

      recognition.onresult = (event: any) => {
        let currentInterim = '';
        let finalChunk = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcriptStr = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalChunk += transcriptStr + ' ';
          } else {
            currentInterim += transcriptStr;
          }
        }

        if (finalChunk.trim()) {
          onTranscript(finalChunk);
        }
        setInterimText(currentInterim);
      };

      recognition.onerror = (event: any) => {
        console.warn('[STT] WebSpeech error:', event.error);
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setStatusMessage("Microphone access denied. Please allow microphone permissions.");
          stopDictation();
        } else if (event.error === 'no-speech') {
          // Keep listening
        } else {
          // Fallback to Gemini media recording if WebSpeech fails
          startMediaRecorderFallback();
        }
      };

      recognition.onend = () => {
        if (isRecording) {
          // Restart if still marked as recording (keeps continuous listening alive)
          try { recognition.start(); } catch (e) { setIsRecording(false); }
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
      return true;
    } catch (err) {
      console.warn('[STT] WebSpeech initialization failed:', err);
      return false;
    }
  };

  const startMediaRecorderFallback = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach(track => track.stop());

        if (audioBlob.size > 1000) {
          setStatusMessage("Processing audio with Gemini Multimodal Transcriber...");
          try {
            const langName = STT_LANGUAGES.find(l => l.value === selectedLang)?.label || 'Tamil';
            const audioFile = new File([audioBlob], "speech_dictation.webm", { type: 'audio/webm' });
            const resultText = await transcribeAudio(audioFile, langName, 'Straight Translation');
            if (resultText && !resultText.includes('failed')) {
              onTranscript(resultText + ' ');
              setStatusMessage("Transcribed successfully!");
            }
          } catch (err) {
            console.error('[STT] Gemini Fallback error:', err);
            setStatusMessage("Speech transcription failed. Please try speaking again.");
          }
        }
        setIsRecording(false);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setStatusMessage(`Recording audio for ${STT_LANGUAGES.find(l => l.value === selectedLang)?.label}... Click mic to finish.`);
    } catch (err) {
      console.error('[STT] Microphone access failed:', err);
      setStatusMessage("Could not access microphone.");
      setIsRecording(false);
    }
  };

  const startDictation = () => {
    setInterimText('');
    setStatusMessage(null);

    const started = startWebSpeechRecognition();
    if (!started) {
      startMediaRecorderFallback();
    }
  };

  const stopDictation = () => {
    setIsRecording(false);
    setInterimText('');
    setStatusMessage(null);

    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch (e) { /* ignore */ }
      recognitionRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch (e) { /* ignore */ }
    }
  };

  const toggleDictation = () => {
    if (isRecording) {
      stopDictation();
    } else {
      startDictation();
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* STT Language Selector */}
      <div className="w-36">
        <CustomSelect
          options={STT_LANGUAGES}
          value={selectedLang}
          onChange={(val) => setSelectedLang(val)}
          disabled={disabled || isRecording}
        />
      </div>

      {/* Dictation Button */}
      <button
        type="button"
        onClick={toggleDictation}
        disabled={disabled}
        className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all border ${
          isRecording
            ? 'bg-red-500/20 border-red-500 text-red-400 shadow-[0_0_12px_rgba(239,68,68,0.4)] animate-pulse'
            : 'bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/30 text-emerald-400 hover:text-white'
        }`}
        title={isRecording ? "Click to Stop Voice Dictation" : "Click to Speak & Auto-Fill Text Script"}
      >
        <svg className={`w-3.5 h-3.5 ${isRecording ? 'animate-bounce text-red-400' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 003-3V4.5a3 3 0 00-3-3s-3 1.343-3 3v8.25a3 3 0 003 3z" />
        </svg>
        <span>{isRecording ? 'Listening...' : 'Voice Dictate'}</span>
      </button>

      {/* Live Interim / Status Feedback Pill */}
      {isRecording && (
        <div className="flex items-center gap-2 bg-red-950/40 border border-red-500/30 px-3 py-1 rounded-lg text-xs font-medium text-red-300 animate-fade-in max-w-xs truncate">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-ping flex-shrink-0" />
          <span className="truncate">{interimText ? `"${interimText}"` : statusMessage || 'Speak into microphone...'}</span>
        </div>
      )}
    </div>
  );
};
