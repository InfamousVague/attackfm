import { Check } from '@glacier/icons';
import type { ThemePreviewPalette } from '@glacier/tokens';
import type { CSSProperties, ReactNode } from 'react';
import styles from './ThemeSelector.module.css';

export interface ThemeSelectorOption<Value extends string = string> {
  value: Value;
  label: ReactNode;
  description: ReactNode;
  palette: ThemePreviewPalette;
  /** Optional palette painted over the right half, used for adaptive themes. */
  alternatePalette?: ThemePreviewPalette;
}

export interface ThemeSelectorProps<Value extends string = string> {
  'aria-label': string;
  value: Value;
  options: readonly ThemeSelectorOption<Value>[];
  onValueChange: (value: Value) => void;
  name?: string;
  /** Gives the first option the full width, pairing the rest beneath it. */
  leadFirst?: boolean;
}

type PreviewStyle = CSSProperties & Record<`--theme-${string}`, string>;

function previewStyle(palette: ThemePreviewPalette): PreviewStyle {
  return {
    '--theme-background': palette.background,
    '--theme-sidebar': palette.sidebar,
    '--theme-surface': palette.surface,
    '--theme-border': palette.border,
    '--theme-text': palette.text,
    '--theme-muted': palette.muted,
    '--theme-accent': palette.accent,
    '--theme-accent-soft': palette.accentSoft,
  };
}

function PreviewScene({ palette, alternate = false }: { palette?: ThemePreviewPalette; alternate?: boolean }) {
  return (
    <span
      className={alternate ? `${styles.previewScene} ${styles.previewSceneAlternate}` : styles.previewScene}
      style={palette ? previewStyle(palette) : undefined}
      data-theme-preview-layer={alternate ? 'dark' : 'light'}
    >
      <span className={styles.previewTopbar}>
        <span className={styles.previewBrand} />
        <span className={styles.previewSearch} />
        <span className={styles.previewAvatar} />
      </span>
      <span className={styles.previewBody}>
        <span className={styles.previewSidebar}>
          <span className={styles.previewNavMark} />
          <span className={styles.previewNavMark} data-active="true" />
          <span className={styles.previewNavMark} />
          <span className={styles.previewNavMark} />
        </span>
        <span className={styles.previewMain}>
          <span className={styles.previewHeading} />
          <span className={styles.previewContent}>
            <span className={styles.previewPanel}>
              <span className={styles.previewLine} />
              <span className={styles.previewLine} data-short="true" />
              <span className={styles.previewAction} />
            </span>
            <span className={styles.previewPanel}>
              <span className={styles.previewBars}>
                <span />
                <span />
                <span />
                <span />
              </span>
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}

/**
 * The theme chooser from the GlacierUI docs: a grid of radio cards, each a
 * miniature of the app painted in that theme's palette. Adaptive themes split
 * the card, light on the left and dark on the right.
 */
export function ThemeSelector<Value extends string>({
  'aria-label': ariaLabel,
  value,
  options,
  onValueChange,
  name = 'theme',
  leadFirst = false,
}: ThemeSelectorProps<Value>) {
  return (
    <div className={styles.grid} role="radiogroup" aria-label={ariaLabel} data-lead={leadFirst || undefined}>
      {options.map((option) => {
        const selected = value === option.value;

        return (
          <label className={styles.option} data-selected={selected || undefined} key={option.value}>
            <input
              className={styles.input}
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => onValueChange(option.value)}
            />
            <span
              className={styles.preview}
              style={previewStyle(option.palette)}
              data-theme-preview={option.value}
              data-split={option.alternatePalette ? 'true' : undefined}
              aria-hidden="true"
            >
              <PreviewScene />
              {option.alternatePalette && <PreviewScene palette={option.alternatePalette} alternate />}
            </span>
            <span className={styles.meta}>
              <span className={styles.copy}>
                <span className={styles.label}>{option.label}</span>
                <span className={styles.description}>{option.description}</span>
              </span>
              <span className={styles.indicator} aria-hidden="true">
                <Check size={12} strokeWidth={2.5} />
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
