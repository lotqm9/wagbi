// The word rules every function shares: plain text from a stranger, the slur check, the house ticker.
// Kept apart from engine.js so the launch function can check edited words without loading the model
// client or the SVG renderer.
import { DataSet, RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity';
import { BRAND } from './brand.js';

/** One line of plain text from a stranger: no control characters, single spaces, trimmed. */
export function cleanSentence(s) {
  if (typeof s !== 'string') return '';
  return s.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
}

// slurs, from obscenity's english list, checked before any money is spent. Only the slurs: its sexual words
// ("moby dick", "a cock that crows") are left to the model's own verdict, which reads them in context.
const SLURS = new Set(['abo', 'abeed', 'africoon', 'arabush', 'boonga', 'chingchong', 'chink', 'dyke', 'fag', 'kike', 'negro', 'nigger', 'retard', 'spastic', 'tranny']);
let matcher = null;
export function badWords(text) {
  if (!matcher) {
    const dataset = new DataSet().addAll(englishDataset).removePhrasesIf((p) => !SLURS.has(p.metadata?.originalWord ?? ''));
    matcher = new RegExpMatcher({ ...dataset.build(), ...englishRecommendedTransformers });
  }
  return matcher.hasMatch(text);
}

const squash = (s) => s.toUpperCase().replace(/[^A-Z]/g, '').replace(/(.)\1+/g, '$1');
export const isHouse = (t) => squash(t) === squash(BRAND.ticker);
