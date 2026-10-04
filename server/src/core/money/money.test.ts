/**
 * Money is the one piece of this foundation where a wrong answer is silent,
 * survives review, and costs real money, so it is tested first and hardest.
 */

import { describe, expect, it } from 'vitest';
import { Money, allocateEvenly } from './money';

describe('Money', () => {
  it('adds without float error', () => {
    // 0.1 + 0.2 === 0.30000000000000004 as JavaScript numbers.
    expect(Money.of('0.10').plus('0.20').toString()).toBe('0.30');
  });

  it('keeps precision across a long chain of fee items', () => {
    const total = Money.sum(Array.from({ length: 3 }, () => '0.10'));
    expect(total.toString()).toBe('0.30');
  });

  it('always renders at the storage scale', () => {
    expect(Money.of('1250').toString()).toBe('1250.00');
    expect(Money.of('1250.5').toString()).toBe('1250.50');
    expect(Money.zero().toString()).toBe('0.00');
  });

  it('rounds half up, as a fee receipt is expected to', () => {
    expect(Money.of('1.005').quantize().toString()).toBe('1.01');
    expect(Money.of('2.675').quantize().toString()).toBe('2.68');
  });

  it('does not round intermediate steps', () => {
    // A 33.333% discount on 100 held unrounded, then rounded once.
    const discount = Money.of('100.00').percent('33.333');
    expect(discount.quantize().toString()).toBe('33.33');
  });

  it('rejects anything that is not a plain decimal', () => {
    expect(() => Money.of('1,250.00')).toThrow(/plain decimal/);
    expect(() => Money.of('abc')).toThrow(/plain decimal/);
    expect(() => Money.of('')).toThrow(/plain decimal/);
    expect(() => Money.of(Number.NaN)).toThrow(/finite/);
  });

  it('refuses to be used with arithmetic operators', () => {
    const a = Money.of('1.00');
    // The guard that stops float arithmetic creeping back in unnoticed.
    expect(() => a.valueOf()).toThrow(/Do not use arithmetic operators/);
  });

  it('serialises to a string in JSON, never a float', () => {
    const body = JSON.stringify({ total: Money.of('1250.5') });
    expect(body).toBe('{"total":"1250.50"}');
  });

  it('clamps and compares for balance arithmetic', () => {
    expect(Money.of('50.00').minus('80.00').clampToZero().toString()).toBe('0.00');
    expect(Money.of('50.00').min('80.00').toString()).toBe('50.00');
    expect(Money.of('80.00').min('50.00').toString()).toBe('50.00');
    expect(Money.of('80.00').greaterThan('50.00')).toBe(true);
  });

  it('reads a numeric column from pg without losing precision', () => {
    expect(Money.fromDb('1250.00')?.toString()).toBe('1250.00');
    expect(Money.fromDb(null)).toBeNull();
  });
});

describe('allocateEvenly', () => {
  it('splits so the shares add back exactly', () => {
    const shares = allocateEvenly('1000.00', 3);
    expect(shares.map(String)).toEqual(['333.34', '333.33', '333.33']);
    expect(Money.sum(shares).toString()).toBe('1000.00');
  });

  it('is exact for every part count up to 24', () => {
    // The installment-plan invariant: the parts must equal the invoice total,
    // which the database also checks. A single lost paisa fails both.
    for (let parts = 1; parts <= 24; parts += 1) {
      const shares = allocateEvenly('10000.00', parts);
      expect(shares).toHaveLength(parts);
      expect(Money.sum(shares).toString()).toBe('10000.00');
    }
  });

  it('handles an amount smaller than the part count', () => {
    const shares = allocateEvenly('0.02', 3);
    expect(shares.map(String)).toEqual(['0.01', '0.01', '0.00']);
    expect(Money.sum(shares).toString()).toBe('0.02');
  });

  it('handles negative amounts, used for carry-forward credits', () => {
    const shares = allocateEvenly('-0.01', 1);
    expect(shares.map(String)).toEqual(['-0.01']);

    const split = allocateEvenly('-1000.00', 3);
    expect(split.map(String)).toEqual(['-333.34', '-333.33', '-333.33']);
    expect(Money.sum(split).toString()).toBe('-1000.00');
  });

  it('rejects a nonsensical part count', () => {
    expect(() => allocateEvenly('10.00', 0)).toThrow(/positive integer/);
    expect(() => allocateEvenly('10.00', 1.5)).toThrow(/positive integer/);
  });
});
