import { describe, it, expect } from 'vitest';
import { cleanTextForSpeech } from './kokoroTts';

describe('cleanTextForSpeech', () => {
  it('strips emojis and pictographs so TTS does not speak them', () => {
    const input = 'Hello! 😊 Great job on Question 10. ✅ That is correct.';
    const result = cleanTextForSpeech(input);
    expect(result).toBe('Hello! Great job on Question 10. That is correct.');
    expect(result).not.toContain('😊');
    expect(result).not.toContain('✅');
  });

  it('strips warning signs, crosses, and thumbs up', () => {
    const input = '⚠️ Warning: ❌ Incorrect answer. Try again! 👍';
    const result = cleanTextForSpeech(input);
    expect(result).toBe('Warning: Incorrect answer. Try again!');
    expect(result).not.toContain('⚠️');
    expect(result).not.toContain('❌');
    expect(result).not.toContain('👍');
  });

  it('strips text emoticons while keeping alphanumeric letters', () => {
    const input = 'You got it :) Option A. Whole Life Insurance';
    const result = cleanTextForSpeech(input);
    expect(result).toBe('You got it Option A. Whole Life Insurance');
  });

  it('strips markdown bold, italic, and code blocks cleanly', () => {
    const input = 'Here is **Question 11**: What is *irrevocable*? ```python\nprint(1)\n``` Answer below.';
    const result = cleanTextForSpeech(input);
    expect(result).toBe('Here is Question 11: What is irrevocable? Answer below.');
  });
});

