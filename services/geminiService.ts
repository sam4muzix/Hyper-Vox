
import { GoogleGenAI, GenerateContentResponse, Modality } from "@google/genai";
import { Dialect, Emotion, VoiceOption, TranscriptionStyle, DubbingGender, SpeechPacing } from '../types';
import { decodeBase64ToUint8Array, pcmToMp3, blobToBase64, getAudioDurationFromFile, stretchPcmToTargetDuration } from '../utils/audio';

// ─── Constants ────────────────────────────────────────────────────────────────
const TTS_MODEL  = 'gemini-2.5-flash-preview-tts';
const TEXT_MODEL = 'gemini-3-flash-preview';

// ─── API Key Management ───────────────────────────────────────────────────────
export const getActiveApiKey = (): string => {
  const envKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
  if (envKey && envKey !== 'undefined' && envKey.trim() !== '') {
    return envKey.trim();
  }
  if (typeof window !== 'undefined') {
    const local = localStorage.getItem('HYPERVOX_GEMINI_API_KEY') || localStorage.getItem('GEMINI_API_KEY');
    if (local && local.trim() !== '') return local.trim();
  }
  return '';
};

export const setCustomApiKey = (key: string) => {
  if (typeof window !== 'undefined') {
    if (key.trim()) {
      localStorage.setItem('HYPERVOX_GEMINI_API_KEY', key.trim());
    } else {
      localStorage.removeItem('HYPERVOX_GEMINI_API_KEY');
      localStorage.removeItem('GEMINI_API_KEY');
    }
  }
};

export const hasValidApiKey = (): boolean => {
  return getActiveApiKey().length > 0;
};

// ─── AI Client ────────────────────────────────────────────────────────────────
const getAI = () => {
  const apiKey = getActiveApiKey();
  if (!apiKey) {
    throw new Error("AUTH_REQUIRED: API access not configured. Please click 'Configure API Key' in the top bar to enter your Gemini API key.");
  }
  return new GoogleGenAI({ apiKey });
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Retry logic ──────────────────────────────────────────────────────────────
/**
 * 4 retries with exponential backoff.
 * - OTHER errors (transient engine overload) → 2000ms base
 * - Quota 429 → throw immediately, no retry (billing issue)
 * - Respects "retry in Xs" hints from the API
 */
const withRetry = async <T>(
  operation: (attempt: number) => Promise<T>,
  maxRetries = 4,
  baseDelay = 1000
): Promise<T> => {
  let lastError: any;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await operation(i);
    } catch (error: any) {
      lastError = error;

      let parsedError = error;
      try {
        if (error.message && error.message.startsWith('{')) {
          parsedError = JSON.parse(error.message);
        }
      } catch (e) { /* ignore */ }

      const status = parsedError.status || parsedError.code
        || (parsedError.error && parsedError.error.code)
        || error.status || error.code;
      const errorMessage = parsedError.message
        || (parsedError.error && parsedError.error.message)
        || error.message || '';

      // Quota exceeded → no retry
      if (status === 429 && errorMessage.toLowerCase().includes('quota')) throw error;

      if (i < maxRetries) {
        const isTTSError   = errorMessage.includes('TTS_ENGINE_ERROR');
        const isOtherError = errorMessage.includes('OTHER');

        // OTHER = transient server overload → longer wait. TTS errors → short. Else → standard.
        let delay = (isOtherError ? 2000 : (isTTSError ? 800 : baseDelay))
          * Math.pow(1.5, i)
          + Math.random() * 500;

        const retryMatch = error.message?.match(/retry in (\d+(?:\.\d+)?)s/i);
        if (retryMatch?.[1]) delay = parseFloat(retryMatch[1]) * 1000 + 2000;

        console.warn(`[Retry ${i + 1}/${maxRetries}] ${Math.round(delay)}ms — ${errorMessage.slice(0, 80)}`);
        await wait(delay);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
};

// ─── Script cleaning ──────────────────────────────────────────────────────────
const cleanScript = (text: string): string => {
  if (!text) return '';
  return text
    .normalize('NFC')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/[#@*^~`<>|\\{}_+=:"']/g, ' ')
    .replace(/([.!?;:])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
};

// ─── Tagged script parsing ────────────────────────────────────────────────────
/**
 * Splits a script with inline (Style Tag) markers into segments.
 * Each segment carries the style keyword used to look up a system instruction.
 *
 * Example: "(Shouting) Sale today! (Dramatic) Offer ends tonight."
 * → [{ text: "Sale today!", style: "Shouting" }, { text: "Offer ends tonight.", style: "Dramatic" }]
 *
 * [Square bracket] notes are stripped — they are not meant to be spoken.
 */
interface ScriptSegment {
  text: string;
  styleKey: string; // empty string = use the global emotion
}

const parseTaggedScript = (script: string, defaultStyleKey: string): ScriptSegment[] => {
  const withoutNotes = script.replace(/\[(?!SOUND EFFECT:).*?\]/gi, '');
  const parts = withoutNotes.split(/\((.*?)\)/);
  const segments: ScriptSegment[] = [];

  if (parts[0].trim()) {
    segments.push({ text: parts[0].trim(), styleKey: defaultStyleKey });
  }

  for (let i = 1; i < parts.length; i += 2) {
    const styleKey = parts[i]?.trim() || defaultStyleKey;
    const text     = parts[i + 1]?.trim();
    if (text) segments.push({ text, styleKey });
  }

  return segments;
};

// ─── Chunk splitting ──────────────────────────────────────────────────────────
/**
 * Split into ≤ maxSize chunks at sentence boundaries.
 * 200 chars = Project 2's proven sweet spot for near-zero 500 errors.
 */
const splitIntoChunks = (text: string, maxSize: number): string[] => {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  const sentences = text.match(/[^.!?\n]+[.!?\n]*\s*/g) || [text];
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > maxSize) {
      if (current) { chunks.push(current.trim()); current = ''; }
      const words = sentence.split(/\s+/);
      for (const word of words) {
        if (word.length > maxSize) {
          if (current) { chunks.push(current.trim()); current = ''; }
          for (let i = 0; i < word.length; i += maxSize) chunks.push(word.substring(i, i + maxSize));
        } else if ((current + ' ' + word).trim().length > maxSize) {
          if (current) chunks.push(current.trim());
          current = word;
        } else {
          current += (current ? ' ' : '') + word;
        }
      }
    } else if ((current + sentence).length > maxSize) {
      if (current) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 0);
};

// ─── Audio cache ──────────────────────────────────────────────────────────────
const audioCache = new Map<string, Uint8Array>();
const MAX_CACHE_SIZE = 100;

const getCacheKey = (chunk: string, promptContext: string, speechConfig: any) =>
  `${chunk}|${promptContext.slice(0, 120)}|${speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName ?? 'multi'}`;

// ─── Emotion Instructions ──────────────────────────────────────────────
/**
 * CRITICAL: These rich profiles are used to guide the TTS engine
 * within the prompt context for maximum distinctiveness.
 */
const EMOTION_SYSTEM_INSTRUCTIONS: Record<string, string> = {

  [Emotion.SHOUTING]: `Audio Profile: You are a MAXIMUM ENERGY Tamil retail commercial announcer.
Scene: A chaotic, high-decibel street sale event — sirens, crowd noise, absolute frenzy.
Director's Notes: SHOUT every single word at full volume. Your voice should strain with energy. Pitch at the top of your range. Tempo: extremely fast, breathless, almost overwhelming. Think of an auctioneer at a fire sale — never pause, never soften, never drop energy. Every syllable lands like a punch.`,

  [Emotion.PEPPY]: `Audio Profile: You are a bright, bubbly Indian FM radio jockey presenting a sponsor segment.
Scene: Morning drive-time on a top FM station — the audience is waking up, coffee in hand.
Director's Notes: Speak with a fast, bouncy, punchy rhythm. Smile audible in every word. Rising inflection on product highlights. Consonants sharp and crisp. Energy stays HIGH and BRIGHT throughout — never flatten, never slow, never go serious. This is radio gold.`,

  [Emotion.EXCITED]: `Audio Profile: You are an ultra-enthusiastic product launch announcer — this is the biggest moment of the year.
Scene: Grand reveal event — confetti falling, crowd on their feet, spotlights blazing.
Director's Notes: Deliver as if you've just won the lottery. Pitch at the ceiling. Every sentence faster than the last. Breathless excitement — you can barely keep up with your own enthusiasm. This is joy overloaded. Never calm down even for a second.`,

  [Emotion.CRICKET_STADIUM]: `Audio Profile: You are a live cricket stadium PA announcer — the home team just hit a six.
Scene: 80,000-person packed stadium, crowd ROARING, music blasting.
Director's Notes: SCREAM with maximum stadium energy. Voice amplified, projected to the last row. Frenzied, electric delivery — every word triggers a crowd surge. Never drop below full volume. Short punchy bursts like a sports anchor calling the winning moment.`,

  [Emotion.ANNOUNCEMENT]: `Audio Profile: You are a formal corporate spokesperson delivering an official public announcement.
Scene: Live press conference broadcast — cameras rolling, journalists taking notes.
Director's Notes: Deep, resonant, authoritative delivery. Measured pace — every word carefully placed. No excitement, no warmth, no softness. This is OFFICIAL. Commanding presence. Each sentence sounds like a declaration. Slight downward inflection at the end of statements.`,

  [Emotion.DRAMATIC]: `Audio Profile: You are a cinematic Tamil film trailer narrator.
Scene: A sweeping, slow-motion movie trailer — emotional music building underneath.
Director's Notes: Speak S-L-O-W-L-Y with theatrical gravitas. Deep, resonant voice at the low end of your range. Deliberate pauses before every key word — let the silence build tension. Progressive intensity — start quiet, swell toward the climax. Every word carries the weight of fate.`,

  [Emotion.HAPPY]: `Audio Profile: You are a warm, joyful festive commercial voice.
Scene: A Diwali or Pongal sale event — families shopping together, laughter everywhere.
Director's Notes: Bright, smiling, genuinely warm delivery. Mid-to-high pitch. Light and welcoming — like greeting a dear friend. Make every listener feel celebrated and included. Natural joy, not forced excitement. Gentle rising inflections. Heartfelt and real.`,

  [Emotion.NEUTRAL]: `Audio Profile: You are a professional Tamil television news anchor.
Scene: Prime-time evening news broadcast on a major channel.
Director's Notes: Clear, calm, measured delivery. Confident authority without aggression. Perfect diction and controlled pacing. Neutral but never flat — there is gravitas and intelligence in every sentence. No emotion, no colour, just precise professional delivery.`,

  [Emotion.SARCASM]: `Audio Profile: You are a sharp, witty Tamil stand-up comedian appearing in a clever TV ad.
Scene: A tongue-in-cheek commercial that breaks the fourth wall.
Director's Notes: Knowing smirk in every word. Strategic pauses before punchlines — let the irony land. Wry upward inflection that signals "you know exactly what I mean". Sharp consonants for comic effect. Never monotone — the wit is in the variation. Dry, intelligent humour.`,

  [Emotion.SAD]: `Audio Profile: You are a heartfelt storyteller narrating a deeply emotional Tamil public service ad.
Scene: A quiet, intimate moment — a single candle, soft focus, genuine emotion.
Director's Notes: Speak slowly, softly, sincerely. Slightly breathy quality. Controlled emotional depth — not melodrama, but genuine feeling that rises naturally. Tender pauses between phrases. The listener should feel what you feel. Never robotic, never rushed.`,

  [Emotion.LUXURY]: `Audio Profile: You are the voice of an ultra-premium luxury brand — think Rolex or Louis Vuitton Tamil edition.
Scene: An elegant product film — slow motion, golden light, marble surfaces.
Director's Notes: Smooth, unhurried, velvety delivery at the lower mid-range of your voice. Every syllable is precious and deliberate. Never rush. Never peak in energy. Exude effortless exclusivity — the voice of something rare. Soft breath behind the words. Understated perfection.`,

  [Emotion.CONVERSATIONAL]: `Audio Profile: You are a trusted friend having a genuine one-on-one conversation.
Scene: Casual afternoon chat over tea — relaxed, warm, no performance.
Director's Notes: Natural, organic delivery with real rises and falls — like actual speech, not a script. Warm and genuine. Occasional small pauses as if thinking. No announcement energy, no performance. Sound like a real person who genuinely cares about what they're saying.`,

  [Emotion.DEEP_BASS]: `Audio Profile: You are a deep-voiced cinematic bass narrator — the rumbling voice of power and gravitas.
Scene: The darkened stage of a premium event — a single spotlight, subwoofer rumble, audience holding their breath.
Director's Notes: Speak from the absolute LOWEST register of your voice. Deep, chest-resonant, thunderous bass that vibrates with authority. Extremely slow, deliberate pacing — each word lands like a drumbeat. This is the voice of God in a movie trailer. Minimal inflection — flat and commanding. Every pause is a power move. Think James Earl Jones meets a subwoofer. NEVER go above mid-range. The lower, the better.`,

  [Emotion.CINEMATIC_NARRATION]: `Audio Profile: You are an epic Hollywood movie trailer narrator — the voice behind every blockbuster reveal.
Scene: A sweeping cinematic trailer — explosions, orchestral crescendo, title cards slamming into frame.
Director's Notes: Deep, powerful, larger-than-life delivery with dramatic gravitas. Build intensity across phrases — start with controlled power, escalate to thunderous peaks. Strategic dramatic pauses before reveal words. Voice should sound like it's echoing in an IMAX theater. Mix between intense whispered tension and explosive proclamations. Every sentence is a climactic moment. Think "In a world where..." energy. Commanding, epic, unforgettable.`,
};

// ─── Emotion → inline audio tag ───────────────────────────────────────────────
/**
 * Prepended to each chunk — official TTS inline control signal.
 * Works WITH the prompt directives to lock in the delivery style from word 1.
 */
const EMOTION_AUDIO_TAGS: Record<string, string> = {
  [Emotion.SHOUTING]:        '[shouting at maximum volume]',
  [Emotion.PEPPY]:           '[excitedly, fast-paced and bouncy]',
  [Emotion.EXCITED]:         '[excited, breathless and enthusiastic]',
  [Emotion.CRICKET_STADIUM]: '[shouting, stadium announcer energy]',
  [Emotion.ANNOUNCEMENT]:    '[seriously, authoritative and formal]',
  [Emotion.DRAMATIC]:        '[slowly and dramatically, with gravitas]',
  [Emotion.HAPPY]:           '[cheerfully, warm and joyful]',
  [Emotion.NEUTRAL]:         '[calmly and professionally]',
  [Emotion.SARCASM]:         '[sarcastically, with a knowing smirk]',
  [Emotion.SAD]:             '[sadly, softly and with feeling]',
  [Emotion.LUXURY]:          '[whispering, slow and velvety]',
  [Emotion.CONVERSATIONAL]:  '[casually, like a real conversation]',
  [Emotion.DEEP_BASS]:       '[in a deep, rumbling bass voice with maximum low-end]',
  [Emotion.CINEMATIC_NARRATION]: '[dramatically, like a Hollywood movie trailer narrator]',
};

// ─── Style keyword → Emotion lookup (for (Style Tag) segments) ────────────────
/**
 * Maps style keywords from (Style Tag) markers to Emotion enum keys.
 * Case-insensitive keyword matching — partial matches work.
 * Falls back to the default emotion if no match found.
 */
const resolveStyleToEmotion = (styleKey: string, defaultEmotion: Emotion): Emotion => {
  const lower = styleKey.toLowerCase();
  if (lower.includes('shout') || lower.includes('scream') || lower.includes('maximum')) return Emotion.SHOUTING;
  if (lower.includes('peppy') || lower.includes('radio') || lower.includes('promo'))   return Emotion.PEPPY;
  if (lower.includes('excit'))                                                          return Emotion.EXCITED;
  if (lower.includes('cricket') || lower.includes('stadium'))                          return Emotion.CRICKET_STADIUM;
  if (lower.includes('announc') || lower.includes('corporate') || lower.includes('authorit')) return Emotion.ANNOUNCEMENT;
  if (lower.includes('dramat') || lower.includes('cinematic') || lower.includes('trailer'))   return Emotion.DRAMATIC;
  if (lower.includes('happy') || lower.includes('cheerful') || lower.includes('joyful'))      return Emotion.HAPPY;
  if (lower.includes('neutral') || lower.includes('news') || lower.includes('calm'))          return Emotion.NEUTRAL;
  if (lower.includes('sarcas') || lower.includes('witty') || lower.includes('irony'))         return Emotion.SARCASM;
  if (lower.includes('sad') || lower.includes('emotion') || lower.includes('heartfelt'))      return Emotion.SAD;
  if (lower.includes('luxury') || lower.includes('whisper') || lower.includes('velvet'))      return Emotion.LUXURY;
  if (lower.includes('convers') || lower.includes('casual') || lower.includes('natural'))     return Emotion.CONVERSATIONAL;
  if (lower.includes('deep') || lower.includes('bass') || lower.includes('rumbl'))             return Emotion.DEEP_BASS;
  if (lower.includes('cine') || lower.includes('narrat') || lower.includes('epic') || lower.includes('hollywood')) return Emotion.CINEMATIC_NARRATION;
  return defaultEmotion;
};

// ─── Build prompt context instructions ─────────────────────────────────────────
const buildPromptContext = (
  emotion: Emotion,
  dialect: Dialect,
  voice: VoiceOption,
  pacing: SpeechPacing = SpeechPacing.MEDIUM,
  pronunciationGuide?: string
): string => {
  const dialectMap: Record<string, string> = {
    [Dialect.CHENNAI_TAMIL]:  'Chennai Tamil — colloquial Madras Bashai, native pronunciation, strictly no English accent',
    [Dialect.CLASSIC_TAMIL]:  'Classic Tamil — formal Senthamizh, native pronunciation',
    [Dialect.INDIAN_ENGLISH]: 'Indian English',
    [Dialect.REGULAR_ENGLISH]: 'Regular English — standard neutral international accent, clear and universally understandable pronunciation',
  };

  let emotionInstruction = EMOTION_SYSTEM_INSTRUCTIONS[emotion]
    ?? `Audio Profile: Commercial voice performer.\nDirector's Notes: Deliver with ${emotion.toLowerCase()} style.`;

  if (voice.id === 'f_parrot_1') {
    emotionInstruction = `Audio Profile: You are a cute, high-pitched pet parrot performing this script.
Director's Notes: Deliver the speech with ${emotion.toLowerCase()} emotion, but keep the voice character strictly as a high-pitched, cute parrot. Interject realistic parrot vocal sounds (like "[squawk]", "[chirp]", "[whistle]") between sentences or phrases. Absolutely do NOT sound like a human announcer, male voice, or female narrator. You must remain 100% in the cute parrot character.`;
  }

  const dialectStyle = dialectMap[dialect] ?? String(dialect);

  const pacingMap: Record<string, string> = {
    [SpeechPacing.SLOW]:   'PACING: Speak SLOWLY — deliberate, measured pace. Let every word breathe. Long pauses between phrases. Unhurried and commanding.',
    [SpeechPacing.MEDIUM]: 'PACING: Speak at a NATURAL medium pace — balanced rhythm, clear and steady. Neither rushed nor dragging.',
    [SpeechPacing.FAST]:   'PACING: Speak FAST — rapid-fire delivery, high tempo, breathless energy. Quick transitions between phrases, no pauses.',
  };

  const pacingInstruction = pacingMap[pacing] ?? pacingMap[SpeechPacing.MEDIUM];

  let rules = `- Read every word exactly as written. Do not speak any of the styling instructions, bracketed notes, or directives. Only speak the text in the quotes.`;
  if (voice.id === 'f_parrot_1') {
    rules = `- PERFORM AS A PARROT: Speak in an ultra high-pitched, squeaky, and cute parrot voice.
- PARROT VOCALIZATIONS: You must vocally perform parrot sounds like squawks, chirps, whistles, and squeaks throughout the speech, especially at the start, between phrases, and at the end.
- Do not speak any of the bracketed styling tags, but DO vocally act them out as a parrot.
- You must sound like a real, cute talking parrot, NOT a human.`;
  }

  let context = `${emotionInstruction}

${pacingInstruction}
Dialect: ${dialectStyle}.
Voice Character: ${voice.persona}.
ABSOLUTE RULES:
${rules}`;

  if (pronunciationGuide) {
    context += `
Pronunciation guidance: ${pronunciationGuide}`;
  }

  return context;
};

// ─── Core TTS synthesis ───────────────────────────────────────────────────────
/**
 * Synthesise a single chunk using direct text prompts for style control.
 *
 * KEY INSIGHT: The Gemini TTS API controls voice style through text instructions in the prompt,
 * NOT through systemInstruction config (which causes 500 errors on TTS models).
 */
const synthesizeChunk = async (
  ai: any,
  chunk: string,
  promptContext: string,
  speechConfig: any,
  attempt: number = 0
): Promise<Uint8Array> => {
  if (!chunk.trim()) return new Uint8Array(0);

  const cacheKey = getCacheKey(chunk, promptContext, speechConfig);
  if (audioCache.has(cacheKey)) {
    console.log('[Cache hit] Skipping API call for identical chunk');
    return audioCache.get(cacheKey)!;
  }

  let finalChunk = chunk;
  if (attempt >= 6) {
    // Extreme fallback: strip punctuation to give engine the simplest possible input
    finalChunk = chunk.replace(/[.,!?;:[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Build the complete prompt text with promptContext and target chunk
  const textPrompt = `${promptContext}
${attempt >= 3 ? `Say: "${finalChunk}"` : `Text to speak: "${finalChunk}"`}`;

  const response = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [{ parts: [{ text: textPrompt }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig,
      safetySettings: [
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HARASSMENT',         threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_NONE' },
      ],
    },
  });

  const candidate = response.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`TTS_ENGINE_ERROR: ${candidate.finishReason} | CHUNK: ${chunk}`);
  }

  const audioPart = candidate?.content?.parts?.find((p: any) => p.inlineData?.data);
  if (!audioPart) {
    console.error('[TTS] No audio returned:', JSON.stringify(response, null, 2));
    throw new Error('TTS_ENGINE_ERROR: OTHER | No audio returned.');
  }

  const pcm = decodeBase64ToUint8Array(audioPart.inlineData!.data);

  if (audioCache.size >= MAX_CACHE_SIZE) {
    const oldest = audioCache.keys().next().value;
    if (oldest) audioCache.delete(oldest);
  }
  audioCache.set(cacheKey, pcm);
  return pcm;
};

// ─── Public API ───────────────────────────────────────────────────────────────

export const generateSpotAudio = async (
  script: string,
  voice: VoiceOption,
  emotion: Emotion,
  dialect: Dialect,
  isMultiSpeaker: boolean,
  pronunciationGuide?: string,
  onProgress?: (current: number, total: number) => void,
  pacing: SpeechPacing = SpeechPacing.MEDIUM
): Promise<Blob> => {
  const ai = getAI();

  // Build default prompt context
  const defaultPromptContext = buildPromptContext(emotion, dialect, voice, pacing, pronunciationGuide);

  // Get the inline audio tag for this emotion (prepended to each chunk)
  const defaultAudioTag = EMOTION_AUDIO_TAGS[emotion] ?? '';

  // 1. Parse script into segments (supports inline (Style Tag) per-sentence)
  const segments = parseTaggedScript(script, emotion);

  // 2. Build flat chunk list with per-chunk prompt context + audio tag
  const CHUNK_SIZE = 900;
  const allChunks: { text: string; promptContext: string; audioTag: string }[] = [];

  for (const segment of segments) {
    let cleanedText = cleanScript(segment.text);
    if (!cleanedText) continue;

    if (voice.id === 'f_parrot_1') {
      if (!cleanedText.includes('SOUND EFFECT:')) {
        const sentences = cleanedText.split(/([.!?]+)/);
        let reconstructed = '';
        const effects = [
          '[SOUND EFFECT: happy parrot chirp]',
          '[SOUND EFFECT: quick parrot squawk]',
          '[SOUND EFFECT: excited parrot whistle]',
          '[SOUND EFFECT: parrot squeak]'
        ];
        for (let idx = 0; idx < sentences.length; idx += 2) {
          const sentence = sentences[idx]?.trim();
          const punctuation = sentences[idx + 1] || '';
          if (sentence) {
            const effect = effects[Math.floor(Math.random() * effects.length)];
            reconstructed += `${effect} ${sentence}${punctuation} `;
          }
        }
        cleanedText = reconstructed.trim();
      }
    }

    // Resolve the segment's style key to an emotion
    const segmentEmotion = typeof segment.styleKey === 'string' && segment.styleKey !== emotion
      ? resolveStyleToEmotion(segment.styleKey, emotion)
      : emotion;

    // Per-segment prompt context (may differ from global emotion for (Style) tagged segments)
    const segmentContext = segmentEmotion !== emotion
      ? buildPromptContext(segmentEmotion, dialect, voice, pacing, pronunciationGuide)
      : defaultPromptContext;

    const segmentAudioTag = EMOTION_AUDIO_TAGS[segmentEmotion] ?? defaultAudioTag;

    const chunkTexts = splitIntoChunks(cleanedText, CHUNK_SIZE);
    for (const text of chunkTexts) {
      allChunks.push({
        text,
        promptContext: segmentContext,
        audioTag: segmentAudioTag,
      });
    }
  }

  const speechConfig = isMultiSpeaker
    ? {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            { speaker: 'S1', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Fenrir' } } },
            { speaker: 'S2', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore'  } } },
          ],
        },
      }
    : {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice.apiVoiceName } },
      };

  console.log(`[TTS] ${allChunks.length} chunk(s), emotion: ${emotion}, model: ${TTS_MODEL}`);

  const pcmBuffers: Uint8Array[] = new Array(allChunks.length);

  // ── Parallel synthesis with concurrency cap ────────────────────────────────
  // Process up to CONCURRENCY chunks simultaneously — eliminates sequential
  // wait time while staying well within API rate limits.
  const CONCURRENCY = 3;
  let completedCount = 0;

  const processChunk = async (i: number): Promise<void> => {
    const { text, promptContext, audioTag } = allChunks[i];
    const taggedText = audioTag ? `${audioTag} ${text}` : text;

    try {
      pcmBuffers[i] = await withRetry(
        (attempt) => synthesizeChunk(ai, taggedText, promptContext, speechConfig, attempt)
      );
    } catch (err: any) {
      const errStr = String(err?.message ?? err);
      const is500OrOther = errStr.includes('OTHER') || errStr.includes('500') || errStr.includes('Internal');

      // Fallback: split chunk in half and retry each piece
      if (is500OrOther && text.length > 50) {
        console.warn('[Fallback] Splitting failed chunk and retrying');
        await wait(600);
        const subChunks = splitIntoChunks(text, Math.floor(text.length / 2));
        const subBuffers = await Promise.all(
          subChunks.map(async (sub, si) => {
            if (si > 0) await wait(200 + Math.random() * 200);
            const taggedSub = audioTag ? `${audioTag} ${sub}` : sub;
            return withRetry((attempt) => synthesizeChunk(ai, taggedSub, promptContext, speechConfig, attempt));
          })
        );

        const total = subBuffers.reduce((a, b) => a + b.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const b of subBuffers) { merged.set(b, off); off += b.length; }
        pcmBuffers[i] = merged;
      } else {
        throw err;
      }
    }

    completedCount++;
    if (onProgress) onProgress(completedCount, allChunks.length);
  };

  // Run in parallel batches of CONCURRENCY
  for (let start = 0; start < allChunks.length; start += CONCURRENCY) {
    const batch = allChunks
      .slice(start, start + CONCURRENCY)
      .map((_, j) => processChunk(start + j));
    await Promise.all(batch);
  }

  const totalLen = pcmBuffers.reduce((a, b) => a + (b?.length ?? 0), 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const buf of pcmBuffers) {
    if (buf?.length) { merged.set(buf, offset); offset += buf.length; }
  }

  return pcmToMp3(merged);
};

export const syncAudioPerformance = async (
  targetFile: File,
  _sourceFile: File,
  voice: VoiceOption,
  dialect: Dialect,
  emotion: Emotion
): Promise<Blob> => {
  const ai = getAI();
  const base64 = await blobToBase64(targetFile);
  const resp = await withRetry(() => ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{
      parts: [
        { text: 'Transcribe this audio exactly. Output clean spoken text only — no labels or timestamps.' },
        { inlineData: { data: base64, mimeType: targetFile.type || 'audio/mpeg' } },
      ],
    }],
  })) as GenerateContentResponse;
  return generateSpotAudio(resp.text || '', voice, emotion, dialect, false);
};

// ─── Voice fingerprint analysis ──────────────────────────────────────────────
/**
 * Sends the raw source audio to the text model and asks for a precise vocal
 * fingerprint that the TTS synthesiser can mirror in the dubbed output.
 */
interface VoiceFingerprint {
  gender:       string; // 'deep male' | 'warm female' | etc.
  pitch:        string; // 'low-pitched' | 'mid-range' | 'high-pitched'
  pace:         string; // 'slow and deliberate' | 'moderate' | 'rapid-fire'
  energy:       string; // 'calm and measured' | 'high energy' | 'explosive'
  tone:         string; // 'warm and friendly' | 'authoritative' | 'dramatic' | etc.
  accent:       string; // 'Indian English' | 'Tamil' | 'neutral' | etc.
  delivery:     string; // rich description of the overall performance style
  breathiness:  string; // 'breathy' | 'clear chest voice' | 'resonant'
  emotionLabel: string; // the detected dominant emotion (e.g. 'excited', 'dramatic')
}

const analyseSourceVoice = async (
  ai: any,
  base64Audio: string,
  mimeType: string
): Promise<VoiceFingerprint> => {
  const prompt = `Listen to this audio clip carefully. Your task is to produce a precise VOCAL FINGERPRINT of the speaker that can be used to instruct a text-to-speech system to exactly replicate this voice's delivery style.

Respond ONLY with a valid JSON object — no markdown, no explanation, just raw JSON — with exactly these keys:

{
  "gender":       "e.g. deep male / warm female / androgynous",
  "pitch":        "e.g. low-pitched / mid-range / high-pitched",
  "pace":         "e.g. slow and deliberate / moderate / rapid-fire",
  "energy":       "e.g. calm and measured / high energy / explosive maximum volume",
  "tone":         "e.g. warm and friendly / authoritative and commanding / dramatic and cinematic / bright and cheerful",
  "accent":       "e.g. Indian English / Tamil native / neutral international / regional colloquial",
  "delivery":     "a 2-3 sentence description of how this performer sounds — their signature style, any distinctive qualities, how they use pauses, emphasis, or dynamics",
  "breathiness":  "e.g. breathy and soft / clear full chest voice / resonant and projecting",
  "emotionLabel": "single word: e.g. excited / dramatic / cheerful / authoritative / conversational / luxury"
}`;

  try {
    const r = await withRetry(() => ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [{ parts: [
        { text: prompt },
        { inlineData: { mimeType, data: base64Audio } },
      ]}],
    })) as GenerateContentResponse;

    const raw = r.text?.trim() ?? '{}';
    const jsonStr = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(jsonStr) as VoiceFingerprint;
  } catch (err) {
    console.warn('[dubAudio] Voice analysis failed, using defaults:', err);
    return {
      gender:       'neutral',
      pitch:        'mid-range',
      pace:         'moderate',
      energy:       'high energy',
      tone:         'professional and engaging',
      accent:       'Indian English',
      delivery:     'Clear, confident commercial voice performer. Professional advertisement delivery style.',
      breathiness:  'clear full chest voice',
      emotionLabel: 'neutral',
    };
  }
};

export const dubAudio = async (
  file: File,
  targetLang: string,
  style: string,
  targetGender: DubbingGender,
  _targetEmotion: Emotion = Emotion.NEUTRAL
): Promise<Blob> => {
  const ai = getAI();
  const base64Audio = await blobToBase64(file);
  const mimeType = file.type || 'audio/mpeg';

  // ── Step 1: Measure source duration & analyse voice in parallel ─────────────
  console.log('[dubAudio] Step 1/4 — Measuring source duration & analysing voice...');
  const [sourceDuration, fingerprint] = await Promise.all([
    getAudioDurationFromFile(file).catch(() => 0),
    analyseSourceVoice(ai, base64Audio, mimeType),
  ]);
  console.log(`[dubAudio] Source duration: ${sourceDuration.toFixed(2)}s | Voice fingerprint:`, fingerprint);

  // ── Step 2: Transcribe the source audio ──────────────────────────────────────
  console.log('[dubAudio] Step 2/4 — Transcribing source...');
  const transcription = await withRetry(() => ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ parts: [
      { text: 'Transcribe this audio exactly as spoken. Return clean text only — no labels, no timestamps.' },
      { inlineData: { mimeType, data: base64Audio } },
    ]}],
  })) as GenerateContentResponse;

  const sourceText = transcription.text?.trim();
  if (!sourceText) throw new Error('Could not detect speech in source audio.');

  // ── Step 3: Translate — duration-aware, preserving energy & rhythm ───────────
  console.log('[dubAudio] Step 3/4 — Translating...');

  // Estimate a target word count based on source duration so the AI knows the
  // density to aim for (average spoken ad script ≈ 130 words/min).
  const targetWordCount = sourceDuration > 0
    ? Math.round((sourceDuration / 60) * 130)
    : null;

  const translationPrompt = `You are a professional dubbing scriptwriter.
Translate the following advertisement script to ${targetLang} (${style} style).

CRITICAL TIMING RULES:
- The original audio is EXACTLY ${sourceDuration > 0 ? sourceDuration.toFixed(1) + ' seconds' : 'unknown duration'} long.
${targetWordCount ? `- Your translation must be spoken in the SAME ${sourceDuration.toFixed(1)} seconds. Aim for approximately ${targetWordCount} words in the target language (adjust for natural speaking pace in ${targetLang}).` : ''}
- If the direct translation is too long → condense: remove filler, tighten phrasing, keep core message.
- If the direct translation is too short → expand: add rhythm words, natural fillers, repeat key brand/product names.
- Match the original's rhythm and syllable density as closely as possible.

OTHER RULES:
- Preserve the EXACT energy, pacing intent and emotional tone of the original.
- Keep proper nouns (brand names, product names) unchanged.
- Do NOT add or remove sentences structurally — maintain the same script structure.
- Output ONLY the translated script text, nothing else.

Original script:
"${sourceText}"`;

  const translation = await withRetry(() => ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ parts: [{ text: translationPrompt }] }],
  })) as GenerateContentResponse;

  const translatedText = translation.text?.trim() || sourceText;

  // ── Step 4: Synthesise with voice fingerprint driving the TTS prompt ──────────
  console.log('[dubAudio] Step 4/4 — Synthesising with voice clone profile...');

  // Pick the closest prebuilt voice to the source gender
  let apiVoiceName: string;
  if (targetGender === 'Female') {
    apiVoiceName = 'Kore';
  } else if (targetGender === 'Male') {
    apiVoiceName = 'Fenrir';
  } else {
    // Auto: match source gender
    const isSourceFemale = fingerprint.gender.toLowerCase().includes('female')
      || fingerprint.gender.toLowerCase().includes('woman');
    apiVoiceName = isSourceFemale ? 'Kore' : 'Fenrir';
  }

  // Build a rich voice-clone prompt context from the fingerprint
  const voiceCloneContext = `VOICE CLONING DIRECTIVE — match this source performer exactly:

GENDER & PITCH: ${fingerprint.gender}, ${fingerprint.pitch}
PACE: ${fingerprint.pace}
ENERGY LEVEL: ${fingerprint.energy}
TONE: ${fingerprint.tone}
ACCENT: ${fingerprint.accent}
BREATHINESS: ${fingerprint.breathiness}
PERFORMANCE STYLE: ${fingerprint.delivery}

ABSOLUTE RULES:
- Replicate the source performer's exact energy level — do not soften or amplify beyond what is described above
- Mirror the source pacing precisely — if it was rapid-fire, stay rapid-fire; if it was slow and dramatic, stay slow and dramatic
- Match the tonal colour (bright vs dark, warm vs cold, breathy vs resonant) exactly as described
- This is a DUBBED version — the listener should feel it sounds like the same performer, just in a different language
- Do not speak any of the bracketed instruction notes. Only speak the translated text.`;

  // Build the full TTS prompt with inline audio tag to lock delivery from word 1
  const emotionAudioTag = `[${fingerprint.energy}, ${fingerprint.tone}, ${fingerprint.pace}]`;

  const chunks = translatedText.length <= 600
    ? [translatedText]
    : splitIntoChunks(translatedText, 600);

  const speechConfig = {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: apiVoiceName } },
  };

  const pcmBuffers: Uint8Array[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const taggedChunk = `${emotionAudioTag} ${chunk}`;
    const pcm = await withRetry(
      (attempt) => synthesizeChunk(ai, taggedChunk, voiceCloneContext, speechConfig, attempt)
    );
    pcmBuffers.push(pcm);
    if (chunks.length > 1 && i < chunks.length - 1) await wait(1000 + Math.random() * 400);
  }

  const totalLen = pcmBuffers.reduce((a, b) => a + b.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const buf of pcmBuffers) { merged.set(buf, offset); offset += buf.length; }

  // ── Duration lock: stretch/compress PCM to exactly match source duration ──────
  const TTS_SAMPLE_RATE = 24000;
  const ttsOutputSecs   = merged.byteLength / 2 / TTS_SAMPLE_RATE;
  console.log(`[dubAudio] TTS output: ${ttsOutputSecs.toFixed(2)}s | Source: ${sourceDuration.toFixed(2)}s`);

  let finalPcm = merged;
  if (sourceDuration > 0.5) {
    const driftRatio = ttsOutputSecs / sourceDuration;
    if (driftRatio < 0.92 || driftRatio > 1.08) {
      // More than 8 % off — apply time-stretch to snap to source duration
      console.log(`[dubAudio] Drift ${((driftRatio - 1) * 100).toFixed(1)}% — applying time-stretch...`);
      finalPcm = stretchPcmToTargetDuration(merged, ttsOutputSecs, sourceDuration, TTS_SAMPLE_RATE);
      const stretchedSecs = finalPcm.byteLength / 2 / TTS_SAMPLE_RATE;
      console.log(`[dubAudio] After stretch: ${stretchedSecs.toFixed(2)}s`);
    } else {
      console.log('[dubAudio] Duration within 8% tolerance — no stretch needed.');
    }
  }

  return pcmToMp3(finalPcm);
};

export const translateText = async (text: string, targetLang: string, style: TranscriptionStyle): Promise<string> => {
  const ai = getAI();
  const r = await withRetry(() => ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ parts: [{ text: `Translate to ${targetLang} (${style} style): "${text}"` }] }],
  })) as GenerateContentResponse;
  return r.text?.trim() || 'Translation failed.';
};

export const transcribeAudio = async (file: File, targetLang: string, style: TranscriptionStyle): Promise<string> => {
  const ai = getAI();
  const base64Audio = await blobToBase64(file);
  const r = await withRetry(() => ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ parts: [{ inlineData: { mimeType: file.type || 'audio/mpeg', data: base64Audio } }, { text: `Transcribe and translate to ${targetLang} (${style} style).` }] }],
  })) as GenerateContentResponse;
  return r.text || 'Transcription failed.';
};

export const clearAudioCache = () => {
  audioCache.clear();
  console.log('[Cache] Audio cache cleared.');
};

export const optimizeScript = async (script: string, dialect: Dialect): Promise<string> => {
  const ai = getAI();

  const prompt = `You are an expert Tamil and Indian advertising copywriter and audio producer.
Optimize the following script for the Gemini TTS engine.

Script:
"${script}"

Target Dialect: ${dialect}

Perform these optimizations:
1. INLINE STYLE TAGS: Insert (Style) tags before key phrases to control per-sentence delivery.
   Use these exact style keywords: Shouting, Peppy, Excited, Cricket Stadium, Announcement, Dramatic, Deep Bass, Cinematic Narration, Happy, Neutral, Sarcasm, Sad, Luxury, Conversational
   Example: (Peppy) Grand opening today! (Shouting) Fifty percent off! (Dramatic) Offer ends tonight.
2. FIX PRONUNCIATION:
   - Tamil words in English script → phonetically respell (e.g. "Vango" → "Vaangaw")
   - Numbers/abbreviations → spell out (e.g. "50%" → "fifty percent", "Rs.100" → "hundred rupees")
3. FORMAT: Return ONLY the optimized script text with inline (Style) tags. No notes, no markdown, no explanations.`;

  try {
    const r = await withRetry(() => ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [{ parts: [{ text: prompt }] }],
    })) as GenerateContentResponse;
    return r.text?.trim() || script;
  } catch (err) {
    console.error('[optimizeScript] Failed:', err);
    return script;
  }
};

