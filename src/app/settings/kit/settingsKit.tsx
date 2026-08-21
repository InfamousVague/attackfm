import { ChevronRight } from '@glacier/icons';
import { Button, Slider, Text } from '@glacier/react';
import type { ReactNode } from 'react';

/**
 * The settings vocabulary: every pane says what it says through these, so the
 * panes can stop each speaking their own dialect. Before this file there were
 * three section-heading languages (kit Field labels, bare Label + loose Text,
 * Heading level={3} part-heads), two caption languages (Field's bound hint vs
 * a sibling Text that could drift away from its control - Auto DJ's did), five
 * card recipes and four icon treatments. One vocabulary, stated once:
 *
 * LOOK RULES
 * - Materials stay split by surface: the desktop TabbedModal is kit glass
 *   (never re-dress it - the ArrowGlass rule), the phone sheet is opaque
 *   `--glacier-bg`. These components live INSIDE either and are material-free.
 * - Two panel recipes only. PaneSection is the borderless `--glacier-surface`
 *   card with hairline separators (the touch list's own group language, so
 *   panes finally match the list that opened them). Free-standing content
 *   cards (a server, a plugin repo, a theme option) are `surface-raised` +
 *   hairline `--glacier-border-subtle` + radius-lg.
 * - Two icon languages, one component (IconTile): tinted = a place you can GO
 *   (nav rows in the rail and the mobile list ONLY - fixed-oklch fill, white
 *   glyph); accent = a thing you HAVE (in-pane heroes and cards -
 *   accent-soft squircle, accent-solid glyph, the playlist shelf's tile
 *   language).
 * - SegmentedControl is a VALUE INPUT, everywhere in settings. Switching
 *   between chunks of a pane is navigation and wears SubNav's underline tabs,
 *   so the two jobs stop dressing alike.
 * - Buttons: at most one `solid` primary per group, `outline` for the
 *   secondary, `ghost` for the tertiary; `danger` only for the destructive
 *   action, which sits LAST in its pane.
 * - Token trap: `var(--glacier-accent)` does not exist - use `-solid`/`-text`.
 */

export type SettingsTint = 'pink' | 'blue' | 'green' | 'orange' | 'purple' | 'slate';

// --- the card ---------------------------------------------------------------

interface PaneSectionProps {
  /** ONE heading style: a small-caps muted caption above the card. */
  title?: string;
  /** A muted introduction between the title and the card. */
  description?: ReactNode;
  /** A muted footnote BELOW the card - status readouts live here, visibly
   *  attached to the group they describe without pretending to be rows. */
  footer?: ReactNode;
  /** `danger` warms the caption for a destructive group; `session` marks a
   *  group whose settings do not survive the app closing (the sleep timer). */
  tone?: 'default' | 'danger' | 'session';
  children: ReactNode;
}

/** The group card. Rows inside share one surface and hairline separators -
 *  the exact shape the mobile section list already draws, because a pane
 *  should look like it belongs to the list that opened it. */
export function PaneSection({ title, description, footer, tone = 'default', children }: PaneSectionProps) {
  return (
    <section className="setk" data-tone={tone === 'default' ? undefined : tone}>
      {title && <div className="setk__title">{title}</div>}
      {description && <div className="setk__desc">{description}</div>}
      <div className="setk__card">{children}</div>
      {footer && <div className="setk__footer">{footer}</div>}
    </section>
  );
}

// --- the row ----------------------------------------------------------------

interface SettingRowProps {
  /** Stable anchor: renders `data-setting` so search can scroll to the row.
   *  These strings are the search contract - never change one that shipped. */
  id?: string;
  /** Optional leading IconTile. */
  icon?: ReactNode;
  label: ReactNode;
  /** The caption, BOUND under the label - it can never drift to another
   *  control again the way a sibling Text could. */
  hint?: ReactNode;
  /** Trailing control: Switch, Select, SegmentedControl, Button. */
  control?: ReactNode;
  /** Trailing muted text for display rows (About's facts). */
  value?: ReactNode;
  /** Makes the whole row the button; a chevron appears by itself. */
  onPress?: () => void;
  /** `trailing` seats the control at the row's end; `stacked` gives it the
   *  full width below the text, for anything wider than a switch. */
  layout?: 'trailing' | 'stacked';
  danger?: boolean;
  disabled?: boolean;
  /** Why the row is disabled, rendered ONE way everywhere ("Needs a server"). */
  disabledReason?: string;
}

export function SettingRow({
  id,
  icon,
  label,
  hint,
  control,
  value,
  onPress,
  layout = 'trailing',
  danger,
  disabled,
  disabledReason,
}: SettingRowProps) {
  const off = disabled || !!disabledReason;
  const body = (
    <>
      {icon && <span className="setk-row__icon">{icon}</span>}
      <span className="setk-row__text">
        <span className="setk-row__label">{label}</span>
        {hint && <span className="setk-row__hint">{hint}</span>}
        {disabledReason && <span className="setk-row__why">{disabledReason}</span>}
      </span>
      {value != null && <span className="setk-row__value">{value}</span>}
      {control != null && layout === 'trailing' && (
        <span className="setk-row__control">{control}</span>
      )}
      {onPress && (
        <span className="setk-row__chevron" aria-hidden>
          <ChevronRight size={18} />
        </span>
      )}
    </>
  );
  if (onPress) {
    return (
      <button
        type="button"
        className="setk-row setk-row--press"
        data-setting={id}
        data-danger={danger || undefined}
        disabled={off}
        onClick={onPress}
      >
        {body}
      </button>
    );
  }
  return (
    <div
      className="setk-row"
      data-setting={id}
      data-danger={danger || undefined}
      data-disabled={off || undefined}
      data-stacked={layout === 'stacked' || undefined}
      // `inert`, not just the CSS: pointer-events:none stops a tap but not a
      // Tab - a "Needs a server" row was still keyboard-operable without
      // this, quietly writing settings it claimed were unavailable.
      inert={off || undefined}
    >
      <div className="setk-row__main">{body}</div>
      {control != null && layout === 'stacked' && (
        <div className="setk-row__wide">{control}</div>
      )}
    </div>
  );
}

// --- the slider row ---------------------------------------------------------

interface SettingSliderRowProps {
  id?: string;
  label: string;
  hint?: ReactNode;
  value: number;
  /** The reading beside the thumb - fixed width so "Off" -> "12s" cannot
   *  nudge the slider. */
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}

export function SettingSliderRow({
  id,
  label,
  hint,
  value,
  valueLabel,
  min,
  max,
  step,
  onChange,
  disabled,
}: SettingSliderRowProps) {
  return (
    <div className="setk-row" data-setting={id} data-stacked data-disabled={disabled || undefined}>
      <div className="setk-row__main">
        <span className="setk-row__text">
          <span className="setk-row__label">{label}</span>
          {hint && <span className="setk-row__hint">{hint}</span>}
        </span>
        <span className="setk-row__value setk-row__value--slider">{valueLabel}</span>
      </div>
      <div className="setk-row__wide">
        <Slider
          aria-label={label}
          value={value}
          min={min}
          max={max}
          step={step}
          onValueChange={onChange}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

// --- the hero ---------------------------------------------------------------

interface PaneHeroProps {
  glyph?: ReactNode;
  image?: string;
  /** `wordmark` keeps About's centred mark as a sanctioned variant. */
  variant?: 'default' | 'wordmark';
  title: ReactNode;
  meta?: ReactNode;
  pills?: ReactNode;
  status?: { tone: 'success' | 'warning' | 'danger' | 'neutral'; pulse?: boolean; text: string };
  /** Trailing action, e.g. Log out. */
  trailing?: ReactNode;
}

/** One hero anatomy for "this thing, at a glance" - the shape serverHero,
 *  deviceIdentity and aboutHero each drew their own way. */
export function PaneHero({ glyph, image, variant = 'default', title, meta, pills, status, trailing }: PaneHeroProps) {
  return (
    <div className="setk-hero" data-variant={variant}>
      {image ? (
        <img className="setk-hero__image" src={image} alt="" draggable={false} />
      ) : glyph ? (
        <span className="setk-hero__glyph">{glyph}</span>
      ) : null}
      <div className="setk-hero__body">
        <div className="setk-hero__title">{title}</div>
        {meta && <div className="setk-hero__meta">{meta}</div>}
        {status && (
          <div className="setk-hero__status" data-tone={status.tone} data-pulse={status.pulse || undefined}>
            <span className="setk-hero__dot" aria-hidden />
            {status.text}
          </div>
        )}
        {pills && <div className="setk-hero__pills">{pills}</div>}
      </div>
      {trailing && <div className="setk-hero__trailing">{trailing}</div>}
    </div>
  );
}

// --- chunk navigation -------------------------------------------------------

interface SubNavProps {
  value: string;
  onValueChange: (id: string) => void;
  options: { id: string; label: string; count?: number }[];
}

/** Underline tabs for switching between a pane's chunks. Visually DISTINCT
 *  from SegmentedControl on purpose: a segmented control answers "which
 *  value", these answer "which page", and dressing both alike was how the
 *  Servers pane read as a form when it is a small book.
 *
 *  Claiming role=tablist obliges the whole pattern, not just the paint:
 *  arrows move AND activate (the kit's own tabs activate automatically),
 *  and only the active tab sits in the Tab order. */
export function SubNav({ value, onValueChange, options }: SubNavProps) {
  const move = (from: string, delta: number) => {
    const i = options.findIndex((o) => o.id === from);
    const next = options[(i + delta + options.length) % options.length];
    if (next) onValueChange(next.id);
  };
  return (
    <div className="setk-subnav" role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={o.id === value}
          tabIndex={o.id === value ? 0 : -1}
          className="setk-subnav__tab"
          data-active={o.id === value || undefined}
          onClick={() => onValueChange(o.id)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault();
              move(o.id, 1);
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault();
              move(o.id, -1);
            } else if (e.key === 'Home') {
              e.preventDefault();
              if (options[0]) onValueChange(options[0].id);
            } else if (e.key === 'End') {
              e.preventDefault();
              const last = options[options.length - 1];
              if (last) onValueChange(last.id);
            }
          }}
          // Activation moves focus with the selection, completing the
          // pattern: the newly selected tab is the only tabbable one.
          ref={(el) => {
            if (el && o.id === value && el.closest('.setk-subnav')?.contains(document.activeElement) && document.activeElement !== el) {
              el.focus();
            }
          }}
        >
          {o.label}
          {typeof o.count === 'number' && o.count > 0 && (
            <span className="setk-subnav__count">{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// --- pick-a-visual ----------------------------------------------------------

interface OptionCardsProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  /** First option spans the full row (the Automatic theme's seat). */
  leadFirst?: boolean;
  options: { id: T; preview: ReactNode; label: string; note?: string }[];
}

/** One selected-state language for every "pick one of these looks" grid:
 *  the ThemeSelector's - accent border, ring, filled check. */
export function OptionCards<T extends string>({ value, onChange, leadFirst, options }: OptionCardsProps<T>) {
  return (
    <div className="setk-options" data-lead-first={leadFirst || undefined} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          className="setk-option"
          data-selected={o.id === value || undefined}
          onClick={() => onChange(o.id)}
        >
          <span className="setk-option__preview">{o.preview}</span>
          <span className="setk-option__text">
            <span className="setk-option__label">{o.label}</span>
            {o.note && <span className="setk-option__note">{o.note}</span>}
          </span>
          <span className="setk-option__check" aria-hidden>
            ✓
          </span>
        </button>
      ))}
    </div>
  );
}

// --- the banner -------------------------------------------------------------

interface SettingsCalloutProps {
  tone?: 'accent' | 'warning' | 'danger';
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}

/** One tinted banner recipe (the UpdateBanner's color-mix way), replacing the
 *  raw ramp-step vocabulary the plugin updates strip had grown. */
export function SettingsCallout({ tone = 'accent', icon, action, children }: SettingsCalloutProps) {
  return (
    <div className="setk-callout" data-tone={tone}>
      {icon && <span className="setk-callout__icon">{icon}</span>}
      <div className="setk-callout__body">{children}</div>
      {action && <div className="setk-callout__action">{action}</div>}
    </div>
  );
}

// --- gated / empty ----------------------------------------------------------

interface SettingsEmptyProps {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: { label: string; onPress: () => void };
}

/** One shape for "this pane needs something you have not set up" - replacing
 *  each pane's bespoke signed-out paragraph. */
export function SettingsEmpty({ icon, title, body, action }: SettingsEmptyProps) {
  return (
    <div className="setk-empty">
      {icon && <span className="setk-empty__icon">{icon}</span>}
      <Text weight="medium">{title}</Text>
      {body && (
        <Text tone="muted" size="sm">
          {body}
        </Text>
      )}
      {action && (
        <Button variant="outline" size="sm" onClick={action.onPress}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

// --- the footnote -----------------------------------------------------------

/** An xs subtle paragraph for the things that are true but not rows: credits,
 *  deny/keep semantics, pipeline status. */
export function SettingsFootnote({ children }: { children: ReactNode }) {
  return <p className="setk-footnote">{children}</p>;
}

// --- the icon tile ----------------------------------------------------------

type IconTileProps =
  | { tint: SettingsTint; children: ReactNode }
  | { variant: 'accent'; size?: 'md' | 'lg'; children: ReactNode };

/** Two icon languages, one component. Tinted = a place you can go (nav only);
 *  accent = a thing you have (in-pane). The tinted variant wears the mobile
 *  list's own class so the fixed-oklch fills stay defined once. */
export function IconTile(props: IconTileProps) {
  if ('tint' in props) {
    return (
      <span className="settingsScreen__rowIcon" data-tint={props.tint}>
        {props.children}
      </span>
    );
  }
  return (
    <span className="setk-tile" data-size={props.size ?? 'md'}>
      {props.children}
    </span>
  );
}
