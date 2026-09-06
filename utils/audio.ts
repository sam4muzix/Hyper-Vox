// @ts-ignore
import { Mp3Encoder } from 'lamejs';

// Utility to convert raw PCM data to WAV format
export const pcmToWav = (pcmData: Uint8Array, sampleRate: number = 24000, numChannels: number = 1): Blob => {
  const buffer = pcmData.buffer;
  const dataLength = buffer.byteLength;
  const headerLength = 44;
  const wavData = new Uint8Array(headerLength + dataLength);
  const view = new DataView(wavData.buffer);

  // RIFF identifier
  writeString(view, 0, 'RIFF');
  // file length
  view.setUint32(4, 36 + dataLength, true);
  // RIFF type
  writeString(view, 8, 'WAVE');
  // format chunk identifier
  writeString(view, 12, 'fmt ');
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (raw)
  view.setUint16(20, 1, true);
  // channel count
  view.setUint16(22, numChannels, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sample rate * block align)
  view.setUint32(28, sampleRate * numChannels * 2, true); // 16-bit
  // block align (channel count * bytes per sample)
  view.setUint16(32, numChannels * 2, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier
  writeString(view, 36, 'data');
  // data chunk length
  view.setUint32(40, dataLength, true);

  // Write PCM samples
  wavData.set(pcmData, 44);

  return new Blob([wavData], { type: 'audio/wav' });
};

// Utility to convert raw PCM data to MP3 format
export const pcmToMp3 = (pcmData: Uint8Array, sampleRate: number = 24000, numChannels: number = 1): Blob => {
  try {
    // Convert Uint8Array (bytes) to Int16Array (samples)
    // Gemini returns Little Endian 16-bit PCM.
    const wavSamples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);
    
    // NOTE: We use Mp3Encoder from @breezystack/lamejs which is a class
    const mp3encoder = new Mp3Encoder(numChannels, sampleRate, 128); // 128kbps
    const mp3Data = [];
    
    // Lamejs expects samples. If mono, passed as left channel.
    const blockSize = 1152; // multiple of 576
    for (let i = 0; i < wavSamples.length; i += blockSize) {
      const sampleChunk = wavSamples.subarray(i, i + blockSize);
      const mp3buf = mp3encoder.encodeBuffer(sampleChunk);
      if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
      }
    }
    
    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }
    
    return new Blob(mp3Data, { type: 'audio/mp3' });
  } catch (e) {
    console.error("MP3 Encoding failed (MPEGMode/Lamejs error). Falling back to WAV.", e);
    // Fallback to WAV to ensure user gets audio even if encoding fails
    return pcmToWav(pcmData, sampleRate, numChannels);
  }
};

const writeString = (view: DataView, offset: number, string: string) => {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
};

export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        // Remove data URL prefix (e.g., "data:audio/mp3;base64,")
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      } else {
        reject(new Error('Failed to convert blob to base64'));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

export const decodeBase64ToUint8Array = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

/**
 * Returns the exact playback duration (seconds) of an audio File.
 * Uses a hidden HTMLAudioElement so it works for MP3/WAV/M4A/etc.
 */
export const getAudioDurationFromFile = (file: File): Promise<number> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(audio.duration);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read audio duration'));
    };
    audio.src = url;
  });

/**
 * Time-stretches 16-bit LE mono PCM to hit an exact target duration WITHOUT changing pitch.
 * Uses WSOLA (Waveform Similarity Overlap-Add) pitch-preserved time-scale modification.
 * Prevents the "chipmunk / squeaky" voice effect during dubbing time alignment.
 *
 * @param pcm          Raw 16-bit LE PCM bytes (Gemini TTS output)
 * @param sourceSecs   Actual duration of the pcm in seconds
 * @param targetSecs   Desired output duration in seconds
 * @param sampleRate   PCM sample rate (Gemini = 24000)
 */
export const stretchPcmToTargetDuration = (
  pcm: Uint8Array,
  sourceSecs: number,
  targetSecs: number,
  sampleRate: number = 24000
): Uint8Array => {
  if (sourceSecs <= 0.05 || targetSecs <= 0.05) return pcm;

  const rawRatio = targetSecs / sourceSecs;
  // Clamp stretch ratio between 0.65 and 1.5 to keep speech completely natural
  const stretchRatio = Math.min(Math.max(rawRatio, 0.65), 1.5);

  // If stretch ratio is within 3% of 1.0, return original PCM directly
  if (Math.abs(stretchRatio - 1.0) < 0.03) {
    return pcm;
  }

  const BYTES_PER_SAMPLE = 2;
  const inputSamplesCount = Math.floor(pcm.byteLength / BYTES_PER_SAMPLE);
  if (inputSamplesCount < 1000) return pcm;

  const input = new Int16Array(pcm.buffer, pcm.byteOffset, inputSamplesCount);

  // WSOLA parameters optimized for 24kHz speech
  const N = 576; // Frame size (24ms at 24kHz)
  const H_s = 288; // Synthesis hop size (12ms overlap)
  const H_a = Math.max(16, Math.round(H_s / stretchRatio)); // Analysis hop size
  const searchRange = 144; // Search range for cross-correlation (6ms)

  // Calculate output length
  const numSteps = Math.floor((inputSamplesCount - N - searchRange) / H_a);
  if (numSteps <= 0) return pcm;

  const outputSamplesCount = Math.round(numSteps * H_s + N);
  const output = new Float32Array(outputSamplesCount);
  const weights = new Float32Array(outputSamplesCount);

  // Hanning window for smooth cross-fading
  const window = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }

  let outPos = 0;
  let prevAnalysisPos = 0;

  for (let step = 0; step < numSteps; step++) {
    const targetAnalysisPos = Math.round(step * H_a);
    let bestDelta = 0;

    // Find best match position in search range using cross-correlation
    if (step > 0) {
      let maxCorr = -Infinity;
      const refPos = prevAnalysisPos + H_s;

      for (let delta = -searchRange; delta <= searchRange; delta += 2) {
        const candidatePos = targetAnalysisPos + delta;
        if (candidatePos < 0 || candidatePos + N >= inputSamplesCount || refPos + N >= inputSamplesCount) continue;

        let corr = 0;
        for (let k = 0; k < N; k += 8) {
          corr += input[refPos + k] * input[candidatePos + k];
        }

        if (corr > maxCorr) {
          maxCorr = corr;
          bestDelta = delta;
        }
      }
    }

    const actualAnalysisPos = Math.min(Math.max(targetAnalysisPos + bestDelta, 0), inputSamplesCount - N);
    prevAnalysisPos = actualAnalysisPos;

    // Overlap-add windowed frame
    for (let k = 0; k < N; k++) {
      const idx = outPos + k;
      if (idx < outputSamplesCount) {
        output[idx] += input[actualAnalysisPos + k] * window[k];
        weights[idx] += window[k];
      }
    }

    outPos += H_s;
  }

  // Normalize by overlap weights & convert back to Int16 PCM
  const resultPCM = new Int16Array(outputSamplesCount);
  for (let i = 0; i < outputSamplesCount; i++) {
    const w = weights[i] > 0.001 ? weights[i] : 1.0;
    const sample = output[i] / w;
    resultPCM[i] = Math.min(Math.max(Math.round(sample), -32768), 32767);
  }

  return new Uint8Array(resultPCM.buffer);
};

// ── Brand Name Extraction & Dynamic Output Filenames ──────────────────────────

/**
 * Intelligently extracts the brand name from an ad script or returns a clean fallback.
 * Used for dynamic output file naming (e.g. Saravana_Stores_ad_master.mp3).
 */
export function extractBrandName(script: string): string {
  if (!script || !script.trim()) return 'Ad_Master';

  const prefixRegex = /^(?:Enna|Welcome|Hello|Vanakkam|Idho|Hey|The|A|An|In|On|At|For|With|Your|Our|My|Buy|Get|Visit|Call|Check|Try)\s+/i;

  // 1. Explicit brand tag e.g. "Brand: Saravana Stores"
  const explicitMatch = script.match(/(?:brand|campaign|store|company|product|shop)\s*:\s*([A-Za-z0-9\u0B80-\u0BFF\s'-]{2,30})/i);
  if (explicitMatch && explicitMatch[1].trim()) {
    return sanitizeFilename(explicitMatch[1].replace(prefixRegex, ''));
  }

  // 2. Quoted brand e.g. "Saravana Stores" or 'KUMARAN SILKS'
  const quoteMatch = script.match(/["'“]([A-Za-z0-9\u0B80-\u0BFF\s]{2,30})["'”]/);
  if (quoteMatch && quoteMatch[1].trim()) {
    return sanitizeFilename(quoteMatch[1].replace(prefixRegex, ''));
  }

  // 3. Multi-word capitalized proper noun (e.g., Saravana Stores, Kumaran Silks, Poorvika Mobiles)
  const capitalizedMatch = script.match(/\b([A-Z][a-zA-Z0-9'\-]+(?:\s+[A-Z][a-zA-Z0-9'\-]+){1,3})\b/);
  if (capitalizedMatch && capitalizedMatch[1].trim()) {
    const candidate = capitalizedMatch[1].replace(prefixRegex, '').trim();
    if (candidate.length > 2) {
      return sanitizeFilename(candidate);
    }
  }

  // 4. Single capitalized word
  const singleCapMatch = script.match(/\b([A-Z][a-zA-Z0-9'\-]{2,20})\b/g);
  if (singleCapMatch) {
    const filtered = singleCapMatch
      .map(w => w.replace(prefixRegex, '').trim())
      .filter(w => w.length > 2 && !/^(Enna|Welcome|Hello|Vanakkam|Idho|Hey|The|A|An|In|On|At|For|With|Your|Our|My|Offer|Sale|Mega|Grand|Discount|Special|Today|Only|Now|Get|Buy|Free|Call|Visit|Shop|Store)$/i.test(w));
    if (filtered.length > 0) {
      return sanitizeFilename(filtered[0]);
    }
  }

  // 5. Fallback: first words
  const cleanWords = script.replace(/[^\w\s\u0B80-\u0BFF]/g, '').trim().split(/\s+/).slice(0, 3).join('_');
  if (cleanWords) {
    return sanitizeFilename(cleanWords);
  }

  return 'Ad_Master';
}

function sanitizeFilename(str: string): string {
  return str
    .trim()
    .replace(/[^\w\u0B80-\u0BFF\s-]/g, '')  // Keep alphanumeric, spaces, hyphens, Tamil Unicode
    .replace(/\s+/g, '_')                   // Replace spaces with underscores
    .slice(0, 40)                           // Max 40 chars
    || 'Ad_Master';
}

export function getBrandFilename(script: string, suffix: string = 'master', ext: string = 'mp3'): string {
  const brand = extractBrandName(script);
  return `${brand}_${suffix}.${ext}`;
}