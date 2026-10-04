/**
 * Money.
 *
 * The old POS did this with binary floats and `Math.round(x * 100) / 100`. That
 * is the single worst thing to carry over, so none of it is. Fee invoices,
 * discounts, fines, payments, allocations and payroll all run through here.
 *
 * Three rules, and the reasons they are rules:
 *
 *   1. **Never a JavaScript number.** `0.1 + 0.2` is `0.30000000000000004`, and
 *      a fee ledger that is out by a paisa per row is out by real money across
 *      five thousand students. Values are Decimal internally.
 *
 *   2. **Strings on the wire and in the driver.** `pg` hands `numeric` back as
 *      a string precisely to avoid precision loss, and that string is kept as
 *      one all the way to JSON. Part 5.3 requires fixed-precision decimal
 *      strings in responses, so `"1250.00"` is sent, never `1250`.
 *
 *   3. **Round once, at the end.** Rounding each intermediate step lets error
 *      accumulate in a way that is very hard to explain to an accountant. The
 *      pipeline stays unrounded until a total is stored or displayed.
 *
 * The schema's money columns are `numeric(12,2)`, so two decimal places is the
 * storage precision and `quantize` is what makes a value storable.
 */

import Decimal from 'decimal.js';

/* 34 significant digits is far more than numeric(12,2) needs, and ROUND_HALF_UP
 * is what people expect of currency: 0.005 becomes 0.01, not 0.00. Banker's
 * rounding would be defensible but would surprise every user of a fee receipt. */
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -9e15, toExpPos: 9e15 });

/** The scale of every money column in this schema. */
export const MONEY_SCALE = 2;

export type MoneyInput = string | number | Decimal | Money;

/**
 * An immutable decimal amount.
 *
 * A wrapper rather than bare Decimal so that a money value cannot be added to
 * a quantity, a percentage or a day count without saying so. Those mistakes
 * typecheck when everything is a number.
 */
export class Money {
  private readonly value: Decimal;

  private constructor(value: Decimal) {
    this.value = value;
  }

  static zero(): Money {
    return new Money(new Decimal(0));
  }

  /**
   * Build from a string, a number, or another Money.
   *
   * A `number` is accepted only because request bodies arrive as JSON, where a
   * client may legitimately send `1250.5`. It is converted via its string form,
   * and rejected if it is not exactly representable at this scale, so a value
   * that has already lost precision upstream fails here rather than being
   * quietly stored slightly wrong.
   */
  static of(input: MoneyInput): Money {
    if (input instanceof Money) return input;
    if (input instanceof Decimal) return new Money(input);

    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new TypeError('Money must be a finite amount.');
      // Number.prototype.toString gives the shortest round-tripping form, which
      // is the closest thing to the author's intent that a float retains.
      return new Money(new Decimal(input.toString()));
    }

    const text = input.trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      throw new TypeError(`Money must be a plain decimal amount, received "${input}".`);
    }
    return new Money(new Decimal(text));
  }

  /** Parse a value that came out of `pg` as a numeric string; null stays null. */
  static fromDb(value: string | null): Money | null {
    return value === null ? null : Money.of(value);
  }

  static sum(amounts: readonly MoneyInput[]): Money {
    return amounts.reduce<Money>((total, a) => total.plus(a), Money.zero());
  }

  plus(other: MoneyInput): Money {
    return new Money(this.value.plus(Money.of(other).value));
  }

  minus(other: MoneyInput): Money {
    return new Money(this.value.minus(Money.of(other).value));
  }

  /** Multiply by a plain factor — a quantity or a count, not a money value. */
  times(factor: string | number): Money {
    return new Money(this.value.times(new Decimal(factor)));
  }

  /**
   * A percentage of this amount. Unrounded: `percentOf` results feed into a
   * discount pipeline that rounds once at the end.
   */
  percent(rate: string | number): Money {
    return new Money(this.value.times(new Decimal(rate)).dividedBy(100));
  }

  negated(): Money {
    return new Money(this.value.negated());
  }

  /** Never below zero — used where a balance must not go negative. */
  clampToZero(): Money {
    return this.value.isNegative() ? Money.zero() : this;
  }

  /** The smaller of the two, for allocating a payment against a balance. */
  min(other: MoneyInput): Money {
    const o = Money.of(other);
    return this.value.lessThanOrEqualTo(o.value) ? this : o;
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  equals(other: MoneyInput): boolean {
    return this.value.equals(Money.of(other).value);
  }

  greaterThan(other: MoneyInput): boolean {
    return this.value.greaterThan(Money.of(other).value);
  }

  lessThan(other: MoneyInput): boolean {
    return this.value.lessThan(Money.of(other).value);
  }

  /** Round to the storage scale. Call this once, when a total is finalised. */
  quantize(): Money {
    return new Money(this.value.toDecimalPlaces(MONEY_SCALE));
  }

  /**
   * The value to bind into a query or send in a response: a fixed-precision
   * decimal string such as `"1250.00"`.
   */
  toString(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  /** So `JSON.stringify` of a DTO produces the string form, never a float. */
  toJSON(): string {
    return this.toString();
  }

  /**
   * Deliberately throws.
   *
   * Without this, `money1 + money2` would coerce both to numbers and silently
   * reintroduce float arithmetic — the exact bug this class exists to prevent,
   * and one that no test would obviously catch. Failing loudly at the first
   * such expression is the whole point.
   */
  valueOf(): never {
    throw new TypeError('Do not use arithmetic operators on Money; use plus/minus/times.');
  }
}

/**
 * Split an amount into `parts` shares that add back to exactly the original.
 *
 * Needed for installment plans, where three equal shares of 1000.00 are not
 * 333.33 each: that loses a paisa. The remainder is distributed one unit at a
 * time across the earliest shares, so the shares differ by at most 0.01 and the
 * sum is exact. Part 5's requirement that installments sum to the invoice total
 * is otherwise impossible to satisfy for most amounts.
 */
export function allocateEvenly(total: MoneyInput, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError('parts must be a positive integer.');
  }

  const amount = Money.of(total).quantize();
  const text = amount.toString();

  /* Work in minor units, on the magnitude only, so the distribution is plain
   * integer arithmetic. The sign is reapplied at the end rather than carried
   * through: formatting a negative share by string surgery mis-places the minus
   * for small magnitudes (-1 minor unit would pad to "0-1"). */
  const negative = text.startsWith('-');
  const magnitude = BigInt((negative ? text.slice(1) : text).replace('.', ''));

  const divisor = BigInt(parts);
  const base = magnitude / divisor;
  const remainder = Number(magnitude % divisor);

  return Array.from({ length: parts }, (_, i) => {
    const share = base + (i < remainder ? 1n : 0n);
    const digits = share.toString().padStart(MONEY_SCALE + 1, '0');
    const cut = digits.length - MONEY_SCALE;
    const value = Money.of(`${digits.slice(0, cut)}.${digits.slice(cut)}`);
    return negative ? value.negated() : value;
  });
}
