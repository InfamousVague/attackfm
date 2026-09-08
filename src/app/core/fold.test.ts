import { describe, expect, it } from 'vitest';
import { fold } from './fold.ts';

/*
 * This is a CROSS-LANGUAGE contract, not a convenience: server/src/discovery.rs
 * folds with the same rules, and the mirror availability map, the owned-check
 * and search all join catalogue strings to file tags through this exact shape.
 * A disagreement between the two copies means the app quietly believes a
 * mirror lacks a song it declined to copy because it already had it.
 */
describe('fold', () => {
  it('lowercases', () => {
    expect(fold('Kendrick Lamar')).toBe('kendrick lamar');
  });

  it('strips accents, however the string was composed', () => {
    // Precomposed U+00E9 and decomposed e + U+0301 are the same song.
    expect(fold('Beyoncé')).toBe('beyonce');
    expect(fold('Beyoncé')).toBe('beyonce');
    expect(fold('Sigur Rós')).toBe('sigur ros');
    expect(fold('Björk')).toBe('bjork');
  });

  it('DROPS an apostrophe rather than spacing it - one tagger in three leaves it out', () => {
    expect(fold("Don't Hurt Yourself")).toBe('dont hurt yourself');
    expect(fold('Don’t Hurt Yourself')).toBe('dont hurt yourself');
    expect(fold('Donʼt Hurt Yourself')).toBe('dont hurt yourself');
    expect(fold("Don't")).toBe(fold('Dont'));
  });

  it('collapses every other run of punctuation to ONE space', () => {
    expect(fold('Hello -- World!')).toBe('hello world');
    expect(fold('a/b\\c')).toBe('a b c');
    expect(fold('Post-Traumatic  Stress')).toBe('post traumatic stress');
  });

  it('trims the ends', () => {
    expect(fold('  Alright  ')).toBe('alright');
    expect(fold('(Alright)')).toBe('alright');
    expect(fold('...')).toBe('');
    expect(fold('')).toBe('');
  });

  it('keeps digits, which are part of a great many titles', () => {
    expect(fold('Blink-182')).toBe('blink 182');
    expect(fold('99 Problems')).toBe('99 problems');
  });

  it('keeps letters from every script, not just Latin', () => {
    // `\p{L}`, not `[a-z]`: a Japanese title must not fold to an empty string
    // and collide with every other one that does.
    expect(fold('君の名は')).toBe('君の名は');
    expect(fold('Мельница')).toBe('мельница');
    expect(fold('君の名は')).not.toBe(fold('세계'));
  });

  it('joins the spellings that actually differ between two taggers', () => {
    expect(fold('AC/DC')).toBe(fold('AC DC'));
    expect(fold('Tyler, The Creator')).toBe(fold('Tyler The Creator'));
    expect(fold('Godspeed You! Black Emperor')).toBe(fold('Godspeed You Black Emperor'));
  });

  it('still tells two different names apart', () => {
    expect(fold('Drake')).not.toBe(fold('Drake Bell'));
    expect(fold('Queen')).not.toBe(fold('Queens of the Stone Age'));
  });
});
