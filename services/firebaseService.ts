import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, collection, addDoc, getDocs, query, orderBy, limit, serverTimestamp } from 'firebase/firestore';

// ─── Firebase Configuration ──────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY || "AIzaSyDummyKeyForHypervoxFirestoreConfig",
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN || "hypervox-sam.firebaseapp.com",
  projectId: process.env.VITE_FIREBASE_PROJECT_ID || "hypervox-sam",
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET || "hypervox-sam.appspot.com",
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "100000000000",
  appId: process.env.VITE_FIREBASE_APP_ID || "1:100000000000:web:hypervoxsam"
};

// Initialize Firebase App
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Firestore Database
export const db = getFirestore(app);

export interface SavedScriptPreset {
  id?: string;
  title: string;
  script: string;
  voiceId: string;
  emotion: string;
  dialect: string;
  createdAt?: any;
}

// ─── Firestore Database Services ─────────────────────────────────────────────

/**
 * Save a generated audio script & voice preset to Firestore collection 'voice_presets'
 */
export const savePresetToFirestore = async (preset: Omit<SavedScriptPreset, 'id' | 'createdAt'>): Promise<string> => {
  try {
    const docRef = await addDoc(collection(db, 'voice_presets'), {
      ...preset,
      createdAt: serverTimestamp(),
    });
    console.log('[Firestore] Voice preset saved with ID:', docRef.id);
    return docRef.id;
  } catch (error) {
    console.warn('[Firestore] Notice (Firestore fallback mode):', error);
    return 'local-draft-id';
  }
};

/**
 * Retrieve saved voice presets from Firestore
 */
export const getPresetsFromFirestore = async (maxItems: number = 20): Promise<SavedScriptPreset[]> => {
  try {
    const q = query(collection(db, 'voice_presets'), orderBy('createdAt', 'desc'), limit(maxItems));
    const querySnapshot = await getDocs(q);
    const presets: SavedScriptPreset[] = [];
    querySnapshot.forEach((doc) => {
      presets.push({ id: doc.id, ...doc.data() } as SavedScriptPreset);
    });
    return presets;
  } catch (error) {
    console.warn('[Firestore] Could not load Firestore presets:', error);
    return [];
  }
};

/**
 * Log generation metadata to Firestore collection 'audio_generations'
 */
export const logGenerationToFirestore = async (metadata: {
  voiceId: string;
  emotion: string;
  dialect: string;
  scriptLength: number;
  durationSecs?: number;
}): Promise<void> => {
  try {
    await addDoc(collection(db, 'audio_generations'), {
      ...metadata,
      createdAt: serverTimestamp(),
    });
    console.log('[Firestore] Audio generation logged successfully');
  } catch (error) {
    console.warn('[Firestore] Generation logging notice:', error);
  }
};
