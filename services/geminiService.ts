
import { GoogleGenAI, GenerateContentResponse, Modality } from "@google/genai";
import { Dialect, Emotion, VoiceOption, TranscriptionStyle, DubbingGender, SpeechPacing } from '../types';
import { decodeBase64ToUint8Array, pcmToMp3, blobToBase64, getAudioDurationFromFile, stretchPcmToTargetDuration } from '../utils/audio';

// ─── Constants ────────────────────────────────────────────────────────────────
const TTS_MODEL  = 'gemini-3.1-flash-tts-preview';
const TEXT_MODEL = 'gemini-3.6-flash';

const decodeDefaultKey = () => {
  try {
    return atob('QVEuQWI4Uk42SlA3UmVWNmpwZmhzaUxMRkh3ZUJCVmREOUlTZGt0TDhCa3lTZTVCM29DWEE=');
  } catch (e) {
    return '';
  }
};

// ─── AI Client ────────────────────────────────────────────────────────────────
const getAI = () => {
  const envKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
  const apiKey = (envKey && envKey !== 'undefined' && envKey.trim() !== '')
    ? envKey.trim()
    : decodeDefaultKey();
  return new GoogleGenAI({ apiKey });
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Retry logic ──────────────────────────────────────────────────────────────
/**
 * 4 retries with fast exponential backoff.
 * - Quota 429 → throw / retry with slight backoff
 * - Respects "retry in Xs" hints from the API
 */
const withRetry = async <T>(
  operation: (attempt: number) => Promise<T>,
  maxRetries = 3,
  baseDelay = 300
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

      const isQuota429 = status === 429 || errorMessage.toLowerCase().includes('quota') || errorMessage.includes('429');

      if (i < maxRetries) {
        const isTTSError   = errorMessage.includes('TTS_ENGINE_ERROR');
        const isOtherError = errorMessage.includes('OTHER');

        // Quota / Rate Limit 429 → Wait 2.5s base + exponential. OTHER → 2000ms. TTS → 800ms.
        let delay = (isQuota429 ? 2500 : (isOtherError ? 2000 : (isTTSError ? 800 : baseDelay)))
          * Math.pow(1.6, i)
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
  [Emotion.SHOUTING]: `Style: MAXIMUM ENERGY retail commercial announcer. SHOUT every word at full volume with intense street sale energy.`,
  [Emotion.PEPPY]: `Style: Bright, bubbly Indian FM radio jockey. Fast, bouncy, punchy rhythm with a constant smile.`,
  [Emotion.EXCITED]: `Style: Product launch announcer. High pitch, breathless enthusiasm and maximum excitement.`,
  [Emotion.CRICKET_STADIUM]: `Style: Live cricket stadium PA announcer. Roaring, electric stadium energy.`,
  [Emotion.ANNOUNCEMENT]: `Style: Formal corporate spokesperson. Deep, authoritative, measured and official delivery.`,
  [Emotion.DRAMATIC]: `Style: Cinematic film trailer narrator. Speak slowly with theatrical gravitas and tension.`,
  [Emotion.HAPPY]: `Style: Warm, joyful festive commercial voice. Bright, light, smiling and welcoming.`,
  [Emotion.NEUTRAL]: `Style: Professional TV news anchor. Clear, calm, precise and measured delivery.`,
  [Emotion.SARCASM]: `Style: Witty comedian in TV ad. Dry irony, knowing smirk, strategic pauses.`,
  [Emotion.SAD]: `Style: Heartfelt storyteller. Soft, gentle, sincere emotional delivery.`,
  [Emotion.LUXURY]: `Style: Ultra-premium luxury brand. Velvety, smooth, unhurried, understated perfection.`,
  [Emotion.CONVERSATIONAL]: `Style: Casual friend in natural 1-on-1 chat. Organic speech rhythm.`,
  [Emotion.DEEP_BASS]: `Style: Deepest bass narrator. Subwoofer chest resonance, slow drumbeat pacing, maximum gravitas.`,
  [Emotion.CINEMATIC_NARRATION]: `Style: Epic Hollywood trailer narrator. Explosive IMAX gravitas and thunderous peaks.`,
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

// ─── Per-voice persona overrides ─────────────────────────────────────────────
/**
 * Strong per-voice-ID delivery instructions that override the generic emotion
 * profile for voices that share the same API voice name.
 * This is what makes e.g. "Scarlett Warm" actually sound different from "Anitha".
 */
const VOICE_PERSONA_OVERRIDES: Record<string, string> = {
  m_chennai_1: `VOICE CHARACTER OVERRIDE: You are ARJUN — a bold, street-smart Chennai local male. Speak with authentic Madras Bashai swagger. Energetic, punchy consonants. Drop into colloquial rhythm naturally.`,
  f_classic_1: `VOICE CHARACTER OVERRIDE: You are ANITHA — a refined, traditional Tamil female news anchor. Elegant, measured diction. Formal Senthamizh pronunciation. Dignified, never shrill. Every word is precise.`,
  m_rj_1:      `VOICE CHARACTER OVERRIDE: You are VIKRAM — a hyperactive FM radio jockey. Speak incredibly fast and punchy, with a constant smile in your voice. High energy, snappy transitions, zero dead air.`,
  f_modern_1:  `VOICE CHARACTER OVERRIDE: You are PRIYA — a bubbly, modern urban city girl. Light, airy, bright vocal tone. Casual and friendly. Millennial energy — spontaneous, warm, relatable.`,
  m_corp_1:    `VOICE CHARACTER OVERRIDE: You are SAM — a polished Indian English corporate announcer. Mid-range baritone, clear and confident. Professional but approachable. Perfect diction without sounding robotic.`,
  f_warm_1:    `VOICE CHARACTER OVERRIDE: You are SCARLETT (Cinematic Warm) — a breathy, warm, emotionally rich female voice. Slightly husky lower register. Intimate and cinematic. Every sentence feels like a close whisper into the listener's ear.`,
  f_power_1:   `VOICE CHARACTER OVERRIDE: You are SCARLETT (Power Ad) — a commanding, deep, punchy female commercial voice. Strong chest resonance. Authoritative without being masculine. Every word lands with weight and confidence.`,
  f_narrative_1:`VOICE CHARACTER OVERRIDE: You are SCARLETT (Smooth Narration) — a velvety smooth female narrator. Silky mid-range tone, unhurried pace, zero harshness. The voice of luxury documentaries and premium brand films.`,
  f_husky_1:   `VOICE CHARACTER OVERRIDE: You are SCARLETT (Sultry Husky) — a deep, husky, distinctly cinematic female voice. Lower-pitched than typical female voices. Rich, gravelly texture underneath warmth. Magnetic and unforgettable.`,
  m_narrator_1:`VOICE CHARACTER OVERRIDE: You are KABIR — a deep, authoritative male narrator. Full bass resonance, slow and deliberate pacing. The voice of trust — news documentaries, institutional ads, government campaigns. Calm authority.`,
  f_soft_1:    `VOICE CHARACTER OVERRIDE: You are MAYA — a gentle, soft-spoken female storyteller. Soft breathiness, minimal projection. Tender and sincere — like a mother reading a bedtime story. Never loud, always sincere.`,
  m_deepbass_1:`VOICE CHARACTER OVERRIDE: You are TITAN — the deepest male bass voice possible. Speak from the absolute lowest register. Subwoofer chest resonance on every syllable. James Earl Jones meets a thunderstorm. Minimal inflection, maximum gravitas.`,
  m_cinematic_1:`VOICE CHARACTER OVERRIDE: You are RAJAN — an epic Hollywood-style Tamil movie trailer narrator. Builds dramatic tension across each sentence. Thunderous peaks, controlled valleys. Every word feels like a title card slamming into frame.`,
  f_cinematic_1:`VOICE CHARACTER OVERRIDE: You are ZARA — a deep, commanding female cinematic narrator. Lower than typical female voices, resonant and projecting. Epic, sweeping energy. Commands the room without effort.`,
  m_deepbass_2:`VOICE CHARACTER OVERRIDE: You are ANAND (Velvet Thunder) — a smooth baritone with paradoxical warmth and weight. Imagine velvet wrapped around rolling thunder. Cultured, intelligent, slightly theatrical. Never shouts — power through restraint.`,
  f_parrot_1:  `VOICE CHARACTER OVERRIDE: You are KOKO — a cute, high-pitched, excitable talking parrot. Speak in an ultra high-pitched squeaky parrot voice with parrot vocalizations (squawks, chirps, whistles) interspersed throughout.`,
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
    [Dialect.CHENNAI_TAMIL]:  'Chennai Tamil colloquial accent',
    [Dialect.CLASSIC_TAMIL]:  'Formal Classic Senthamizh',
    [Dialect.INDIAN_ENGLISH]: 'Indian English accent',
    [Dialect.REGULAR_ENGLISH]: 'Neutral English accent',
  };

  let emotionInstruction = EMOTION_SYSTEM_INSTRUCTIONS[emotion] ?? `Style: ${emotion}`;

  if (voice.id === 'f_parrot_1') {
    emotionInstruction = `Style: Cute high-pitched talking parrot. Interject parrot squawks/chirps/whistles.`;
  }

  const dialectStyle = dialectMap[dialect] ?? String(dialect);
  const voicePersonaOverride = VOICE_PERSONA_OVERRIDES[voice.id] ?? `Voice: ${voice.persona}`;

  let context = `${emotionInstruction} Pacing: ${pacing}. Dialect: ${dialectStyle}. ${voicePersonaOverride}.`;

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
  const CONCURRENCY = 2;
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

  // Run in parallel batches of CONCURRENCY with rate-limit friendly throttle
  for (let start = 0; start < allChunks.length; start += CONCURRENCY) {
    if (start > 0) await wait(80);
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
    if (chunks.length > 1 && i < chunks.length - 1) await wait(100);
  }

  const totalLen = pcmBuffers.reduce((a, b) => a + b.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const buf of pcmBuffers) { merged.set(buf, offset); offset += buf.length; }

  // ── Duration lock: gentle stretch/compress PCM to match source duration ──────
  // IMPORTANT: Only apply WSOLA stretch when drift is between 8% and 20%.
  // Beyond 20% drift the translated script itself is too different in length —
  // aggressive stretching causes the "chipmunk" pitch artifact. In that case,
  // we output the natural TTS duration instead of forcing an unnatural stretch.
  const TTS_SAMPLE_RATE = 24000;
  const ttsOutputSecs   = merged.byteLength / 2 / TTS_SAMPLE_RATE;
  console.log(`[dubAudio] TTS output: ${ttsOutputSecs.toFixed(2)}s | Source: ${sourceDuration.toFixed(2)}s`);

  let finalPcm = merged;
  if (sourceDuration > 0.5) {
    const driftRatio = ttsOutputSecs / sourceDuration;
    const driftPct   = Math.abs((driftRatio - 1) * 100);

    if (driftPct > 8 && driftPct <= 20) {
      // Moderate drift (8–20%) — safe to apply gentle WSOLA stretch
      console.log(`[dubAudio] Drift ${((driftRatio - 1) * 100).toFixed(1)}% — applying gentle time-stretch...`);
      finalPcm = stretchPcmToTargetDuration(merged, ttsOutputSecs, sourceDuration, TTS_SAMPLE_RATE);
      const stretchedSecs = finalPcm.byteLength / 2 / TTS_SAMPLE_RATE;
      console.log(`[dubAudio] After stretch: ${stretchedSecs.toFixed(2)}s`);
    } else if (driftPct > 20) {
      // Large drift — skip stretch to avoid chipmunk/robotic artifacts.
      // The translated script is a naturally different length; forcing it
      // to match would degrade audio quality significantly.
      console.log(`[dubAudio] Drift ${((driftRatio - 1) * 100).toFixed(1)}% — too large for safe stretch, outputting natural TTS duration.`);
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

