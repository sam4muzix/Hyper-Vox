
export enum VoiceGender {
  MALE = 'Male',
  FEMALE = 'Female'
}

export interface VoiceOption {
  id: string;
  name: string;
  gender: VoiceGender;
  apiVoiceName: string; 
  persona: string;
}

export enum Emotion {
  SHOUTING        = 'ULTRA-HIGH ENERGY / MAXIMUM SHOUT',
  PEPPY           = 'PEPPY / RADIO PROMO',
  DRAMATIC        = 'DRAMATIC / CINEMATIC TRAILER',
  LUXURY          = 'LUXURY / WHISPER-SOFT',
  HAPPY           = 'CHEERFUL / RETAIL AD',
  SAD             = 'EMOTIONAL / STORYTELLING',
  NEUTRAL         = 'NEUTRAL / NEWS ANNOUNCER',
  ANNOUNCEMENT    = 'AUTHORITATIVE CORPORATE',
  CRICKET_STADIUM = 'CRICKET STADIUM / SHOUTING ROAR',
  SARCASM             = 'SARCASM / WITTY',
  CONVERSATIONAL      = 'CONVERSATIONAL / NATURAL SPEAKING',
  EXCITED             = 'EXCITED / HIGH ENERGY ENTHUSIASM',
  DEEP_BASS           = 'DEEP BASS / RUMBLING AUTHORITY',
  CINEMATIC_NARRATION = 'CINEMATIC NARRATION / TRAILER EPIC',
}

export enum Dialect {
  CHENNAI_TAMIL = 'Chennai Tamil (Highly colloquial local Madras Bashai, native authentic pronunciation, strictly NO English accent)',
  CLASSIC_TAMIL = 'Classic Tamil (Formal Senthamizh, native authentic pronunciation)',
  INDIAN_ENGLISH = 'Indian English',
  REGULAR_ENGLISH = 'Regular English (Standard neutral accent, clear international pronunciation)'
}

export interface ProcessingFile {
  id: string;
  file: File;
  language: string; 
  status: 'pending' | 'processing' | 'completed' | 'failed';
  outputUrl?: string;
  outputBlob?: Blob; 
  error?: string;
}

export interface TranscriptionJob {
  id: string;
  file: File;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  outputText?: string;
  error?: string;
}

export enum SpeechPacing {
  SLOW   = 'Slow',
  MEDIUM = 'Medium',
  FAST   = 'Fast',
}

export type DubbingStyle = 'Classical' | 'Local Speaking Form';
export type DubbingGender = 'Auto (Match Source)' | 'Male' | 'Female';
export type TranscriptionStyle = 'Straight Translation' | 'Colloquial (Local Slang)' | 'Classical (Formal)';
