// Tests for bench/lib/fw-metrics.js — the runners' parser for fg-run's metrics lines.
import { describe, it, expect } from 'vitest';
import { extractFwMetrics } from '../bench/lib/fw-metrics.js';
import { extractFinalAnswer } from '../bench/lib/answer-extract.js';

describe('extractFwMetrics', () => {
    it('accepts the current and legacy markers', () => {
        for (const marker of ['__FG_METRICS__', '__FW_METRICS__']) {
            const r = extractFwMetrics(`${marker}:{"input_tokens":5,"output_tokens":2}\nhello\n`);
            expect(r.metrics).toEqual({ input_tokens: 5, output_tokens: 2 });
            expect(r.output).toBe('hello\n');
        }
    });
    it('uses the last line of a per-step stream and strips every line', () => {
        const raw = '__FG_METRICS__:{"input_tokens":10}\n__FG_METRICS__:{"input_tokens":25}\nanswer\n';
        const r = extractFwMetrics(raw);
        expect(r.metrics.input_tokens).toBe(25);
        expect(r.output).toBe('answer\n');
    });
    it('keeps the last valid total from a killed run whose final line is cut off', () => {
        const r = extractFwMetrics('__FG_METRICS__:{"input_tokens":10}\n__FG_METRICS__:{"input_tok');
        expect(r.metrics.input_tokens).toBe(10);
    });
    it('returns empty metrics and untouched output when there is no metrics line', () => {
        expect(extractFwMetrics('plain')).toEqual({ metrics: {}, output: 'plain' });
        expect(extractFwMetrics(undefined)).toEqual({ metrics: {}, output: '' });
    });
});

describe('extractFinalAnswer with metrics lines', () => {
    it('never returns a metrics line as the answer', () => {
        expect(extractFinalAnswer('__FG_METRICS__:{"a":1}\n__FG_METRICS__:{"a":2}\n')).toBe('');
        expect(extractFinalAnswer('__FG_METRICS__:{"a":1}\n42\n')).toBe('42');
    });
});
