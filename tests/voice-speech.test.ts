// OpenRouter answers a speech request with raw PCM; an <audio> element plays it only as a WAV. And a saved list that names a retired model moves to its successor.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { pcmToWav, playableSpeech } from '../voice.ts';
import { renameRetiredVoiceModels } from '../storage-keys.ts';

// jsdom's Blob has no arrayBuffer(); browsers do.
beforeAll(() => { vi.stubGlobal('Blob', NodeBlob); });
afterAll(() => { vi.unstubAllGlobals(); });

const resp = (type: string, bytes: number[]) => ({ headers: { get: () => type }, blob: async () => new Blob([new Uint8Array(bytes)]) });
const text = (b: Uint8Array, o: number) => String.fromCharCode(...b.slice(o, o + 4));

describe('speech playback', () => {
    it('wraps raw PCM in a WAV header with the rate and channels of its content type', async () => {
        const blob = await playableSpeech(resp('audio/pcm;rate=16000;channels=2', [1, 2, 3, 4]));
        expect(blob.type).toBe('audio/wav');
        const b = new Uint8Array(await blob.arrayBuffer()), v = new DataView(b.buffer);
        expect([text(b, 0), text(b, 8), text(b, 36)]).toEqual(['RIFF', 'WAVE', 'data']);
        expect([v.getUint32(24, true), v.getUint16(22, true), v.getUint32(40, true), b.length]).toEqual([16000, 2, 4, 48]);
        expect(pcmToWav(new Uint8Array(2)).length).toBe(46);
    });
    it('leaves a response in a container the browser plays as it is', async () => {
        for (const type of ['audio/mpeg', 'audio/wav']) expect((await playableSpeech(resp(type, [1, 2]))).type).toBe('');
    });
});

describe('retired voice models', () => {
    it('are replaced in a saved list, once', () => {
        expect(renameRetiredVoiceModels(['groq|distil-whisper-large-v3-en', 'groq|whisper-large-v3-turbo', 'openrouter|qwen/qwen3-asr-flash', 'browser|webspeech']))
            .toEqual(['groq|whisper-large-v3-turbo', 'openrouter|qwen/qwen3-asr-1.7b', 'browser|webspeech']);
    });
});
