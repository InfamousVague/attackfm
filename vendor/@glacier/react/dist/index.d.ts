import * as react from 'react';
import { RefObject, ComponentProps, ReactNode, ReactElement, SVGProps, CSSProperties, MouseEventHandler, ElementType, Ref } from 'react';
import { motion } from 'motion/react';
import { DayPickerLocale } from 'react-day-picker';

/**
 * Shared design vocabulary.
 *
 * These are the names and conventions that repeat across components: the size
 * steps, the semantic tones, and the fixed mapping from a control size to its
 * height and font size. They live here, once, so both the specs and the React
 * kit consume the same source instead of each component redeclaring the same
 * `'sm' | 'md' | 'lg'` union and the same tone list.
 */

/** The three-step control size, used by buttons, inputs, selects, and friends. */
declare const controlSizes: readonly ["sm", "md", "lg"];
/** The semantic color families shared by pills, badges, dots, callouts, meters. */
declare const tones: readonly ["neutral", "accent", "success", "warning", "danger", "info"];
/**
 * The silhouette vocabulary shared by every component with a `shape` prop.
 * `rect` is today's rounded default and renders byte-identically to a
 * component without the prop; the other shapes are the gamified plates. All
 * geometry rides the `--glacier-shape-*` tokens and mirrors automatically
 * under [dir='rtl'].
 */
declare const shapes: readonly ["rect", "slant", "notch", "edge"];

/**
 * Enum vocabulary - named constants for the loose string props, so components
 * read `size={Size.Large}` / `tone={Tone.Accent}` / `tone={TextTone.Muted}`
 * instead of `size="lg"` / `tone="accent"` / `tone="muted"`. Mirrors the
 * `@glacier/motion` enum pattern (Motion, Speed, Ease, Spring).
 *
 * Each value equals the underlying vocab string, so an enum member is accepted
 * anywhere the existing spec-derived union is (a string-enum member is
 * assignable to its literal value), while an out-of-range member is still
 * rejected by that per-component union. Adopting the enum is therefore additive
 * and never breaks an existing `size="lg"` string.
 */
/** Every size step in the kit. A component's own union restricts which apply. */
declare enum Size {
    XSmall = "xs",
    Small = "sm",
    Medium = "md",
    Large = "lg",
    XLarge = "xl"
}
/**
 * Status / semantic tones shared by badges, callouts, meters, steps, spinners,
 * progress, and friends. Note/Auto/Subtle/Inherit cover the component-specific
 * one-offs (Callout note, Meter auto, Spinner subtle/inherit).
 */
declare enum Tone {
    Neutral = "neutral",
    Accent = "accent",
    Success = "success",
    Warning = "warning",
    Danger = "danger",
    Info = "info",
    Note = "note",
    Auto = "auto",
    Subtle = "subtle",
    Inherit = "inherit"
}
/** The Text component's emphasis tones (its own scale, distinct from status). */
declare enum TextTone {
    Default = "default",
    Muted = "muted",
    Subtle = "subtle",
    Accent = "accent",
    Danger = "danger",
    Success = "success",
    Warning = "warning"
}
/** Visual style variants for Button, IconButton, Card, and Pill. */
declare enum Variant {
    Solid = "solid",
    Soft = "soft",
    Outline = "outline",
    Ghost = "ghost",
    Glass = "glass",
    Danger = "danger",
    Gradient = "gradient",
    Wash = "wash"
}
/** The Skeleton placeholder's shape variants (its own axis, not a visual style). */
declare enum SkeletonVariant$1 {
    Text = "text",
    Rect = "rect",
    Circle = "circle"
}
/** Visual treatments available to ScrollArea's visible web scrollbar. */
declare enum ScrollbarAppearance {
    Subtle = "subtle",
    Default = "default",
    Accent = "accent"
}

/** Tone families, exported so every framework binding derives the same union. */
declare const announcementTones: readonly ["neutral", "accent", "success", "warning", "danger", "info"];
/** How the strip moves through its updates. */
declare const announcementMotions: readonly ["step", "marquee"];

/** Size steps, exported so the React kit derives its union from here. */
declare const avatarSizes: readonly ["sm", "md", "lg", "xl"];
/** Shapes, exported so the React kit derives its union from here. */
declare const avatarShapes: readonly ["circle", "rounded"];

/** Tone families, exported so the React kit derives its union from here. */
declare const bannerTones: readonly ["neutral", "accent", "success", "warning", "danger", "info"];

/** Visual style families, exported so the React kit derives its union from here. */
declare const buttonVariants: readonly ["solid", "soft", "outline", "ghost", "glass", "danger", "gradient"];

/** Tone families, exported so the React kit derives its union from here. */
declare const calloutTones: readonly ["note", "info", "success", "warning", "danger"];

/** Visual materials, exported so the React kit derives its union from here. */
declare const cardVariants: readonly ["solid", "glass", "wash"];
/** The elevation steps, one per shadow token. Exported for a binding's union. */
declare const cardElevations: readonly [0, 1, 2, 3, 4, 5];

/** Semantic color families the badge supports, exported so the React kit derives its union from here. */
declare const counterBadgeTones: readonly ["danger", "accent", "neutral", "success"];

/** Orientations, exported so the React kit derives its union from here. */
declare const dividerOrientations: readonly ["horizontal", "vertical"];

/** Fill tones, exported so the React kit derives its union from here. */
declare const meterTones: readonly ["auto", "accent", "success", "warning", "danger"];

declare const pillVariants: readonly ["soft", "solid", "outline"];

/** Where the strip is docked, which decides which edge carries its hairline. */
declare const playerBarPositions: readonly ["docked", "floating"];

/**
 * What opens the panel.
 *
 * Press is the default and the honest one: the panel is asked for, and the same
 * gesture puts it away. Hover is for a trigger that already does something of
 * its own - a mute button that shows the fader while the pointer is on it - so
 * the panel costs no press at all. It opens on focus as well as on pointer, and
 * Tab from the trigger hands focus to the panel, since a portalled panel is not
 * where the next Tab would otherwise land.
 */
declare const popoverOpenOns: readonly ["press", "hover"];

/** Size steps, exported so the React kit derives its union from here. */
declare const progressBarSizes: readonly ["sm", "md"];
/** Tones a ProgressBar accepts (a subset of the shared tone families). */
declare const progressBarTones: readonly ["accent", "success", "warning", "danger"];

/** Tone families the ring arc supports, a subset of the shared tones. */
declare const progressRingTones: readonly ["accent", "success", "warning", "danger"];

/**
 * How the bar paints progress, exported so both kits derive their union from
 * here. The geometry behind each shape lives in `@glacier/logic`.
 */
declare const seekBarShapes: readonly ["line", "wave", "waveform", "swell", "zigzag", "spikes", "bars", "mirror"];
/** Colour family the played run paints from. Every entry resolves to tokens. */
declare const seekBarTones: readonly ["accent", "success", "warning", "danger", "info", "neutral"];
/** How the played run is filled: one flat token, or a ramp between two. */
declare const seekBarFills: readonly ["solid", "tonal", "blend", "fade"];
/** How visible the run ahead of the playhead is. */
declare const seekBarRails: readonly ["muted", "contrast"];

/** Bar thickness steps, exported so the React kit derives its union from here. */
declare const segmentedBarSizes: readonly ["sm", "md"];
/** Slice fill tones, exported so the React kit derives its union from here. */
declare const segmentedBarTones: readonly ["accent", "success", "warning", "danger", "neutral"];

/** Shape families, exported so the React kit derives its union from here. */
declare const skeletonVariants: readonly ["text", "rect", "circle"];

/** Mark shapes, exported so the React kit derives its union from here. */
declare const sparklineShapes: readonly ["line", "area", "bars"];
/** Ink tones, exported so the React kit derives its union from here. */
declare const sparklineTones: readonly ["accent", "neutral", "success", "warning", "danger", "info"];

/** Tone families, exported so the React kit derives its union from here. */
declare const spinnerTones: readonly ["subtle", "accent", "inherit"];

/** Dot tones, exported so the React kit derives its union from here. */
declare const stepsTones: readonly ["accent", "success", "warning", "danger", "neutral", "info"];
/** Visual treatments, exported so the React kit derives its union from here. */
declare const stepsVariants: readonly ["dots", "connected"];
/** Dot size steps, exported so the React kit derives its union from here. */
declare const stepsSizes: readonly ["sm", "md"];

/** Rendered elements, exported so the React kit derives its `as` union from here. */
declare const textElements: readonly ["p", "span", "div", "strong", "em", "small"];
/** Size steps, exported so bindings share the same font-scale union. */
declare const textSizes: readonly ["xs", "sm", "md", "lg"];
/** Semantic text tones, exported so bindings share the union. */
declare const textTones: readonly ["default", "muted", "subtle", "accent", "danger", "success", "warning"];
/** Font weights, exported so bindings share the union. */
declare const textWeights: readonly ["regular", "medium", "semibold", "bold"];
/** Text alignment options, exported so bindings share the union. */
declare const textAligns: readonly ["start", "center", "end", "justify"];

/** Size steps, exported so the React kit derives its union from here. */
declare const textareaSizes: readonly ["sm", "md", "lg"];

/** Tone families, exported so the React kit derives its union from here. */
declare const toastTones: readonly ["neutral", "info", "success", "warning", "danger"];

/**
 * Artwork footprints, from a row chip up to a now-playing cover, plus `fill` -
 * where the height is not the art's to choose. On a strip the row is as tall as
 * the controls beside it, and a cover that picks its own size either floats in
 * the gap or sets the height of chrome that was measured for something else.
 */
declare const trackInfoSizes: readonly ["sm", "md", "lg", "fill"];
/** How the text column sits against the artwork beside it. */
declare const trackInfoAligns: readonly ["start", "center"];

/**
 * How loudly the primary control is drawn.
 *
 * - `solid` - a filled button, the way a card draws it: the row has the room,
 *   and a filled disc says which of six glyphs is the one to press.
 * - `quiet` - the same glyph a step larger than its neighbours and in the full
 *   text colour, with nothing behind it. What a docked strip wants, where a
 *   filled disc is the loudest thing on a chrome bar it is not the subject of.
 */
declare const transportEmphases: readonly ["solid", "quiet"];

/** What the readout beside the fader prints, if anything. */
declare const volumeReadouts: readonly ["gain", "percent", "none"];
/** Fader size steps, matching the control scale around it. */
declare const volumeBarSizes: readonly ["sm", "md"];
/**
 * Which way the rail runs.
 *
 * Horizontal is the default, and what a row of controls wants. Vertical stands
 * the rail up for surfaces where height is not the scarce axis, or - as on a
 * docked strip - where width is scarcer still: a standing fader beside the
 * transport costs a column the width of a thumb.
 */
declare const volumeBarOrientations: readonly ["horizontal", "vertical"];
/**
 * Whether the rail is on the surface or behind the speaker button.
 *
 * Inline is the honest one: the level is visible without asking, and it can be
 * changed in a single movement. Popover is for surfaces with no room to spare -
 * a docked strip, a toolbar - where a rail lying across the width would take
 * the space the thing being played needs. The cost is real and worth naming: a
 * level behind a button cannot be read at a glance. The panel is not asked for,
 * though - it opens while the pointer rests on the speaker, and on focus - so
 * the speaker stays the mute button it is in every other layout, and the panel
 * holds the rail and the readout alone.
 */
declare const volumeBarLayouts: readonly ["inline", "popover"];

/** Size steps, exported so the React kit derives its union from here. */
declare const deviceFrameSizes: readonly ["sm", "md", "lg"];

/** Visual treatments for the scrollbar on web-capable bindings. */
declare const scrollbarAppearances: readonly ["subtle", "default", "accent"];

declare const drawerSides: readonly ["left", "right", "bottom"];
declare const drawerSizes: readonly ["sm", "md", "lg"];

declare const alertDialogTones: readonly ["neutral", "danger"];

/** Orientations, exported so the React kit derives its union from here. */
declare const navBarOrientations: readonly ["horizontal", "vertical"];

/** Character sets the code accepts. Exported so React derives its union. */
declare const otpFieldTypes: readonly ["numeric", "alphanumeric"];

/** Marker tones, exported so the React kit derives its union from here. */
declare const timelineScrubberMarkerTones: readonly ["neutral", "accent", "success", "warning", "danger", "info"];

/**
 * The fixed categorical order for chart series inks, exported so the React kit
 * derives its union from here. Series take colors in this order (never cycled,
 * never re-ranked when a series is hidden): the accent leads, then hues chosen
 * for maximum adjacent-pair separation on the kit ramps. `gray` is reserved
 * for "other" roll-ups.
 */
declare const chartSeriesTones: readonly ["accent", "blue", "amber", "purple", "teal", "red", "green", "gray"];
/** Chart mark shapes, exported so the React kit derives its union from here. */
declare const timeSeriesChartShapes: readonly ["line", "area"];

/** Layout modes, exported so bindings derive their union from the contract. */
declare const cardGroupModes: readonly ["grid", "list"];
/** Gap steps, exported so bindings derive their union from the contract. */
declare const cardGroupGaps: readonly ["sm", "md", "lg"];
/** Density steps, exported so bindings derive their union from the contract. */
declare const cardGroupDensities: readonly ["comfortable", "compact"];

/**
 * Which chord sends.
 *
 * Transcribed from `composerSubmitModes` in `@glacier/logic`, which cannot be
 * imported here without making the spec depend on the package that already
 * depends on it - the same arrangement `messageDeliveryStatuses` is under. A
 * test asserts the two lists are identical, so the duplication is checked
 * rather than trusted.
 */
declare const composerSubmitModes: readonly ["enter", "modifier"];
/** What a character is, for the purpose of a limit; mirrors `draftCountModes`. */
declare const draftCountModes: readonly ["graphemes", "codePoints", "utf16"];

type Direction = 'ltr' | 'rtl';
/**
 * The writing direction in effect at a node. The nearest dir attribute wins
 * (matching how the attribute cascades), then the computed style, then the
 * document element, defaulting to ltr. Call it at event or measure time - a
 * live read can never go stale, unlike a render-time snapshot.
 */
declare function resolveDirection(node: Element | null | undefined): Direction;
/**
 * Render-time direction for a ref, kept in sync with dir flips on the document
 * element (the docs preference toggles it live). Prefer resolveDirection inside
 * event handlers; reach for this only when the render output itself must
 * differ, e.g. choosing which chevron glyph to draw.
 */
declare function useDirection(ref: RefObject<Element | null>): Direction;

/**
 * The silhouette vocabulary, derived from the spec so the React kit cannot
 * drift from the contract. See @glacier/spec vocab.ts.
 */
type ShapeName = (typeof shapes)[number];

type ButtonVariant = (typeof buttonVariants)[number];
type ControlSize = (typeof controlSizes)[number];
interface ButtonProps extends Omit<ComponentProps<typeof motion.button>, 'children'> {
    variant?: ButtonVariant;
    size?: ControlSize;
    /**
     * Plate silhouette. `rect` is the untouched default; the gamified shapes ride
     * the shape layer, which keeps the focus ring and the hit area on the full
     * upright box and swaps the elevation shadows for the shape drop/glow pair.
     */
    shape?: ShapeName;
    /** Paints the accent leading-edge stripe, widening on hover and focus. */
    edgeAccent?: boolean;
    /** Slides the accent sweep in from the leading edge on hover and focus. */
    sweep?: boolean;
    loading?: boolean;
    /** Renders a placeholder with the button's exact geometry. */
    skeleton?: boolean;
    fullWidth?: boolean;
    children?: ReactNode;
}
declare function Button({ variant, size, shape, edgeAccent, sweep, loading, skeleton, fullWidth, disabled, className, children, ...rest }: ButtonProps): react.JSX.Element;

interface IconButtonProps extends Omit<ComponentProps<typeof motion.button>, 'children'> {
    /** Required: icon-only controls have no visible text. */
    'aria-label': string;
    variant?: ButtonVariant;
    size?: ControlSize;
    /** Renders a placeholder with the control's exact geometry. */
    skeleton?: boolean;
    children?: ReactNode;
}
declare function IconButton({ variant, size, skeleton, disabled, className, children, ...rest }: IconButtonProps): react.JSX.Element;

interface InputProps extends Omit<ComponentProps<'input'>, 'size'> {
    size?: ControlSize;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
    /** Icon or adornment pinned to the leading edge; the text pads clear of it. */
    leadingIcon?: ReactNode;
    /** Icon or adornment pinned to the trailing edge, such as a clear button. */
    trailingIcon?: ReactNode;
}
declare function Input({ size, skeleton, glass, leadingIcon, trailingIcon, className, id, ...rest }: InputProps): react.JSX.Element;

interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type' | 'onChange' | 'checked' | 'defaultChecked'> {
    label?: ReactNode;
    checked?: boolean;
    defaultChecked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    /** Mixed state: shows a dash and reports aria-checked="mixed" while unchecked. */
    indeterminate?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
}
declare function Checkbox({ label, checked, defaultChecked, onCheckedChange, indeterminate, disabled, skeleton, glass, className, ...rest }: CheckboxProps): react.JSX.Element;

interface RadioProps extends Omit<ComponentProps<'input'>, 'type'> {
    label?: ReactNode;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
}
/** Uncontrolled-friendly: group radios by `name` as usual. */
declare function Radio({ label, disabled, skeleton, glass, className, ...rest }: RadioProps): react.JSX.Element;

interface SwitchProps extends Omit<ComponentProps<'input'>, 'type' | 'onChange' | 'checked' | 'defaultChecked' | 'size'> {
    label?: ReactNode;
    checked?: boolean;
    defaultChecked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    size?: 'sm' | 'md';
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
}
declare function Switch({ label, checked, defaultChecked, onCheckedChange, disabled, size, skeleton, glass, className, ...rest }: SwitchProps): react.JSX.Element;

type Elevation = (typeof cardElevations)[number];
type CardVariant = (typeof cardVariants)[number];
interface CardProps extends Omit<ComponentProps<typeof motion.div>, 'children'> {
    elevation?: Elevation;
    /** Adds hover lift + shadow bump for clickable cards. */
    interactive?: boolean;
    /** 'glass' renders a translucent blurred material, 'wash' a quiet accent gradient. */
    variant?: CardVariant;
    /**
     * Plate silhouette. 'rect' is the untouched default; the gamified plates
     * carry their depth on the shape drop/glow pair instead of the elevation
     * shadow ladder, and mirror themselves under [dir='rtl'].
     */
    shape?: ShapeName;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    children?: ReactNode;
}
declare function Card({ elevation, interactive, variant, shape, skeleton, className, children, ...rest }: CardProps): react.JSX.Element;

type SurfaceLevel = 0 | 1 | 2 | 'sunken';
interface SurfaceProps extends ComponentProps<'div'> {
    /** 0 = app background, 1 = surface, 2 = raised, 'sunken' = inset wells. */
    level?: SurfaceLevel;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
}
declare function Surface({ level, skeleton, glass, className, children, ...rest }: SurfaceProps): react.JSX.Element;

type TextToneName = (typeof textTones)[number];
type TextSize = (typeof textSizes)[number];
type TextElement = (typeof textElements)[number];
type TextWeight = (typeof textWeights)[number];
type TextAlign = (typeof textAligns)[number];
interface TextProps extends Omit<ComponentProps<'p'>, 'children'> {
    /** Rendered element. Defaults to a paragraph. */
    as?: TextElement;
    size?: TextSize;
    tone?: TextToneName;
    weight?: TextWeight;
    /** Monospace with tabular numerals, for values and measurements. */
    mono?: boolean;
    /** Text alignment; inherits when unset. */
    align?: TextAlign;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    children?: ReactNode;
}
declare function Text({ as, size, tone, weight, mono, align, skeleton, className, children, ...rest }: TextProps): react.JSX.Element;

interface HeadingProps extends Omit<ComponentProps<'h2'>, 'children'> {
    /** Semantic heading level, h1 through h6. Also sets the visual size. */
    level?: 1 | 2 | 3 | 4 | 5 | 6;
    /** Visual size override when semantics and looks need to differ. */
    visualLevel?: 1 | 2 | 3 | 4 | 5 | 6;
    /** Text alignment; inherits when unset. */
    align?: 'start' | 'center' | 'end' | 'justify';
    /** Removes the heading's outer margin so it can fit inside compact layouts. */
    noMargin?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    children?: ReactNode;
}
declare function Heading({ level, visualLevel, align, noMargin, skeleton, className, children, ...rest }: HeadingProps): react.JSX.Element;

interface LabelProps extends Omit<ComponentProps<'label'>, 'children'> {
    /** Appends a required marker after the label text. */
    required?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    children?: ReactNode;
}
declare function Label({ required, skeleton, className, children, ...rest }: LabelProps): react.JSX.Element;

interface LinkProps extends Omit<ComponentProps<'a'>, 'children'> {
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    children?: ReactNode;
}
declare function Link({ skeleton, className, children, ...rest }: LinkProps): react.JSX.Element;

interface KbdProps extends Omit<ComponentProps<'kbd'>, 'children'> {
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
    children?: ReactNode;
}
declare function Kbd({ skeleton, glass, className, children, ...rest }: KbdProps): react.JSX.Element;

type PillTone = (typeof tones)[number];
type PillVariant = (typeof pillVariants)[number];
interface PillProps extends Omit<ComponentProps<'span'>, 'children'> {
    tone?: PillTone;
    variant?: PillVariant;
    size?: 'sm' | 'md';
    /**
     * Plate silhouette. `rect` is the untouched capsule; the gamified shapes hand
     * the pill's paint to the shape layer and trade the capsule radius for plate
     * corners.
     */
    shape?: ShapeName;
    /** Leading glyph, hidden from assistive tech. */
    icon?: ReactNode;
    /** When set, renders a trailing remove button that calls this on click, turning the pill into a removable tag. */
    onRemove?: () => void;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
    children?: ReactNode;
}
declare function Pill({ tone, variant, size, shape, icon, onRemove, skeleton, glass, className, children, ...rest }: PillProps): react.JSX.Element;

type DividerOrientation = (typeof dividerOrientations)[number];
interface DividerProps extends Omit<ComponentProps<'hr'>, 'children'> {
    orientation?: DividerOrientation;
    /** Optional centered label; renders a div separator instead of an hr. */
    label?: ReactNode;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
}
declare function Divider({ orientation, label, skeleton, className, ...rest }: DividerProps): react.JSX.Element;

type IconElement = ReactElement<SVGProps<SVGSVGElement> & {
    color?: string;
    size?: number | string;
    'data-icon-backfill'?: boolean;
}>;
interface IconBackfillProps extends ComponentProps<'span'> {
    /** One outline icon. Its explicit color is reused for the backfill. */
    children: IconElement;
    /** Overrides the glyph and backfill color. Defaults to the icon's color, then currentColor. */
    color?: string;
    /** Glyph size used to scale the surrounding backfill inset. Defaults to the child's size. */
    size?: number | string;
}
/**
 * Stacks a filled, soft-stroked copy of the glyph behind its outline at 33%
 * opacity. The backing follows the icon's silhouette and shares its resolved
 * color, including inherited text colors and explicit custom colors.
 */
declare function IconBackfill({ children, color, size, className, style, ...rest }: IconBackfillProps): react.JSX.Element;

type ProgressBarSize = (typeof progressBarSizes)[number];
type ProgressBarTone = (typeof progressBarTones)[number];
interface ProgressBarProps extends ComponentProps<'div'> {
    /** 0 to max. Omit (or set indeterminate) for an unknown duration. */
    value?: number;
    max?: number;
    indeterminate?: boolean;
    size?: ProgressBarSize;
    tone?: ProgressBarTone;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Accessible name for the bar. */
    'aria-label'?: string;
}
declare function ProgressBar({ value, max, indeterminate, size, tone, skeleton, className, ...rest }: ProgressBarProps): react.JSX.Element;

type SpinnerSize = (typeof controlSizes)[number];
type SpinnerTone = (typeof spinnerTones)[number];
interface SpinnerProps extends ComponentProps<'span'> {
    /** sm tracks the surrounding font size (1em); md and lg are fixed. */
    size?: SpinnerSize;
    tone?: SpinnerTone;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Accessible name. Pass an empty string when a parent already announces loading. */
    'aria-label'?: string;
}
declare function Spinner({ size, tone, skeleton, className, ...rest }: SpinnerProps): react.JSX.Element;

interface SliderProps extends Omit<ComponentProps<'input'>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'size'> {
    value?: number;
    defaultValue?: number;
    min?: number;
    max?: number;
    step?: number;
    onValueChange?: (value: number) => void;
    /**
     * Lay the rail vertically, filling from the bottom (min) up - for volume and
     * the like. Set the track length with the `--slider-length` custom property.
     */
    orientation?: 'horizontal' | 'vertical';
    /**
     * Percent of the min-max range between haptic ticks while dragging or keying:
     * a 'selection' tick fires each time the value crosses a bucket boundary, and
     * a 'medium' bump fires once when the value lands on min or max. Set 0 or a
     * negative number to disable the ticks (the edge bump stays).
     */
    hapticStep?: number;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    'aria-label'?: string;
    /** Set to "none" to opt this slider out of haptic feedback. */
    'data-haptic'?: string;
}
/**
 * A styled native range input with a filled leading track and an iOS-style
 * thumb. Native semantics come free: arrow keys nudge by step, Home and End
 * jump to the ends, and screen readers read the value. Pass
 * orientation="vertical" to stand the rail up for volume-style controls.
 */
declare function Slider({ value, defaultValue, min, max, step, onValueChange, orientation, hapticStep, skeleton, disabled, className, style, id, ...rest }: SliderProps): react.JSX.Element;

/** A beat travelling outward from where it was heard, deforming the bar as it passes. */
interface SeekBarRipple {
    /** Where the beat landed along the bar, 0..1. Normally the playhead. */
    at: number;
    /** How far through its life it is, 0..1; at 1 it has travelled out and gone. */
    age: number;
    /** How hard the beat hit, 0..1. */
    strength: number;
}
/**
 * How hard the music is hitting right now, and the hits still travelling.
 * `@glacier/logic`'s `useBeat` produces this from a loudness meter; a caller
 * with its own beat detection can hand the same shape straight in.
 */
interface SeekBarBeat {
    /** A steady swell of the whole squiggle, 0..1: jumps on a hit, falls between them. */
    pulse: number;
    /** The individual hits, each rippling out from where it landed. */
    ripples: readonly SeekBarRipple[];
}

/**
 * How the card arranges what it holds.
 *
 * - `stacked` - heading, bar, then controls in a column. The default, and the
 *   one that survives being squeezed into a narrow column.
 * - `inline` - artwork top-aligned on the leading edge with the title, artist,
 *   and album beside it; the bar and controls then break to their own rows and
 *   span the full width, so the seek bar is never squeezed into a column.
 * - `square` - artwork as a square hero with the bar and controls beneath it,
 *   the shape a phone's now-playing screen wants.
 * - `bar` - everything on one line: the transport leads, what is playing rides
 *   beside it, the seek bar takes the space left between its two clocks, and
 *   the mode toggles close the row out. The shape a docked now-playing strip
 *   wants, so it needs width rather than height.
 */
type PlayerLayout = 'stacked' | 'inline' | 'square' | 'bar';
/**
 * How tightly the card is packed. Deliberately a subset of the app-wide density
 * words rather than a new scale, so the two read as the same vocabulary.
 */
type PlayerDensity = 'compact' | 'comfortable' | 'spacious';
/**
 * Repeat modes, in the order the button cycles through them.
 *
 * - `off` - stop at the end of the track.
 * - `all` - loop the queue.
 * - `one` - loop this track.
 */
type PlayerRepeat = 'off' | 'all' | 'one';

/**
 * Inline-player logic - the parts of a docked transport strip that are
 * arithmetic rather than pixels, shared so both bindings agree.
 *
 * The player transport itself (time formatting, the repeat cycle, the density
 * scale) already lives in `./player.ts` and is reused as-is; what a strip adds
 * is a countdown readout and a fader that has to be honest about level.
 */

/**
 * The gain a fader position asks for, in decibels.
 *
 * The rail is linear in decibels rather than in amplitude, because decibels are
 * what the ear is linear in: halving the number on the readout halves the
 * perceived loudness, so the same nudge of the thumb does the same thing at
 * either end of the travel. An amplitude-linear rail spends its whole lower
 * half between silence and barely-there.
 *
 * Zero is not the floor but off: a fader pulled all the way down is silent, not
 * quiet, so it returns -Infinity rather than -60. `formatGain` and
 * `volumeAmplitude` both read that as the off state.
 */
declare function volumeGain(volume: number): number;
/**
 * The 0-1 multiplier a fader position asks for - what an `<audio>` element's
 * `volume`, or a Web Audio gain node, actually takes.
 *
 * Amplitude is the inverse of the decibel definition, so this and `volumeGain`
 * are two readings of one number rather than two scales that could drift.
 */
declare function volumeAmplitude(volume: number): number;

/**
 * Calendar view logic - the grid building, event bucketing, and navigation
 * behind a scheduler surface. All of it is arithmetic rather than pixels, so
 * both bindings lay out the same month from the same inputs.
 *
 * Deliberately dependency-free. Every step here uses the local-date
 * constructor (`new Date(y, m, d)`) rather than adding milliseconds, because
 * a day is not always 24 hours: on a DST boundary "+86400000" lands on the
 * same calendar day or skips one, and a calendar that loses a day twice a year
 * is worse than no calendar.
 */
/** How the calendar is showing its range. */
type CalendarViewMode = 'month' | 'week' | 'agenda';
/** Which weekday a week starts on. Sunday in the US, Monday most elsewhere. */
type WeekStart = 0 | 1;
/** The colour families an event can carry, matching the kit's tone vocabulary. */
type CalendarTone = 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
/** One scheduled thing. */
interface CalendarEvent {
    /** Stable identity; also what selection handlers report back. */
    id: string;
    /** When it starts. */
    start: Date;
    /** When it ends. Omitted means it occupies only its start day. */
    end?: Date;
    /** The line the user reads. */
    title: string;
    /** Colour family; defaults to accent at the binding. */
    tone?: CalendarTone;
    /** Shown without a time, and sorted above timed events on its day. */
    allDay?: boolean;
}

/**
 * Rich text editing - the selection-to-markdown transforms behind a formatting
 * toolbar.
 *
 * Markdown over `contenteditable` is a deliberate choice. A contenteditable
 * surface is a DOM-only construct with no React Native equivalent, so an editor
 * built on it could never have a native binding. These transforms are pure
 * string arithmetic over a plain text value and a selection range, which every
 * platform's text input already provides - so Bold means exactly the same thing
 * on both, and it is testable without a browser.
 */
/** An inline mark, applied by wrapping the selection. */
type MarkdownMark = 'bold' | 'italic' | 'code' | 'strike';
/** A block form, applied by prefixing every line the selection touches. */
type MarkdownBlock = 'heading' | 'quote' | 'bullet' | 'number';

/**
 * Command palette logic - the matching, grouping, and cursor rules behind a
 * ⌘K overlay. All of it is decisions rather than pixels, so both bindings share
 * one answer to "what does this query match, and where does the cursor go".
 */
/** A single runnable command. */
interface CommandDescriptor {
    /** Stable identity; also what `onRun` reports back. */
    id: string;
    /** The line the user reads. */
    label: string;
    /** Optional heading this command files under, e.g. "Navigation". */
    group?: string;
    /**
     * Extra words the query should match but the list should not show - aliases,
     * old names, the thing a user would guess before learning the real label.
     */
    keywords?: string;
    /** Key hint rendered on the trailing edge, e.g. "⌘S". Display only. */
    shortcut?: string;
    /** Listed but not runnable; the cursor skips it. */
    disabled?: boolean;
}

/**
 * Chat logic - the rules every chat surface reads from: how a flat message log
 * collapses into author runs, where the separators land, how a reaction bar
 * tallies, and what a bubble's corners, timestamp, and status resolve to.
 *
 * This is the layer where chat apps actually differ from one another, so it is
 * the layer most likely to drift. Everything here is a decision rather than a
 * pixel, which is why it lives once in commons and neither binding re-derives
 * any of it.
 *
 * Time is epoch milliseconds everywhere, never a `Date`. Three reasons, in
 * order of how much they hurt: messages arrive as JSON, so a number is what the
 * transport already carries and a `Date` would be a parse step at every
 * boundary; a number is a primitive, so it compares by value in a memo
 * dependency list where a freshly-allocated `Date` would re-render a virtualised
 * transcript on every tick; and equal moments compare equal with `===`, which is
 * exactly the identity a stable list key needs. Calendar arithmetic still goes
 * through the local-date constructor - see `calendar-view.ts`, whose `dayKey`
 * and `startOfDay` are reused here rather than re-implemented, because a day is
 * not always 86,400,000ms and a transcript that loses a day twice a year is
 * worse than one with no date rows at all.
 */
/** Epoch milliseconds. The one time representation the whole suite speaks. */
type Millis = number;
/**
 * How far along a message is on its way to the other end.
 *
 * Exported as a const array so the spec and both bindings derive one enum
 * instead of each transcribing the same five words.
 */
declare const deliveryStatuses: readonly ["sending", "sent", "delivered", "read", "failed"];
type DeliveryStatus$1 = (typeof deliveryStatuses)[number];
/** One person's one reaction, as the server stores it. */
interface Reaction {
    /** The rendered glyph. Compared as-is: the caller owns any normalisation. */
    emoji: string;
    /** Who reacted; also how the viewer's own reaction is recognised. */
    actorId: string;
    /** Optional, and deliberately unused for ordering - see `aggregateReactions`. */
    at?: Millis;
}
/** Something sent alongside (or instead of) text. */
interface ChatAttachment {
    /** Stable identity, and the render key. */
    id: string;
    /** Where the bytes are. Opaque here; each binding loads it its own way. */
    url?: string;
    /** As reported by the server or the file picker, e.g. `image/png`. */
    mimeType?: string;
    /** As the user sees it. Also the fallback when the mime type is useless. */
    fileName?: string;
    byteSize?: number;
    /** Intrinsic pixel size, so a renderer can reserve the box before the bytes land. */
    width?: number;
    height?: number;
    /** Playable length, for the audio and video renderers. */
    durationMs?: number;
}
/**
 * One message. Deliberately thin: everything a chat surface *decides* is
 * derived from these fields, and anything a particular app also needs rides
 * along on its own subtype - every function here is generic over `M extends
 * ChatMessage`, so extra fields survive grouping untouched.
 */
interface ChatMessage {
    /** Stable identity. Optimistic sends must keep the same id once acked, or
     *  the group and the unread anchor both lose their place. */
    id: string;
    /** Who sent it. Grouping compares these; it never compares display names,
     *  which two different people can share. */
    authorId: string;
    /** When it was sent, epoch millis. */
    at: Millis;
    text?: string;
    attachments?: ChatAttachment[];
    reactions?: Reaction[];
    /** Omitted for anything received - status is about the viewer's own outbox. */
    status?: DeliveryStatus$1;
    /**
     * When it was read, epoch millis. The history behind the `read` rung: the
     * status says *that* it was opened and this says *when*, which is the
     * difference between a tick and a receipt.
     */
    readAt?: Millis;
    /**
     * Who has read it. Only meaningful in a thread with more than two people,
     * where a single `read` tick cannot say which of five participants opened it;
     * see `readReceipt`.
     */
    readBy?: MessageReader[];
    /** The message this one answers, for a quoted preview. */
    replyToId?: string;
    editedAt?: Millis;
    /**
     * Refuses to be merged with its neighbours in either direction. This is how a
     * system notice ("Ana joined"), a call record, or a date-change notice stays
     * on its own row instead of being swallowed into whichever author happened to
     * speak on both sides of it.
     */
    breaksGroup?: boolean;
}
/**
 * A run of consecutive messages from one author, rendered as one stack with a
 * single avatar and header.
 */
interface MessageGroup$1<M extends ChatMessage = ChatMessage> {
    /**
     * The first message's id. Derived rather than generated so the key survives a
     * re-group: appending a message either extends this run (id unchanged) or
     * starts a new one, and React never sees the whole transcript remount.
     */
    id: string;
    authorId: string;
    /** In render order, never empty. */
    messages: M[];
    /** The first message's time - what a group header prints. */
    startedAt: Millis;
    /** The last message's time - what a trailing stamp prints. */
    endedAt: Millis;
    /** `YYYY-MM-DD`, local. Groups never span days, so one key always fits. */
    dayKey: string;
    /** The least advanced status among the members; see `leastDelivery`. */
    status?: DeliveryStatus$1;
    /** The run is a single message that refused to merge - a system notice. */
    standalone: boolean;
    /**
     * This run picked up where an earlier run from the same author left off,
     * because a separator was pushed between them. The renderer should suppress
     * the repeated avatar and name; only `insertSeparators` ever sets it.
     */
    continued: boolean;
}
/**
 * Where a message sits in its run. Drives corner radii and the tail: `only` is
 * a fully rounded bubble with a tail, `first`/`middle`/`last` flatten the edge
 * facing their neighbour so a stack reads as one block.
 */
type BubblePosition = 'only' | 'first' | 'middle' | 'last';
/**
 * Which shape a timestamp should take. Not the text - the *shape*; see
 * `messageTimestamp` for why no English appears in this module.
 *
 * - `time` - the clock, e.g. "9:41 AM". What a bubble's own stamp shows.
 * - `yesterday` - the previous calendar day, spelled by the caller's
 *   `Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day')`.
 * - `weekday` - within the last week, e.g. "Tuesday".
 * - `date` - this year, e.g. "Mar 3".
 * - `dateWithYear` - any other year, e.g. "Mar 3, 2024".
 */
type MessageTimestampKind = 'time' | 'yesterday' | 'weekday' | 'date' | 'dateWithYear';
/** How much of the moment the caller wants spelled out. */
type MessageTimestampStyle = 
/** The full ladder: clock today, "Yesterday", weekday, then a date. */
'auto'
/** Always the clock, whatever day it was. */
 | 'time'
/** Always the calendar date - what a date separator row prints. */
 | 'date';
/**
 * The subset of `Intl.DateTimeFormatOptions` these kinds need, declared
 * structurally rather than imported.
 *
 * Two reasons: commons must not reach for a platform lib, and Hermes ships
 * without full ICU on some builds - a binding that has to hand-roll the
 * formatting should still be handed the same description of what to print,
 * rather than a type it cannot satisfy. The shape is assignable to
 * `Intl.DateTimeFormatOptions`, so the common case is a direct spread.
 */
interface MessageTimestampFormat {
    hour?: 'numeric';
    minute?: '2-digit';
    weekday?: 'long';
    month?: 'short';
    day?: 'numeric';
    year?: 'numeric';
}
/**
 * A moment plus a description of how to spell it - never a spelled string.
 *
 * Formatting a date is locale work, and a design system that returns "Mar 3"
 * has just hardcoded English into every app that consumes it. So this returns
 * the decision (which of the five shapes applies) and leaves the words to the
 * caller's `Intl` or catalog. `formatMessageTimestamp` is the convenience path
 * for callers who are happy with `Intl`.
 */
interface MessageTimestamp {
    kind: MessageTimestampKind;
    /** The moment, unchanged, so the caller formats from the source of truth. */
    at: Millis;
    /** Whole local days between `at` and `now`; 0 is today, negative is the future. */
    daysAgo: number;
    /** The fields `kind` wants rendered. */
    format: MessageTimestampFormat;
}
/**
 * One person's read of one message.
 *
 * Separate from `Reaction` even though the shape rhymes, because a reaction is
 * something the reader chose to say and a receipt is something their client
 * reported. Conflating them is how "seen by" ends up in a menu that also offers
 * to remove it.
 */
interface MessageReader {
    /** Who read it. The identity, and the de-duplication key. */
    actorId: string;
    /** Their display name, already resolved by the caller. */
    name?: string;
    /** When they read it. The latest of these is what a receipt line prints. */
    at?: Millis;
}
/**
 * The sentences a read receipt needs, one per shape. Every template may use
 * `{names}` (the shown names, joined), `{first}`, `{last}`, `{count}` (how many
 * are hidden), `{total}`, and `{time}`.
 */
interface ReadReceiptTemplates {
    /** Rendered when nobody has read it. Omit for the usual empty string. */
    none?: string;
    /** e.g. `'Read {time}'` in a two-person thread, `'Read by {first}'` in a group. */
    one: string;
    /** e.g. `'Read by {first} and {last}'` */
    two: string;
    /** e.g. `'Read by {names}'` */
    several: string;
    /** e.g. `'Read by {first} and {count} others'` */
    many: string;
}
/**
 * The sentences a typing indicator needs, one per shape. Every template may use
 * `{names}` (the shown names, joined), `{first}`, `{last}`, `{count}` (how many
 * are hidden), and `{total}`.
 */
interface TypingTemplates {
    /** Rendered when nobody is typing. Omit for the usual empty string. */
    none?: string;
    /** e.g. `'{first} is typing'` */
    one: string;
    /** e.g. `'{first} and {last} are typing'` */
    two: string;
    /** e.g. `'{names} are typing'` */
    several: string;
    /** e.g. `'{first} and {count} others are typing'` */
    many: string;
}
/** Which renderer an attachment gets. */
type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

/**
 * Compose rules - everything a message bar decides before a character is drawn.
 *
 * `chat.ts` owns the transcript that has already happened and `message.ts` owns
 * how one message is drawn. This module owns the other end of the thread: the
 * draft the reader has not sent yet, and the handful of decisions that turn a
 * keystroke into either a newline or an irreversible send.
 *
 * The Enter policy is the reason this file exists rather than living in the DOM
 * binding. It is the single most destructive decision in a chat client - get it
 * wrong and half a thought goes out to a colleague - and it is decided from four
 * booleans on a key event. Written twice, the two platforms drift on the one
 * case nobody tests (the IME guard), and the drift is invisible until someone
 * typing Japanese sends a message every time they commit a candidate.
 *
 * Nothing here renders, measures, or reads a `window`. Auto-grow in particular
 * is deliberately absent: the DOM reaches its height with a replicated twin and
 * no measurement at all, and React Native reaches the same height through
 * `onContentSizeChange`, so `minRows` and `maxRows` travel as plain numbers and
 * each binding spends them in its own idiom. A shared "measure the text" helper
 * would be a DOM function with a native caller that could not use it.
 */

/**
 * How a draft stands against its limit.
 *
 * Three states rather than a raw number because the counter should not be a
 * live readout. A number that changes on every keystroke is noise on screen and
 * a firehose in a live region; what a writer needs is the moment the budget
 * starts to matter and the moment it is gone. Bindings announce on a transition
 * between these, not on a change of `count`.
 */
declare const draftMeterStates: readonly ["idle", "near", "over"];
type DraftMeterState = (typeof draftMeterStates)[number];
interface DraftMeter {
    count: number;
    /** Undefined when the draft has no limit; `state` is then always `idle`. */
    max?: number;
    /** `max - count`, negative once over. Undefined with no limit. */
    remaining?: number;
    state: DraftMeterState;
}
/**
 * What a send hands back.
 *
 * One object rather than a bare string, because a reply and an edit are part of
 * what is being sent. A composer whose `onSend` takes only text forces the app
 * to read its own "replying to" state after the callback fires, and that is
 * precisely the race that answers the wrong message: the banner has already
 * been cleared by the same interaction that sent.
 */
interface ComposerSubmission {
    /** The draft, trimmed. Never the raw value, and never empty when attachments are. */
    text: string;
    /** The staged attachments, in order. Empty rather than undefined. */
    attachments: ChatAttachment[];
    /** The message this one answers, when the reply banner was up. */
    replyToId?: string;
    /** The message being rewritten, when the bar was in edit mode. */
    editingId?: string;
}
/**
 * The quoted strip above the field, resolved rather than handed over as markup.
 *
 * A `ReactNode` here would push the strip to the app, and then two apps and two
 * platforms draw the same preview three different ways - and, worse, route
 * around `attachmentKind`, so a voice note quoted in the composer and the same
 * voice note in the transcript get called different things.
 */
interface ReplyPreview {
    /** The message being answered. Travels with the send as `replyToId`. */
    id: string;
    /** Who wrote it, already resolved to a display name by the caller. */
    authorName?: string;
    /** The excerpt, already cut to `REPLY_PREVIEW_LIMIT`. */
    text: string;
    /** Set when the quoted message was media rather than words. */
    kind?: 'image' | 'video' | 'audio' | 'file';
    /** True when the excerpt was cut, so a binding can add its own ellipsis. */
    truncated: boolean;
}

/**
 * Status and chrome decisions - the small, load-bearing answers the message
 * atoms and the conversation chrome need before anything is painted: which
 * SHAPE a delivery state draws, how much of a quoted message survives, and what
 * a connection does between losing the network and getting it back.
 *
 * None of it is pixels, all of it is shared. A tick cluster that means "read" on
 * the web and "delivered" on the phone, or a reply preview that cuts at 100
 * characters in one binding and 140 in the other, are the exact drifts this file
 * exists to make impossible.
 *
 * `chat.ts` owns the transcript rules (grouping, separators, timestamps, typing
 * state, delivery ordering) and is consumed here rather than re-derived -
 * `deliveryRank` in particular, which is the one authority on how far along a
 * message is.
 *
 * Scoped to delivery: the quoted-message, system-message, typing, thread, and
 * connection helpers that used to live here went with the components that were
 * their only callers.
 */

/** The text alternative for each delivery state; every tick has to say its name. */
interface DeliveryLabels {
    sending: string;
    sent: string;
    delivered: string;
    read: string;
    failed: string;
}

/**
 * Message presentation - the measurements and mappings a rendered message needs,
 * as opposed to the rules about the transcript itself.
 *
 * `chat.ts` owns WHAT a transcript is: where runs break, where separators land,
 * which slot in a run a message occupies, which status a stack advertises. This
 * module owns HOW WIDE and HOW ROUND - the handful of numbers and names that a
 * DOM bubble and a React Native bubble must agree on or the two kits quietly
 * draw different chat apps.
 *
 * Delivery is NOT here. Which shape a status draws, which token tints it, and
 * what it is called all live in `status.ts`, because the same answers are needed
 * by the standalone delivery mark as by a bubble's meta line - and a second copy
 * of that table is how "delivered" and "read" end up sharing a silhouette on one
 * surface and not the other.
 *
 * The split matters because these are the values most likely to be re-guessed:
 * a corner radius or a max-width ratio looks like styling, so it gets typed into
 * a stylesheet on one side and a style object on the other, and nobody notices
 * they disagree until a screenshot comparison. Everything here is therefore
 * either a bare `--glacier-*` token name (each binding wraps it its own way) or
 * a plain number, and neither binding is allowed a literal of its own.
 *
 * Nothing here is added to `chat.ts`: that module is the log's contract and is
 * consumed by the list, the reactions, and the typing atoms as well. This one is
 * only about drawing a message.
 */

/**
 * The two chat layouts, which are genuinely different products rather than two
 * skins of one.
 *
 * - `bubble` - iMessage, WhatsApp, Signal. A tinted, rounded, edge-aligned
 *   capsule whose corners encode its place in a run, sized to its content and
 *   capped well short of the column so authorship is legible from shape and
 *   position alone.
 * - `row` - Slack, Discord, IRC. Full-width prose with an avatar gutter and a
 *   name/time header, no fill at all. Alignment carries no meaning here, so the
 *   header has to say who is talking.
 */
type MessageLayout = 'bubble' | 'row';
/**
 * Which edge of the transcript a message hugs, in logical terms.
 *
 * Deliberately `start`/`end` rather than `left`/`right`. The physical reading is
 * a consequence of the writing direction, not a property of the message: an
 * Arabic transcript mirrors as a whole, exactly the way the platform's own chat
 * app does, and pinning "mine" to the physical right would leave the viewer's
 * own messages on the wrong side of their own language.
 */
type MessageSide = 'start' | 'end';
/**
 * Everything a message says out loud.
 *
 * The five delivery words are `DeliveryLabels` verbatim rather than restated,
 * because a bubble's meta line and a standalone delivery mark are reporting the
 * same fact: two sets would let a transcript say "Not sent" beside the glyph and
 * "Not delivered" under it. `edited` is the only word a message owns that a
 * delivery mark has no use for, so it is the only one added here.
 */
interface MessageLabels extends DeliveryLabels {
    /** Appended to a message whose author has since changed it. */
    edited: string;
}

interface LevelRecorderOptions {
    /** How many buckets span the track. A few dozen is all a bar can resolve. */
    buckets?: number;
    /**
     * Scales the recorded loudness so a normal mix fills the bar. RMS of music
     * sits well below 1.0, so painting it raw leaves a nearly flat waveform.
     */
    gain?: number;
}
/** Reads the current loudness of whatever is playing, as 0..1. */
type LoudnessMeter = () => number;
interface UseLiveLevelsOptions extends LevelRecorderOptions {
    /** Where the loudness readings come from. Null while nothing is playing. */
    meter: LoudnessMeter | null;
    /** Current playhead position as 0..1 of the duration. */
    progress: number;
    /** Only sample while this is true, so a paused player costs nothing. */
    active: boolean;
    /**
     * Milliseconds between readings. Buckets move far slower than the frame
     * rate, so a timer at ~20Hz is both plenty and cheaper than a render loop.
     */
    intervalMs?: number;
}
/**
 * Records levels from a playing source and re-renders as they fill in.
 *
 * Pure React and timers only - no DOM, no React Native - so the same hook backs
 * both bindings. All either platform supplies is a `meter`: an `AnalyserNode`
 * on the web, a player's metering on a device.
 *
 * `progress` is read through a ref rather than a dependency, so the sampling
 * timer survives playback instead of being torn down and rebuilt every tick.
 */
declare function useLiveLevels({ meter, progress, active, buckets, gain, intervalMs, }: UseLiveLevelsOptions): number[];

/**
 * Beat tracking - turns a stream of loudness readings into the small amount of
 * state a seek bar needs to move with the music: a `pulse` that jumps when the
 * track hits and falls back between hits, and the beats still travelling
 * outward along the bar as ripples.
 *
 * Two decisions are worth stating, because both are what keeps this honest on
 * real music rather than only on a metronome:
 *
 * 1. **The threshold adapts.** A beat is a reading louder than the recent
 *    running average, never louder than some constant - so a quiet intro and a
 *    loud chorus both produce beats, and a loud passage does not read as one
 *    continuous hit.
 * 2. **Strength is measured against the recent peak**, not against 1.0. RMS of
 *    a normal mix sits well below full scale, so scoring hits absolutely would
 *    make every beat a whisper.
 *
 * Renderer- and platform-agnostic on purpose, exactly like the level recorder
 * beside it: it takes a loudness number and a timestamp, nothing more. Each
 * binding supplies its own meter - a Web Audio analyser on the web, a player's
 * metering on a device.
 */

interface BeatTrackerOptions {
    /**
     * How fast the running average follows the music, 0..1 per reading. Higher
     * forgets sooner, so only the sharpest hits clear the bar.
     */
    adaptation?: number;
    /** How far above the running average a reading must sit to count as a beat. */
    threshold?: number;
    /** Shortest gap between beats in ms; ~180ms caps it around 330bpm. */
    minGapMs?: number;
    /** How long the pulse takes to fall halfway back to rest, in ms. */
    halfLifeMs?: number;
}
interface UseBeatOptions extends BeatTrackerOptions {
    /** Where the loudness readings come from. Null while nothing is playing. */
    meter: LoudnessMeter | null;
    /**
     * Only sample while this is true. Turning it off does not cut the bar's
     * movement off with it - the beat eases away over `SETTLE_MS` first, and only
     * then does the frame loop stop, so a paused player still costs nothing.
     */
    active: boolean;
    /**
     * Where a beat lands on the bar, 0..1 of its width - normally the playhead,
     * so hits ripple out from the position they were heard at.
     */
    at?: number;
    /** How long a ripple takes to travel and fade, in ms. */
    rippleMs?: number;
    /** The most ripples alive at once; the oldest is dropped past this. */
    maxRipples?: number;
}
/**
 * Samples a meter every frame and hands back what the seek bar draws with: the
 * current pulse, and the beats still travelling.
 *
 * Every frame, because the whole point is a deformation the eye reads as being
 * in time with the music - `useLiveLevels` beside it can afford a 20Hz timer
 * because a waveform bucket settles slowly, but a beat that arrives a frame or
 * two late reads as sloppy rather than as tight.
 *
 * Returns one shared at-rest value while nothing is playing, so an idle bar
 * does not re-render on a new-but-identical object.
 */
declare function useBeat({ meter, active, at, rippleMs, maxRipples, ...tracker }: UseBeatOptions): SeekBarBeat;

/**
 * A fan's resting focus: its own middle.
 *
 * This is what puts the density at the ENDS rather than spreading everything
 * evenly - the centre items claim the room and the outer ones tuck in behind
 * each other, which is both how a fan of cards sits in a hand and the only way a
 * forty-item fan fits the strip a seven-item one does.
 */
declare function restFocus(count: number): number;

type SeekBarShape = (typeof seekBarShapes)[number];
type SeekBarTone = (typeof seekBarTones)[number];
type SeekBarFill = (typeof seekBarFills)[number];
type SeekBarRail = (typeof seekBarRails)[number];
interface SeekBarProps extends Omit<ComponentProps<'div'>, 'onChange' | 'defaultValue'> {
    /** Track length in seconds. */
    duration: number;
    /** Controlled playhead position in seconds. */
    value?: number;
    /** Initial position when uncontrolled. */
    defaultValue?: number;
    /** Called with the position in seconds as the user scrubs or keys. */
    onValueChange?: (seconds: number) => void;
    /**
     * Called once with the final position when a scrub is released, for players
     * that seek on commit rather than on every pointer move.
     */
    onSeekEnd?: (seconds: number) => void;
    /** How progress is painted. */
    shape?: SeekBarShape;
    /** Colour family the played run paints from; the run ahead stays muted in every tone. */
    tone?: SeekBarTone;
    /** Flat token, or a ramp along the played run between the tone's two tokens. */
    fill?: SeekBarFill;
    /**
     * How visible the run ahead of the playhead is. Muted suits the page surface;
     * contrast lifts it for raised surfaces like a card.
     */
    rail?: SeekBarRail;
    /**
     * Normalized 0-1 loudness samples, read by the waveform, spikes, bars, and
     * mirror shapes. Omitted, every sample reads as full.
     */
    levels?: number[];
    /**
     * Live beat state - a 0-1 `pulse` and the hits still travelling as `ripples`.
     * The squiggle swells with the pulse and each hit rises as a crest and
     * ripples outward, so the bar deforms in time with the music. `useBeat` in
     * `@glacier/logic` produces this from the same meter the levels come from.
     * Ignored by `line`, and dropped entirely under reduced motion.
     */
    beat?: SeekBarBeat;
    /**
     * How hard the `beat` deforms the bar, from 0 (still) to
     * `SEEK_MAX_INTENSITY`. Defaults to `SEEK_DEFAULT_INTENSITY` (1), the tuned
     * baseline. Turn it up for a bar that is the hero
     * of a now-playing screen, down for one sitting in a dense list. Setting 0
     * leaves the bar still without the caller having to tear down its meter.
     */
    intensity?: number;
    /**
     * Draws a tracer under the played run: a half-opacity copy of the bar in its
     * own tone, lagging the beat by a fixed slice of time. It holds its shape
     * only as long as the beat it trails does, sinking back toward the flat rail
     * between hits and being thrown out again by the next one - so it reads as
     * something settling behind the bar rather than a second copy of it. Needs a
     * `beat` to lag behind; without one there is nothing to hold it out, so
     * nothing is drawn. Dropped under reduced motion along with the beat itself.
     */
    tracer?: boolean;
    /** Arrow-key step in seconds; Page keys move by ten steps. */
    step?: number;
    /** Formats a position for aria-valuetext. Defaults to m:ss. */
    formatTime?: (seconds: number) => string;
    /** Bar height step. */
    size?: 'sm' | 'md';
    /** Dims the bar and blocks pointer and keyboard input. */
    disabled?: boolean;
    /** Renders a placeholder with the exact geometry. */
    skeleton?: boolean;
    /** Accessible name for the scrubber, e.g. "Seek". */
    'aria-label': string;
}
/**
 * The transport scrubber for audio: press or drag anywhere on the bar to seek.
 * `shape` decides how it paints - a plain rail, a squiggle behind the playhead,
 * or a waveform of the track's `levels` - while the interaction, semantics, and
 * geometry stay identical across all of them.
 */
declare function SeekBar({ duration, value, defaultValue, onValueChange, onSeekEnd, shape, tone, fill, rail, levels, beat, intensity, tracer, step, formatTime, size, disabled, skeleton, className, style, 'aria-label': ariaLabel, ...rest }: SeekBarProps): react.JSX.Element;

/**
 * Wires a Web Audio analyser onto a playing `<audio>` (or `<video>`) element and
 * hands back a loudness meter - the sampler `useLiveLevels` reads to build a
 * SeekBar's waveform while the track plays, instead of measuring the file up
 * front.
 *
 * Web only: the Web Audio API has no React Native equivalent, so a device build
 * feeds `useLiveLevels` from its own player's metering instead. The shared
 * bookkeeping lives in @glacier/logic, which is why only this thin adapter is
 * platform-specific.
 *
 * Two constraints the browser imposes, both easy to trip over:
 *
 * 1. **Call this inside a user gesture.** An `AudioContext` built before the
 *    first real interaction is created suspended, and on WebKit it can stay
 *    silent permanently even after `resume()`. Create the meter in the same
 *    handler that starts playback.
 * 2. **The audio must be CORS-clean.** Cross-origin media taints the graph and
 *    the analyser reads pure silence, with no error to tell you why. Set
 *    `crossOrigin="anonymous"` on the element and serve the audio with
 *    `Access-Control-Allow-Origin`.
 *
 * An element can only be connected to one source node for its lifetime, so the
 * returned meter is cached against the element and re-calling this is safe.
 */
/**
 * One element's seat at the mixer: the gain between its source node and the
 * analyser. Levels set here sit ahead of everything the graph does - the meter
 * reads them, the EQ shapes their sum, the deck bends it, the fader weighs it -
 * which is what makes two seats a crossfade rather than two players.
 */
interface AnalyserMixSource {
    /** Sets this element's share of the mix, 0..1, immediately. */
    setLevel(level: number): void;
    /**
     * Glides this element's share to `level` over `seconds`, on the audio clock.
     * The path is the equal-power quarter-wave, so a pair of these - one rising,
     * one falling - holds the blend's loudness steady through the middle of a
     * crossfade instead of dipping there. A later `setLevel` or `fadeLevel`
     * supersedes whatever is still scheduled.
     */
    fadeLevel(level: number, seconds: number): void;
}
/**
 * The scratch surface: a hand on the platter, heard.
 *
 * A media element cannot play backwards, and seeking it repeatedly is a
 * decoder restart, not a scrub - so this is built the way a tape machine is.
 * A worklet sits in the graph just ahead of the deck and keeps a ring of the
 * last little while of everything that actually played. `hold` freezes the
 * tape and hands the output to a read head; `move` tells the head where the
 * hand is, and the head chases it - through a critically-damped spring, so
 * sixty pointer events a second read as one continuous motion rather than a
 * zipper - sounding the ring at whatever velocity the chase requires,
 * forwards or backwards, silent when the hand rests. `release` hands the
 * chain back to the live element.
 *
 * The capture point is ahead of the deck on purpose: the deck is where brakes
 * and spin-ups bend the signal, so the tape holds the song at true speed no
 * matter what the transport was doing to it.
 *
 * The caller owns the element: pause it when it calls `hold` (the tape
 * freezes either way, but a playing element would keep buying audio nobody
 * hears), and seek-then-play on `release` using the offset it returns.
 */
interface AnalyserScrub {
    /**
     * True once the engine is standing: the worklet module loaded and the ring
     * is recording. False where AudioWorklet is missing, in which case every
     * other call is a safe no-op and `release` answers 0 - callers keep their
     * seek-only fallback.
     */
    ready(): boolean;
    /**
     * Grab the platter: freeze the tape and take over the chain's output.
     * `atSeconds` is where the song stands - the head's anchor, and what maps
     * both tapes onto the song's own clock.
     */
    hold(atSeconds: number): void;
    /**
     * Where the hand is, in seconds of song relative to the grab - negative is
     * back, positive forward. With the whole song loaded the head roams the
     * entire track; on the ring alone it can only reach what has played, and
     * parks at the tape's edge rather than reading fiction.
     */
    move(offsetSeconds: number): void;
    /** Where the head actually is right now, seconds relative to the grab. */
    offset(): number;
    /** Loudness of what the scrub is sounding, 0..1-ish - a liveness signal. */
    level(): number;
    /** Let go: hand the chain back to the element. Returns the settled offset,
     *  which is where the caller should land its seek. */
    release(): number;
    /**
     * Forget the ring. Call across every seek - its map onto the song's clock
     * broke with the jump. The whole-song tape is indexed absolutely and
     * survives; only `eject` drops it.
     */
    clear(): void;
    /**
     * Hand the engine the WHOLE song: mono PCM at `rate` covering `duration`
     * seconds from the top of the track. From then on the head roams the entire
     * file, both directions, the way a tape machine's does - this is what turns
     * "scratch what has played" into "scrub the record". The buffer is
     * transferred, not copied; the caller's copy is gone after this.
     */
    load(pcm: Float32Array, rate: number, duration: number): void;
    /** Whether a whole-song tape is loaded. */
    loaded(): boolean;
    /** A new source: drop the song tape AND the ring. */
    eject(): void;
    /** Dev: logs the engine's internals to the console, one line. */
    probe(): void;
}
interface AnalyserMeter {
    /** Current loudness, 0..1. Safe to call at any rate. */
    meter: LoudnessMeter;
    /**
     * Instantaneous spectrum as `count` log-spaced bands, each 0..1, low to
     * high. Log-spaced because that is how the ear hears it: an octave per
     * band-ish, so bass does not eat the whole readout. Safe to call at any
     * rate; a silent or suspended graph reads all zeros.
     */
    spectrum(count: number): number[];
    /**
     * Seats another element at the same mixer - or returns the seat an element
     * already holds, including the one the meter was created on. The newcomer
     * plays through the whole shared chain: metered by the same analyser, shaped
     * by the same EQ, bent by the same deck, weighed by the same fader. This is
     * the crossfade primitive: two elements, two seats, one signal path.
     *
     * The same one-source-per-element rule applies as at creation: an element
     * seated here is spent, and belongs to this graph for the rest of its life.
     * Seating it at a second meter throws rather than going quietly silent.
     */
    addSource(element: HTMLMediaElement): AnalyserMixSource;
    /**
     * Evens out loud and quiet - night listening - with a gentle compressor
     * slipped in after the EQ. The analyser sits ahead of it, so the bar keeps
     * reading the track's real dynamics while the ear gets the tamed ones. Off
     * (the default) routes around it entirely: transparent means absent, not
     * merely configured quiet.
     */
    setDynamics(on: boolean): void;
    /**
     * Folds the channels together and plays the same signal to both ears. The
     * fold happens at the fader, past the meter and the shaping, so nothing else
     * changes - accessibility, or one earbud shared.
     */
    setMono(on: boolean): void;
    /**
     * Sets playback loudness, 0..1, on the gain that follows the analyser. The
     * meter reads the source ahead of it, so the fader changes how loud the track
     * is without changing how far the bar moves. Set 0 to silence playback while
     * still metering (gate the visual separately if a muted bar should rest).
     */
    setVolume(volume: number): void;
    /**
     * Glides the same gain to a target over `seconds`, scheduled on the audio
     * clock rather than stepped from JavaScript - the graph interpolates it
     * per sample, so a fade to silence is a fade, not a zipper. A later
     * `setVolume` or `rampVolume` supersedes whatever is still scheduled.
     */
    rampVolume(volume: number, seconds: number): void;
    /**
     * Glides playback speed to `to` (1 = as recorded) over `seconds`, dragging
     * pitch with it - a deck slowing to a stop, or picking back up.
     *
     * This is done in the graph rather than through the element's `playbackRate`,
     * which is the only other way to change the speed of a live stream and is a
     * poor one: it is the media engine's own resampler, it is re-tuned on every
     * write, and how it behaves across a pause differs by engine (WebKit will
     * quietly hand the rate back to its default). Here the speed is a property of
     * the audio graph, interpolated per sample on the audio thread, and does the
     * same thing on every engine.
     *
     * The glide is geometric: the speed moves by a constant factor per unit time,
     * so it travels the same number of semitones every step and is heard as one
     * even sweep. A later `rampSpeed` or `resetSpeed` supersedes it, picking up
     * from whatever speed the glide had reached.
     */
    rampSpeed(to: number, seconds: number): void;
    /**
     * Drops the lag the glides have built up and parks the deck at `speed`,
     * without gliding there.
     *
     * The lag is the mechanism: a stream is slowed by reading it through a delay
     * line that lengthens, so every glide below full speed leaves the graph
     * running that much behind the element - a fifth of a second across a stop
     * and a start, and it accumulates. Dropping it is a jump in the signal, so
     * call this only while nothing can be heard (paused, or faded out); the
     * `speed` it parks at is where the next glide will start from, since a delay
     * line of a fixed length has no speed of its own to hold.
     */
    resetSpeed(speed?: number): void;
    /** The scratch surface - see `AnalyserScrub`. Always present; where the
     * platform has no AudioWorklet it reports `ready() === false` and every
     * call is a safe no-op. */
    scrub: AnalyserScrub;
    /** The centre frequency (Hz) of each EQ band, low to high, index-aligned with
     * `setEqGains`. */
    eqFrequencies: readonly number[];
    /**
     * Sets the eight band gains, in dB, in `eqFrequencies` order.
     *
     * Boosts are paid for automatically: a broadband headroom stage after the
     * cascade attenuates by the curve's true combined maximum, so a +8dB preset
     * changes the shape of the sound without driving a 0dBFS master past the
     * DAC and into clipping. Flat costs nothing - the stage sits at unity.
     * All moves glide (~150ms); switching presets never clicks.
     */
    setEqGains(gains: readonly number[]): void;
    /**
     * Resumes the underlying AudioContext. A context built outside a user gesture
     * starts suspended, so metering (and, since the graph reaches the speakers,
     * playback itself) stays silent until this is called from within one - the
     * click that starts the track. WebKit also parks idle contexts in its
     * nonstandard 'interrupted' state; this wakes those too. Safe to call
     * repeatedly - call it on every play press, not just the first.
     */
    resume(): Promise<void>;
    /**
     * Tears the audio graph down. One way: routing an element through Web Audio
     * cannot be undone, and it may not be given a second source node, so the
     * element is silent afterwards and can never be metered again. Only reach for
     * this when the element is being thrown away with it.
     */
    dispose(): void;
}
declare function createAnalyserMeter(element: HTMLMediaElement): AnalyserMeter;

type SkeletonVariant = (typeof skeletonVariants)[number];
interface SkeletonProps extends ComponentProps<'span'> {
    /** text is a 1em line, rect a rounded block, circle a disc. */
    variant?: SkeletonVariant;
    width?: string | number;
    height?: string | number;
    /** Corner radius override, e.g. var(--glacier-control-radius). */
    radius?: string;
}
/**
 * The kit's one skeleton primitive. Every component's `skeleton` prop renders
 * through this, passing the same tokens the live component consumes, so
 * placeholders always match the real geometry and content never shifts on
 * arrival. Skeletons are decorative (aria-hidden); mark the loading region
 * itself with aria-busy at the app level. Shimmer becomes an opacity pulse
 * under prefers-reduced-motion.
 */
declare function Skeleton({ variant, width, height, radius, className, style, ...rest }: SkeletonProps): react.JSX.Element;

interface ToggleProps extends Omit<ComponentProps<typeof motion.button>, 'children'> {
    pressed?: boolean;
    defaultPressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
    size?: ControlSize;
    /** Square icon-only layout, like IconButton. */
    iconOnly?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
    /** Required when the content is icon-only. */
    'aria-label'?: string;
    children?: ReactNode;
}
/**
 * A press-state button (aria-pressed) for stateful actions: password reveal,
 * view modes, formatting toolbars. Pressed renders in the accent soft tint.
 * For on/off settings, use Switch instead.
 */
declare function Toggle({ pressed, defaultPressed, onPressedChange, size, iconOnly, skeleton, glass, disabled, className, children, onClick, ...rest }: ToggleProps): react.JSX.Element;

type MeterTone = (typeof meterTones)[number];
interface MeterProps extends ComponentProps<'div'> {
    /** Current level, 0 to max. */
    value: number;
    /** Upper bound. Defaults to the segment count, so value maps 1:1 to segments. */
    max?: number;
    /** Number of discrete segments. */
    segments?: number;
    /**
     * Fill color. 'auto' grades by level: the bottom third reads danger, the
     * middle third warning, the top success. Suits strength and health meters.
     */
    tone?: MeterTone;
    size?: 'sm' | 'md';
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Accessible name for the meter. */
    'aria-label'?: string;
}
/**
 * A segmented level indicator (health bar): discrete pips that fill from the
 * left. Use ProgressBar for task progress; Meter is for how good or full
 * something currently is, like password strength or remaining quota.
 */
declare function Meter({ value, max, segments, tone, size, skeleton, className, ...rest }: MeterProps): react.JSX.Element;

type TextareaSize = (typeof textareaSizes)[number];
interface TextareaProps extends Omit<ComponentProps<'textarea'>, 'size'> {
    size?: TextareaSize;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
}
declare function Textarea({ size, skeleton, glass, className, id, ...rest }: TextareaProps): react.JSX.Element;

interface SearchFieldProps extends Omit<ComponentProps<'input'>, 'value' | 'defaultValue' | 'onChange' | 'size'> {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    placeholder?: string;
    size?: 'sm' | 'md' | 'lg';
    /** Right-aligned slot for a keyboard shortcut hint, e.g. a Kbd. */
    shortcut?: ReactNode;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
}
declare function SearchField({ value: controlledValue, defaultValue, onValueChange, placeholder, size, shortcut, skeleton, glass, className, id, ...rest }: SearchFieldProps): react.JSX.Element;

interface NumberInputProps extends Omit<ComponentProps<'input'>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'size'> {
    value?: number;
    defaultValue?: number;
    min?: number;
    max?: number;
    step?: number;
    onValueChange?: (value: number) => void;
    size?: ControlSize;
    disabled?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
    'aria-label'?: string;
    /** Set to "none" to opt this stepper out of haptic feedback. */
    'data-haptic'?: string;
}
/**
 * A numeric stepper: a minus button, a centered native number input with
 * tabular figures, and a plus button, wrapped in a bordered group at control
 * height. Results clamp to min and max, and the step buttons disable at the
 * bounds.
 *
 * Haptics: every committed step (button tap, hold-repeat tick, ArrowUp or
 * ArrowDown) fires a selection tick; a step that clamps at min or max bumps
 * medium once until the value leaves the bound; typed digits are silent and
 * their blur-commit fires one light. data-haptic="none" opts all of it out.
 */
declare function NumberInput({ value, defaultValue, min, max, step, onValueChange, size, disabled, skeleton, glass, className, id, 'aria-label': ariaLabel, onKeyDown, onBlur, ...rest }: NumberInputProps): react.JSX.Element;

type ProgressRingTone = (typeof progressRingTones)[number];
interface ProgressRingProps extends ComponentProps<'div'> {
    /** 0 to max. Clamped into range. */
    value: number;
    max?: number;
    /** Pixel diameter of the ring. */
    size?: number;
    /** Stroke width of the track and arc in pixels. */
    thickness?: number;
    tone?: ProgressRingTone;
    /** Centered content. Takes priority over showValue. */
    label?: ReactNode;
    /** With no label, render the rounded percentage in the center. */
    showValue?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Accessible name for the ring. */
    'aria-label'?: string;
}
declare function ProgressRing({ value, max, size, thickness, tone, label, showValue, skeleton, className, ...rest }: ProgressRingProps): react.JSX.Element;

type AvatarSize = (typeof avatarSizes)[number];
type AvatarShape = (typeof avatarShapes)[number];
interface AvatarProps extends Omit<ComponentProps<'span'>, 'children'> {
    src?: string;
    alt?: string;
    /** Falls back to initials of up to two words when there is no image. */
    name?: string;
    size?: AvatarSize;
    shape?: AvatarShape;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
}
declare function Avatar({ src, alt, name, size, shape, skeleton, glass, className, ...rest }: AvatarProps): react.JSX.Element;

type StatusDotTone = (typeof tones)[number];
interface StatusDotProps extends Omit<ComponentProps<'span'>, 'children'> {
    tone?: StatusDotTone;
    /** Adds an animated expanding ring for live states. */
    pulse?: boolean;
    size?: 'sm' | 'md';
    /** Accessible name. When set, the dot becomes a status region; otherwise it is decorative. */
    label?: string;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
}
declare function StatusDot({ tone, pulse, size, label, skeleton, className, ...rest }: StatusDotProps): react.JSX.Element;

type CounterBadgeTone = (typeof counterBadgeTones)[number];
interface CounterBadgeProps extends Omit<ComponentProps<'span'>, 'children'> {
    count: number;
    /** Render `${max}+` when count is greater than max. */
    max?: number;
    tone?: CounterBadgeTone;
    /** Render a small dot with no number, for presence or attention. */
    dot?: boolean;
    size?: 'sm' | 'md';
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
    'aria-label'?: string;
}
/**
 * A small numeric badge for unread or attention counts on nav icons and tabs.
 * Solid tone fill with contrast text, pill-shaped so single digits stay
 * circular, tabular figures so the width does not jitter as the count changes.
 */
declare function CounterBadge({ count, max, tone, dot, size, skeleton, glass, className, 'aria-label': ariaLabel, ...rest }: CounterBadgeProps): react.JSX.Element | null;

type CalloutTone = (typeof calloutTones)[number];
interface CalloutProps extends Omit<ComponentProps<'div'>, 'title'> {
    tone?: CalloutTone;
    title?: ReactNode;
    icon?: ReactNode;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
    children?: ReactNode;
}
declare function Callout({ tone, title, icon, skeleton, glass, className, children, ...rest }: CalloutProps): react.JSX.Element;

interface CodeBlockProps extends Omit<ComponentProps<'div'>, 'children'> {
    /** The source text: the accessible content, what the copy button copies, and the plain fallback. */
    code: string;
    /**
     * A pre-highlighted rendering of `code`, e.g. syntax-highlighted markup from a
     * highlighter. The kit ships no highlighter itself, so an app passes the
     * highlighted nodes here; without them the plain `code` renders.
     */
    children?: ReactNode;
    /** Shown as a label in the header. */
    language?: string;
    /** Shown in the header. */
    filename?: string;
    showCopy?: boolean;
    /** Renders a line-number gutter down the left edge. */
    lineNumbers?: boolean;
    /** Drops the top border and top corners so the block docks beneath the element above it. */
    attached?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
}
declare function CodeBlock({ code, children, language, filename, showCopy, lineNumbers, attached, skeleton, glass, className, ...rest }: CodeBlockProps): react.JSX.Element;

type SegmentedBarTone = (typeof segmentedBarTones)[number];
type SegmentedBarSize = (typeof segmentedBarSizes)[number];
interface SegmentedBarSegment {
    value: number;
    tone?: SegmentedBarTone;
    label?: string;
}
interface SegmentedBarProps extends ComponentProps<'div'> {
    /** Slices sized by proportion of the total. Zero-value slices are omitted. */
    data: SegmentedBarSegment[];
    /** Bar thickness: sm 0.375rem, md 0.625rem. */
    size?: SegmentedBarSize;
    /** Round the bar ends with a full radius. */
    rounded?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Accessible name for the bar. Falls back to a generated breakdown. */
    'aria-label'?: string;
}
/**
 * A single proportional bar split into slices sized by share of the total.
 * Unlike Meter, which is discrete equal pips for a level, SegmentedBar shows a
 * continuous breakdown of parts, such as a storage or budget split.
 */
declare function SegmentedBar({ data, size, rounded, skeleton, className, 'aria-label': ariaLabel, ...rest }: SegmentedBarProps): react.JSX.Element;

type BannerTone = (typeof bannerTones)[number];
interface BannerProps extends ComponentProps<'div'> {
    tone?: BannerTone;
    /** Leading glyph, centered with the message. */
    icon?: ReactNode;
    /** Trailing slot, typically a Button or link. */
    action?: ReactNode;
    /** When set, renders a trailing close IconButton that calls this. */
    onDismiss?: () => void;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    children?: ReactNode;
}
declare function Banner({ tone, icon, action, onDismiss, skeleton, className, children, ...rest }: BannerProps): react.JSX.Element;

type AnnouncementTone = (typeof announcementTones)[number];
/** How the strip moves through its updates. */
type AnnouncementMotion = (typeof announcementMotions)[number];
interface AnnouncementItem {
    /** Stable identity for the update, used for the slide transition and indicator. */
    id: string;
    /** Optional short category shown before the update text. */
    label?: ReactNode;
    /** The announcement message. */
    content: ReactNode;
}
interface AnnouncementsProps extends Omit<ComponentProps<'section'>, 'children'> {
    /** Updates to rotate through. At least one item is required. */
    items: readonly AnnouncementItem[];
    /**
     * Fixed content pinned at the leading edge, before the viewport.
     *
     * Unlike an item's own `label`, this belongs to the STRIP rather than to any
     * one update, so it does not travel with them - it names what the strip is
     * ("New", "Status", "Live") and stays put while the news moves past it. A
     * Pill or Badge is the usual thing to put here.
     */
    tag?: ReactNode;
    /** Semantic color family for the strip. */
    tone?: AnnouncementTone;
    /**
     * `step` shows one update at a time and swaps them on the interval.
     * `marquee` scrolls the whole list past continuously, so every update is on
     * its way through rather than waiting its turn.
     */
    motion?: AnnouncementMotion;
    /** Controlled index of the current update. Step motion only. */
    index?: number;
    /** Initially visible update in uncontrolled use. Step motion only. */
    defaultIndex?: number;
    /** Called whenever a user action or auto-rotation selects a new update. */
    onIndexChange?: (index: number) => void;
    /**
     * Makes each update activatable - clicked, or reached by keyboard and
     * entered. Supply it when an update opens something: the fuller note, a
     * release page, a modal. Without it the strip is read-only text.
     */
    onItemSelect?: (item: AnnouncementItem, index: number) => void;
    /** Whether updates should move until the user pauses or interacts. */
    autoPlay?: boolean;
    /** Step motion: delay in milliseconds between automatic updates. */
    interval?: number;
    /**
     * Marquee motion: seconds each update takes to cross the strip. Travel time
     * is this times the number of updates, so adding an update lengthens the
     * loop rather than speeding every update up.
     */
    secondsPerItem?: number;
    /** Accessible name for the announcements region. */
    'aria-label'?: string;
}
/**
 * A compact application-chrome ticker for short updates. It either steps
 * through them one at a time or scrolls the whole list past continuously;
 * either way movement stops while the region is hovered or focused, and a
 * persistent pause control lets people hold an update still to read - or to
 * click, when the updates open something.
 */
declare function Announcements({ items, tag, tone, motion, index, defaultIndex, onIndexChange, onItemSelect, autoPlay, interval, secondsPerItem, className, style, 'aria-label': ariaLabel, onMouseEnter, onMouseLeave, onFocusCapture, onBlurCapture, ...rest }: AnnouncementsProps): react.JSX.Element | null;

interface EmptyStateProps extends Omit<ComponentProps<'div'>, 'title'> {
    /** Glyph rendered inside the leading disc. Decorative. */
    icon?: ReactNode;
    /** Heading naming what is empty or missing. */
    title: ReactNode;
    /** Muted supporting sentence, centered and width-capped. */
    description?: ReactNode;
    /** Call-to-action node, e.g. a Button, below the text. */
    action?: ReactNode;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    children?: ReactNode;
}
/**
 * A centered placeholder for an empty view. Stacks an optional icon disc, a
 * title, a muted description, and an action, all centered on both axes so it
 * reads as a calm, deliberate stop rather than a missing screen.
 */
declare function EmptyState({ icon, title, description, action, skeleton, className, children, ...rest }: EmptyStateProps): react.JSX.Element;

type StepsTone = (typeof stepsTones)[number];
type StepsSize = (typeof stepsSizes)[number];
type StepsVariant = (typeof stepsVariants)[number];
interface StepsProps extends Omit<ComponentProps<'div'>, 'children'> {
    /** Total number of steps; renders this many dots. */
    count: number;
    /** Zero-based index of the current step. Earlier dots read completed, later ones upcoming. */
    active?: number;
    /** Semantic color family for completed and current dots. */
    tone?: StepsTone;
    /** Compact size step; sets dot diameter and gap. */
    size?: StepsSize;
    /** dots is the compact dot row; connected joins circular markers with lines and checks. */
    variant?: StepsVariant;
    /** Numbers the connected markers from 1; completed markers keep the check. */
    numbered?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
}
/**
 * A row of progress dots marking position through a tour, wizard, or quiz.
 * Dots before the active index read as completed and fill solid in the tone;
 * the active dot is enlarged to mark the current step; later dots are hollow
 * with a hairline border. Position is announced by the group label, not color.
 */
declare function Steps({ count, active, tone, size, variant, numbered, skeleton, className, ...rest }: StepsProps): react.JSX.Element;

interface RadioCardProps extends Omit<ComponentProps<'input'>, 'type' | 'onChange' | 'checked' | 'defaultChecked' | 'title'> {
    /** The card heading, the primary label of the choice. */
    title: ReactNode;
    /** Secondary line under the title. */
    description?: ReactNode;
    /** Leading glyph or preview swatch above the title. */
    icon?: ReactNode;
    /** Controlled selected state. */
    checked?: boolean;
    /** Initial selected state when uncontrolled. */
    defaultChecked?: boolean;
    /** Called with the next checked state when the card is selected. */
    onCheckedChange?: (checked: boolean) => void;
    /** Extra content rendered below the description. */
    children?: ReactNode;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
}
/**
 * A selectable card with radio semantics: a preview tile that checks as one of
 * a group. Group cards with a shared `name` so the browser and assistive
 * technology treat them as a single radio set. Works controlled (`checked` +
 * `onCheckedChange`) or uncontrolled (`defaultChecked`).
 */
declare function RadioCard({ title, description, icon, checked, defaultChecked, onCheckedChange, disabled, skeleton, children, className, ...rest }: RadioCardProps): react.JSX.Element;

interface StatTileProps extends ComponentProps<'div'> {
    /** Optional leading glyph rendered in a muted disc. Decorative. */
    icon?: ReactNode;
    /** The prominent value - a number, currency, or short string. */
    value: ReactNode;
    /** The muted label naming what the value measures. */
    label: ReactNode;
    /** Optional trailing delta or hint, e.g. a change chip or timeframe. */
    hint?: ReactNode;
    /** Renders the frosted glass material instead of a solid card. */
    glass?: boolean;
    /**
     * Plate silhouette. 'rect' is the untouched default; the gamified plates put
     * a row of tiles in the forge-plate register and mirror under [dir='rtl'].
     */
    shape?: ShapeName;
    /** Paints the accent leading-edge stripe along the tile's inline-start edge. */
    edgeAccent?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
}
/**
 * A compact stat micro-card: an optional leading icon, a prominent value, and a
 * muted label, with an optional trailing delta or hint. Built on the card
 * surface tokens so a row or grid of tiles reads as one consistent panel.
 */
declare function StatTile({ icon, value, label, hint, glass, shape, edgeAccent, skeleton, className, ...rest }: StatTileProps): react.JSX.Element;

type DeviceFrameSize = (typeof deviceFrameSizes)[number];
interface DeviceFrameProps extends Omit<ComponentProps<'div'>, 'children'> {
    /** Preset screen width. Ignored when `width` is set. */
    size?: DeviceFrameSize;
    /** Explicit screen width, overriding `size`, e.g. `320` or `'20rem'`. */
    width?: string | number;
    /**
     * Screen aspect ratio as width / height. Defaults to a modern phone.
     * A number like `9 / 19.5`, or a CSS ratio string like `'9 / 19.5'`.
     */
    aspect?: string | number;
    /** Hides the decorative notch, for a full-bleed slab. */
    hideNotch?: boolean;
    /** Accessible label for the frame region. */
    'aria-label'?: string;
    /** The preview or iframe that fills the screen. */
    children?: ReactNode;
}
/**
 * A decorative phone bezel with a fixed-aspect, inset screen that hosts
 * arbitrary children - a live preview, a screenshot, or an iframe. The bezel,
 * notch, and side buttons are purely presentational and hidden from assistive
 * tech; only the screen contents carry meaning. Pick a preset `size` or set an
 * explicit `width`, and tune the screen shape with `aspect`.
 */
declare function DeviceFrame({ size, width, aspect, hideNotch, className, style, children, ...rest }: DeviceFrameProps): react.JSX.Element;

interface FilterChipProps extends Omit<ComponentProps<typeof motion.button>, 'children' | 'onChange'> {
    /** Controlled selected state. */
    selected?: boolean;
    /** Initial selected state when uncontrolled. */
    defaultSelected?: boolean;
    /** Called with the next selected state when the chip is toggled. */
    onSelectedChange?: (selected: boolean) => void;
    /** Leading glyph. */
    icon?: ReactNode;
    /** Trailing count, rendered as a CounterBadge; hidden when 0 or less. */
    count?: number;
    size?: 'sm' | 'md';
    children?: ReactNode;
}
/**
 * A toggleable filter pill (button, aria-pressed) for faceted filtering. The
 * selected state paints the accent soft tint like Toggle, with an optional
 * leading icon and an optional trailing count rendered as a CounterBadge.
 * Controlled selected + onSelectedChange, matching the kit's other toggles.
 */
declare function FilterChip({ selected, defaultSelected, onSelectedChange, icon, count, size, disabled, className, children, onClick, ...rest }: FilterChipProps): react.JSX.Element;

type ImageFit = 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
type ImageRadius = 'none' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
interface ImageProps extends Omit<ComponentProps<'img'>, 'width' | 'height' | 'style'> {
    src: string;
    /** Required for a11y; pass an empty string for a purely decorative image. */
    alt: string;
    /** Aspect ratio of the frame, e.g. `'2 / 3'` for a book cover or `1` for a square. */
    aspectRatio?: string | number;
    /** How the image fills its frame. */
    fit?: ImageFit;
    /** Corner radius, from the radius scale. */
    radius?: ImageRadius;
    /** Rendered when the image fails to load. Defaults to a muted broken-image glyph. */
    fallback?: ReactNode;
    /** Renders a placeholder with the frame's geometry. */
    skeleton?: boolean;
    className?: string;
    style?: CSSProperties;
}
/**
 * A framed image with a fixed aspect ratio: it holds its box while the source
 * loads (showing a skeleton), fits the image with `object-fit`, rounds the
 * corners, and swaps in a fallback if the source fails. Built for content
 * imagery like cover art, thumbnails, and hero shots.
 */
declare function Image({ src, alt, aspectRatio, fit, radius, fallback, skeleton, loading, className, style, ...rest }: ImageProps): react.JSX.Element;

interface RatingProps extends Omit<ComponentProps<'span'>, 'onChange' | 'defaultValue' | 'role' | 'children'> {
    /** Controlled rating value, 0 to `max`. */
    value?: number;
    /** Initial value when uncontrolled. */
    defaultValue?: number;
    /** Number of stars. */
    max?: number;
    onChange?: (value: number) => void;
    /** Display-only: renders the stars (with fractional fill) but no controls. */
    readOnly?: boolean;
    disabled?: boolean;
    size?: 'sm' | 'md' | 'lg';
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Accessible name for the rating group. */
    'aria-label'?: string;
    /** Set to "none" to opt this rating out of haptic feedback. */
    'data-haptic'?: string;
}
/**
 * A star rating. Interactive by default - a native radio group, so arrow keys
 * move between stars and the value participates in forms - or `readOnly` for a
 * display badge that supports fractional fill (e.g. a 4.3 average).
 */
declare function Rating({ value, defaultValue, max, onChange, readOnly, disabled, size, skeleton, className, 'aria-label': ariaLabel, ...rest }: RatingProps): react.JSX.Element;

type OtpFieldType = (typeof otpFieldTypes)[number];
interface OtpFieldProps extends Omit<ComponentProps<'div'>, 'onChange' | 'defaultValue' | 'children'> {
    /** Number of code characters. */
    length?: number;
    /** Controlled code value. */
    value?: string;
    /** Initial value when uncontrolled. */
    defaultValue?: string;
    /** Called with the sanitized code on every change. */
    onValueChange?: (value: string) => void;
    /** Called once with the full code when the last cell fills. */
    onComplete?: (value: string) => void;
    /** Which characters the code accepts. */
    type?: OtpFieldType;
    /** Renders dots instead of the entered characters. */
    masked?: boolean;
    /** Draws a separator dash after every N cells, e.g. 3 for a 123-456 code. */
    groupSize?: number;
    size?: 'sm' | 'md' | 'lg';
    disabled?: boolean;
    /** Paints the invalid treatment, matching Input's aria-invalid styling. */
    error?: boolean;
    autoFocus?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
    /** Renders placeholders with the component's exact geometry. */
    skeleton?: boolean;
    /** Accessible name for the code input; defaults to the localized "One-time code". */
    'aria-label'?: string;
}
/**
 * A one-time passcode entry. One real text input is stretched invisibly across
 * the visual cells, so typing, backspace, paste, and platform code autofill
 * (autocomplete="one-time-code") all behave natively while the cells render
 * each character with a blinking caret in the next empty cell. Codes read left
 * to right in every locale, so the row is pinned ltr.
 */
declare function OtpField({ length, value: valueProp, defaultValue, onValueChange, onComplete, type, masked, groupSize, size, disabled, error, autoFocus, glass, skeleton, className, 'aria-label': ariaLabel, ...rest }: OtpFieldProps): react.JSX.Element;

type SparklineShape = (typeof sparklineShapes)[number];
type SparklineTone = (typeof sparklineTones)[number];
interface SparklineProps extends ComponentProps<'span'> {
    /** The series, oldest first. The sparkline renders whatever slice it is given. */
    data: number[];
    /** Fixed lower bound of the value domain. Defaults to the data minimum. */
    min?: number;
    /** Fixed upper bound of the value domain. Defaults to the data maximum. */
    max?: number;
    /** Draws a dashed reference line at this value when it sits inside the domain. */
    baseline?: number;
    /** How the series is marked: a thin line, a line over a soft fill, or micro bars. */
    shape?: SparklineShape;
    /** Ink family for the mark. */
    tone?: SparklineTone;
    /** Height step; the width is fluid and follows the container. */
    size?: 'sm' | 'md' | 'lg';
    /** Marks the newest sample with an emphasis dot. */
    endPoint?: boolean;
    /** Mounts the mark on the frosted glass material: a rounded, blurred tile. */
    glass?: boolean;
    /** Renders a placeholder with the exact geometry. */
    skeleton?: boolean;
    /** Accessible name; describe the trend, not the pixels. */
    'aria-label': string;
}
/**
 * A word-sized trend graphic: a single series as a thin line, a soft-filled
 * area, or micro bars, for table cells, stat tiles, and dense monitoring rows.
 * It carries no axes or labels - the surrounding text does the naming - and it
 * is an impression, not a reading: pair it with a text value that carries the
 * actual figure. Pin min/max (e.g. 0-100 for percentages) so rows in a column
 * share one scale.
 */
declare function Sparkline({ data, min, max, baseline, shape, tone, size, endPoint, glass, skeleton, className, 'aria-label': ariaLabel, ...rest }: SparklineProps): react.JSX.Element;

interface FieldProps extends ComponentProps<'div'> {
    label?: ReactNode;
    hint?: ReactNode;
    /** When set, replaces the hint and shakes in. */
    error?: ReactNode;
    required?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    className?: string;
    children: ReactNode;
}
declare function Field({ label, hint, error, required, skeleton, className, children, ...rest }: FieldProps): react.JSX.Element;

/** Labels every control needs, so the card can be spoken in any language. */
interface PlayerCardLabels {
    play: string;
    pause: string;
    skipBack: string;
    skipForward: string;
    shuffle: string;
    /** Given the current mode, so the label can name it. */
    repeat: (mode: PlayerRepeat) => string;
    seek: string;
}
interface PlayerCardProps extends Omit<CardProps, 'children' | 'title' | 'defaultValue' | 'skeleton' | 'layout' | 'shape'> {
    /** Album art, placed and sized by the layout. */
    artwork?: ReactNode;
    /** How the card arranges what it holds. */
    layout?: PlayerLayout;
    /** How tightly it is packed. */
    density?: PlayerDensity;
    /** What is playing. */
    title?: ReactNode;
    /** A second line, usually the artist. */
    subtitle?: ReactNode;
    /** A third line naming the album or source. */
    album?: ReactNode;
    /** Track length in seconds. */
    duration: number;
    /** Controlled playhead position in seconds. */
    value?: number;
    defaultValue?: number;
    onValueChange?: (seconds: number) => void;
    onSeekEnd?: (seconds: number) => void;
    /** Controlled play state. */
    playing?: boolean;
    defaultPlaying?: boolean;
    onPlayingChange?: (playing: boolean) => void;
    /** Omit a skip handler and that control is not rendered. */
    onSkipBack?: () => void;
    onSkipForward?: () => void;
    /** Controlled shuffle. Omit both this and the handler to drop the control. */
    shuffle?: boolean;
    defaultShuffle?: boolean;
    onShuffleChange?: (on: boolean) => void;
    /** Controlled repeat mode. Omit both this and the handler to drop the control. */
    repeat?: PlayerRepeat;
    defaultRepeat?: PlayerRepeat;
    onRepeatChange?: (mode: PlayerRepeat) => void;
    /** Forwarded to the seek bar. */
    shape?: SeekBarProps['shape'];
    tone?: SeekBarProps['tone'];
    fill?: SeekBarProps['fill'];
    /**
     * How visible the unplayed run is. Defaults to `contrast`, because the card
     * is a raised surface and the muted rail vanishes against it.
     */
    rail?: SeekBarProps['rail'];
    levels?: number[];
    beat?: SeekBarProps['beat'];
    intensity?: SeekBarProps['intensity'];
    /**
     * Draws the seek bar's tracer, the shadow trailing the beat. On here, unlike
     * on a bare bar: a card is a now-playing surface, where the bar is the thing
     * being looked at rather than a rail under something else, and it has the
     * room to carry a second run. It costs a still card nothing either way -
     * without a `beat` there is nothing to trail, so nothing is drawn.
     */
    tracer?: SeekBarProps['tracer'];
    /** Formats the elapsed and total readouts. */
    formatTime?: (seconds: number) => string;
    /** Dims the card and blocks every control. */
    disabled?: boolean;
    /** Loads every part as its own placeholder, keeping the card's exact layout. */
    skeleton?: boolean;
    /** Overrides the control labels; merged over the English defaults. */
    labels?: Partial<PlayerCardLabels>;
}
/**
 * An audio transport in a card: what is playing, a seek bar with its elapsed and
 * total times, and the play, skip, shuffle, and repeat controls under it.
 *
 * Every piece of state is controllable or left to the card, and a control whose
 * handler is omitted is not rendered at all - so the same component covers a
 * bare play/pause strip and a full transport without a pile of `show*` flags.
 *
 * There is one tree, not a separate skeleton tree: `skeleton` is threaded into
 * each part, so a loading card holds the exact layout it will settle into.
 */
declare function PlayerCard({ artwork, layout, density, title, subtitle, album, duration, value, defaultValue, onValueChange, onSeekEnd, playing, defaultPlaying, onPlayingChange, onSkipBack, onSkipForward, shuffle, defaultShuffle, onShuffleChange, repeat, defaultRepeat, onRepeatChange, shape, tone, fill, rail, levels, beat, intensity, tracer, formatTime, disabled, skeleton, labels, className, style, ...rest }: PlayerCardProps): react.JSX.Element;

/** One synced line: when it starts, and what it says. */
interface LyricLine {
    /** Seconds from the top of the track. */
    time: number;
    text: string;
}
interface LyricsProps extends Omit<ComponentProps<'div'>, 'onSelect'> {
    /** The synced lines, in time order. Empty renders the empty message. */
    lines: readonly LyricLine[];
    /**
     * Playback position in seconds; the last line at or before it is active.
     * Omit for unsynced text - no line lights and nothing follows.
     */
    position?: number;
    /**
     * Called with the pressed line - seek the player to `line.time`. Without
     * it the lines render as plain text rather than buttons.
     */
    onLineSelect?: (line: LyricLine) => void;
    /** The empty message, replaceable for localization. */
    emptyLabel?: string;
}
/**
 * Time-synced lyrics: the song's timeline made legible. The active line is
 * lit and kept centred while playback moves; every line is a seek target when
 * the host can seek; and the moment the user takes the scroll, the follow
 * yields - a surface that fought the hand would be worse than one that never
 * followed at all.
 *
 * The component is deliberately stateless about time: the host owns playback
 * and hands in `position`, so the same component follows an `<audio>`, a
 * stream, or a test's bare number.
 */
declare function Lyrics({ lines, position, onLineSelect, emptyLabel, className, ...rest }: LyricsProps): react.JSX.Element;

type TrackInfoSize = (typeof trackInfoSizes)[number];
type TrackInfoAlign = (typeof trackInfoAligns)[number];
interface TrackInfoProps extends Omit<ComponentProps<'div'>, 'title'> {
    /** Album art. Held square by the block and sized by `size`. */
    artwork?: ReactNode;
    /** What is playing. */
    title?: ReactNode;
    /** A second line, usually the album. */
    subtitle?: ReactNode;
    /** A third line, usually the artist or source. */
    album?: ReactNode;
    /** The artwork footprint; the text sizes do not change with it. */
    size?: TrackInfoSize;
    /**
     * How the text column sits against the artwork. Centre reads right while the
     * art is the taller of the two; start once the lines run past it.
     */
    align?: TrackInfoAlign;
    /** Loads each line as its own placeholder at its own width. */
    skeleton?: boolean;
    /** Marks the title so a surrounding group can be labelled by it. */
    titleId?: string;
}
/**
 * What is playing, as one block: album art beside the title, album, and artist.
 *
 * Each line steps down in quietness, and the first two in size as well, so which
 * of the three is the track name is legible before a word of it is read - the
 * reason the block is a component at all rather than three `Text`s a caller
 * stacks themselves. The type sits a step below the page's, because the block is
 * chrome wherever it is used: what is playing, not what is being read.
 *
 * It is text, not a control: it takes no role, so whatever surface holds it
 * stays the thing a screen reader announces.
 */
declare function TrackInfo({ artwork, title, subtitle, album, size, align, skeleton, titleId, className, ...rest }: TrackInfoProps): react.JSX.Element;

type TransportEmphasis = (typeof transportEmphases)[number];
/** Labels every control needs, so the row can be spoken in any language. */
interface TransportControlsLabels {
    play: string;
    pause: string;
    stop: string;
    skipBack: string;
    skipForward: string;
    shuffle: string;
    /** Given the current mode, so the label can name it. */
    repeat: (mode: PlayerRepeat) => string;
    /** Names the row itself, since it is a group. */
    group: string;
}
interface TransportControlsProps extends Omit<ComponentProps<'div'>, 'onChange'> {
    /** Controlled play state. */
    playing?: boolean;
    defaultPlaying?: boolean;
    onPlayingChange?: (playing: boolean) => void;
    /** Omit a handler and that control is not rendered. */
    onStop?: () => void;
    onSkipBack?: () => void;
    onSkipForward?: () => void;
    /** Controlled shuffle. Omit both this and the handler to drop the control. */
    shuffle?: boolean;
    defaultShuffle?: boolean;
    onShuffleChange?: (on: boolean) => void;
    /** Controlled repeat mode. Omit both this and the handler to drop the control. */
    repeat?: PlayerRepeat;
    defaultRepeat?: PlayerRepeat;
    onRepeatChange?: (mode: PlayerRepeat) => void;
    /** How tightly the row is packed; the same scale a PlayerCard reads. */
    density?: PlayerDensity;
    /**
     * How loudly the play control is drawn. Solid fills it, which is right on a
     * surface that is about the player; quiet leaves it a bare glyph a step
     * larger than its neighbours, which is what a chrome strip wants - a filled
     * disc there would be the loudest thing on a bar that is not the subject.
     */
    emphasis?: TransportEmphasis;
    /** Dims the row and blocks every control. */
    disabled?: boolean;
    /** Loads each button as its own placeholder, so the row keeps its footprint. */
    skeleton?: boolean;
    /** Overrides the control labels; merged over the English defaults. */
    labels?: Partial<TransportControlsLabels>;
}
/**
 * The row of buttons that drives playback: shuffle, previous, stop,
 * play/pause, next, repeat - in the order every player puts them, so it needs
 * no explanation.
 *
 * A control appears when it can do something: either the row owns the state or
 * the caller is listening for it. That is what lets one component cover a bare
 * play button and a full six-button transport without a pile of `show*` flags.
 */
declare function TransportControls({ playing, defaultPlaying, onPlayingChange, onStop, onSkipBack, onSkipForward, shuffle, defaultShuffle, onShuffleChange, repeat, defaultRepeat, onRepeatChange, density, emphasis, disabled, skeleton, labels, className, style, ...rest }: TransportControlsProps): react.JSX.Element;

type VolumeReadout = (typeof volumeReadouts)[number];
type VolumeBarSize = (typeof volumeBarSizes)[number];
type VolumeBarOrientation = (typeof volumeBarOrientations)[number];
type VolumeBarLayout = (typeof volumeBarLayouts)[number];
/** Labels the control needs, so the fader can be spoken in any language. */
interface VolumeBarLabels {
    mute: string;
    unmute: string;
    volume: string;
}
interface VolumeBarProps extends Omit<ComponentProps<'div'>, 'onChange' | 'defaultValue'> {
    /** Controlled fader position, 0-100: 100 is unity, 0 is off. */
    value?: number;
    /** Initial position when uncontrolled. */
    defaultValue?: number;
    /**
     * Called with the 0-100 position as the fader moves. Pass it through
     * `volumeAmplitude` for the multiplier an audio element takes - the rail is
     * calibrated in decibels, so the number is not one.
     */
    onValueChange?: (volume: number) => void;
    /** Controlled mute state. */
    muted?: boolean;
    defaultMuted?: boolean;
    onMutedChange?: (muted: boolean) => void;
    /** What the trailing readout prints, if anything. */
    readout?: VolumeReadout;
    /** Steps the mute button and readout with the controls around them. */
    size?: VolumeBarSize;
    /**
     * Which way the rail runs. Vertical stands it up beside the mute toggle
     * rather than stacking the two, so the whole of the height it is given goes
     * to the travel. Its length is `--volume-length`, which defaults to the
     * horizontal rail's.
     */
    orientation?: VolumeBarOrientation;
    /**
     * Whether the rail sits on the surface or opens over the speaker button.
     * Popover buys back the width of a rail where there is none to spare, at the
     * price of a level that can no longer be read at a glance. The panel opens
     * above the button, since the surfaces short enough to need it are usually the
     * ones docked to the bottom of a window.
     *
     * The panel is not asked for: it opens while the pointer is on the speaker and
     * closes when it leaves, so the speaker stays the mute button it is in every
     * other layout. It carries the rail and the readout and nothing else - drawing
     * a second speaker a finger's width above the first would say there are two
     * controls where there is one.
     */
    layout?: VolumeBarLayout;
    /** Dims the row and blocks the fader and the mute toggle. */
    disabled?: boolean;
    /** Loads the button, rail, and readout as placeholders at their real sizes. */
    skeleton?: boolean;
    /** Overrides the labels; merged over the English defaults. */
    labels?: Partial<VolumeBarLabels>;
}
/**
 * A fader with a mute toggle on its leading edge and a level readout on its
 * trailing edge.
 *
 * The rail is linear in decibels rather than in amplitude, because decibels are
 * what the ear is linear in: the same nudge of the thumb does the same thing at
 * either end of the travel, and the readout is a number that means something
 * rather than a percentage of nothing in particular.
 *
 * Muting and pulling the fader down are kept apart on purpose. They sound the
 * same and they are not the same: mute is undoable and remembers the level it
 * was set to, and only one of the two survives being pressed by accident.
 */
declare function VolumeBar({ value, defaultValue, onValueChange, muted, defaultMuted, onMutedChange, readout, size, orientation, layout, disabled, skeleton, labels, className, ...rest }: VolumeBarProps): react.JSX.Element;

interface FieldsetProps extends ComponentProps<'fieldset'> {
    /** The group label, rendered as a native legend. */
    legend: ReactNode;
    /** Muted supporting line under the legend, announced with the group via aria-describedby. */
    description?: ReactNode;
    /** Right-aligned actions on the legend row. */
    actions?: ReactNode;
    /**
     * The NATIVE fieldset disabled attribute: the browser disables every nested
     * form control for free, with no per-control wiring.
     */
    disabled?: boolean;
    /** Draws the classic hairline box with the legend floating on the border. */
    bordered?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    children?: ReactNode;
}
/**
 * A styled NATIVE fieldset. Using the real element is the whole point: the
 * legend names the group for assistive tech, and the native disabled attribute
 * cascades to every nested control without touching each one.
 */
declare function Fieldset({ legend, description, actions, disabled, bordered, skeleton, className, children, 'aria-describedby': ariaDescribedBy, ...rest }: FieldsetProps): react.JSX.Element;

interface FormSectionProps extends Omit<ComponentProps<'section'>, 'title'> {
    /** The section title, rendered as a Heading that labels the section. */
    title: ReactNode;
    /** Semantic heading level for the title. */
    level?: 1 | 2 | 3 | 4 | 5 | 6;
    /** Muted supporting line under the title. */
    description?: ReactNode;
    /** Right-aligned actions on the title row. */
    actions?: ReactNode;
    /** Draws a hairline divider above the section, for stacking sections. */
    divider?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    children?: ReactNode;
}
/**
 * A page-level grouping for settings and long forms: a titled, labelled
 * region whose content is often one or more Fieldsets.
 */
declare function FormSection({ title, level, description, actions, divider, skeleton, className, children, ...rest }: FormSectionProps): react.JSX.Element;

type CalendarMode = 'single' | 'range';
/** A possibly half-open date range, as reported while a range is being picked. */
interface CalendarRange {
    from?: Date;
    to?: Date;
}
interface CalendarProps extends Omit<ComponentProps<'div'>, 'defaultValue' | 'onSelect'> {
    /** Pick one date (default) or a from/to range. */
    mode?: CalendarMode;
    /** Controlled selected date, in single mode. */
    value?: Date;
    /** Uncontrolled initial date, in single mode. */
    defaultValue?: Date;
    /** Called with the next date, or undefined when the selected day is unpicked. */
    onValueChange?: (value: Date | undefined) => void;
    /** Controlled selected range, in range mode. */
    rangeValue?: CalendarRange;
    /** Uncontrolled initial range, in range mode. */
    defaultRangeValue?: CalendarRange;
    /** Called with the next range; from is set first, then to. */
    onRangeChange?: (range: CalendarRange) => void;
    /** Earliest selectable date; navigation stops at its month. */
    min?: Date;
    /** Latest selectable date; navigation stops at its month. */
    max?: Date;
    /** Marks matching dates disabled and unselectable. */
    disabledDates?: (date: Date) => boolean;
    /** Disables every day and the month navigation. */
    disabled?: boolean;
    /** Overrides the date-fns locale derived from the kit locale. */
    dateFnsLocale?: DayPickerLocale;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Drops the card chrome, for hosts that already frame the grid (DatePicker's panel). */
    bare?: boolean;
    'aria-label'?: string;
    className?: string;
}
/**
 * An inline month grid for picking a single date or a date range. All date
 * math, keyboard navigation (arrows, PageUp/PageDown, Home/End), and grid ARIA
 * come from react-day-picker; every visible surface is restyled with kit
 * tokens through its classNames prop. Month and weekday names follow the kit
 * locale, overridable per instance with dateFnsLocale.
 */
declare function Calendar({ mode, value, defaultValue, onValueChange, rangeValue, defaultRangeValue, onRangeChange, min, max, disabledDates, disabled, dateFnsLocale, skeleton, bare, className, 'aria-label': ariaLabel, ...rest }: CalendarProps): react.JSX.Element;

interface DatePickerProps extends Omit<ComponentProps<'div'>, 'defaultValue'> {
    /** Controlled selected date. */
    value?: Date;
    /** Uncontrolled initial date. */
    defaultValue?: Date;
    /** Called with the next date, or undefined when the selected day is unpicked. */
    onValueChange?: (value: Date | undefined) => void;
    /** Hint shown while no date is selected; defaults to the localized prompt. */
    placeholder?: string;
    size?: ControlSize;
    fullWidth?: boolean;
    disabled?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material on the trigger instead of a solid surface. */
    glass?: boolean;
    /** Earliest selectable date. */
    min?: Date;
    /** Latest selectable date. */
    max?: Date;
    /** Marks matching dates disabled and unselectable. */
    disabledDates?: (date: Date) => boolean;
    /** Overrides the date-fns locale derived from the kit locale. */
    dateFnsLocale?: DayPickerLocale;
    /** Submitted with forms via a hidden input (ISO yyyy-MM-dd) when set. */
    name?: string;
    id?: string;
    'aria-label'?: string;
    className?: string;
}
/**
 * A single-date picker: an Input-metric trigger that opens a portaled Calendar
 * in an anchored glass panel. The panel flips and clamps through the shared
 * anchored-position engine, tracks scroll, and dismisses on Escape or an
 * outside press, restoring focus to the trigger. The value renders through
 * Intl.DateTimeFormat in the kit locale; when name is set an ISO yyyy-MM-dd
 * hidden input submits with native forms. Ranges are deliberately not picked
 * from this popover - use an inline Calendar in range mode, where both
 * endpoints stay visible while the range is chosen.
 */
declare function DatePicker({ value, defaultValue, onValueChange, placeholder, size, fullWidth, disabled, skeleton, glass, min, max, disabledDates, dateFnsLocale, name, id, className, 'aria-label': ariaLabel, ...rest }: DatePickerProps): react.JSX.Element;

/** Why one file was refused: it failed the accept filter, the size cap, or the count cap. */
type FileUploadRejectionReason = 'type' | 'size' | 'count';
interface FileUploadRejection {
    file: File;
    reason: FileUploadRejectionReason;
}
interface FileUploadProps extends Omit<ComponentProps<'div'>, 'defaultValue' | 'onChange'> {
    /** Native accept string (`.pdf,image/*`); also enforced in JS on drop. */
    accept?: string;
    /** Per-file size cap in bytes; larger files are rejected with reason `size`. */
    maxSize?: number;
    /** Total file cap; files past it are rejected with reason `count`. */
    maxFiles?: number;
    /** Allows picking and keeping more than one file. A single-file zone replaces its selection. */
    multiple?: boolean;
    disabled?: boolean;
    /** Submitted with forms through the real file input when set. */
    name?: string;
    /** Controlled selected files. */
    value?: File[];
    /** Uncontrolled initial files. */
    defaultValue?: File[];
    /** Called with the next file list after files are added or removed. */
    onFilesChange?: (files: File[]) => void;
    /** Called with every refused file and why; rejected files never enter the list. */
    onReject?: (rejections: FileUploadRejection[]) => void;
    /** Primary line override; defaults to the localized kit string. */
    label?: string;
    /** Supporting line override; defaults to the localized kit string. */
    hint?: string;
    /** Renders a placeholder with the dropzone geometry. */
    skeleton?: boolean;
    /** Uses the frosted glass material for the dropzone surface. */
    glass?: boolean;
    /** Id for the native file input; falls back to the surrounding Field id. */
    id?: string;
    'aria-label'?: string;
}
/**
 * A dropzone that chooses, validates, lists, and removes files - and nothing
 * more: it has no transport policy and never uploads anything. A visually
 * hidden native file input inside the zone carries keyboard access, the
 * screen-reader name, and form participation via `name`; drag-and-drop is a
 * progressive enhancement over it. Files failing `accept`, `maxSize`, or
 * `maxFiles` go to `onReject` and never enter the list.
 */
declare function FileUpload({ accept, maxSize, maxFiles, multiple, disabled, name, value, defaultValue, onFilesChange, onReject, label, hint, skeleton, glass, id, className, 'aria-label': ariaLabel, ...rest }: FileUploadProps): react.JSX.Element;

/**
 * Shared between the Field molecule (provider) and form-control atoms
 * (consumers), so atoms never import upward from molecules.
 */
interface FieldContextValue {
    id: string;
    describedBy: string | undefined;
    invalid: boolean;
}
/** Form controls read their id / aria wiring from the surrounding Field, if any. */
declare const useField: () => FieldContextValue | null;

type PhysicalSide = 'top' | 'bottom' | 'left' | 'right';
/**
 * Writing-direction relative sides: 'inline-end' resolves to 'right' in LTR
 * and 'left' in RTL (and 'inline-start' the opposite). Use these for surfaces
 * that should lead in the reading direction - e.g. submenu flyouts - and the
 * physical 'left'/'right' for surfaces that must stay put regardless of
 * direction. Resolution happens at measure time, so a live dir flip is picked
 * up on the next update.
 */
type Side = PhysicalSide | 'inline-start' | 'inline-end';
type Alignment = 'start' | 'center' | 'end';
type Placement = Side | `${Side}-${Alignment}`;

interface MenuProps {
    /** The element that toggles the menu. Its ref and click are wired up. */
    trigger: ReactElement;
    /** Where to place the menu relative to the trigger. */
    placement?: Placement;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Accessible label for the menu. */
    'aria-label'?: string;
    className?: string;
    children?: ReactNode;
}
/**
 * A dropdown list of actions anchored to a trigger. Built on the same anchored
 * overlay as Popover - it portals to the body, flips and clamps on screen, and
 * closes on outside press or Escape - but with menu semantics: a role="menu"
 * panel of role="menuitem" rows, arrow-key roving focus, and select-to-close.
 */
declare function Menu({ trigger, placement, open, defaultOpen, onOpenChange, className, children, ...rest }: MenuProps): react.JSX.Element;
interface ContextMenuProps extends Omit<ComponentProps<'div'>, 'content'> {
    /** The menu content - MenuItem, MenuSub, MenuSeparator, MenuLabel rows. */
    content: ReactNode;
    onOpenChange?: (open: boolean) => void;
    /** Accessible label for the menu panel. */
    'aria-label'?: string;
    /** Class for the portalled menu panel; className styles the target wrapper. */
    menuClassName?: string;
}
/**
 * A menu summoned at the pointer instead of a trigger. Wrap any content: a
 * right-click (contextmenu) or a touch long-press opens the same glass panel
 * Menu uses, anchored to the pointer coordinates via a zero-size virtual
 * anchor. Dismisses on Escape, outside press, or scrolling away; focus moves
 * into the panel on open and is restored on close.
 */
declare function ContextMenu({ content, onOpenChange, menuClassName, className, children, onContextMenu, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, 'aria-label': ariaLabel, ...rest }: ContextMenuProps): react.JSX.Element;
interface MenuSubProps extends ComponentProps<'button'> {
    /** The row's label. */
    label: ReactNode;
    /** Leading glyph. */
    icon?: ReactNode;
    /** Dims the row and keeps the flyout shut. */
    disabled?: boolean;
    /** Class for the flyout panel; className styles the row. */
    menuClassName?: string;
    /** The flyout content - MenuItem rows, separators, or deeper MenuSubs. */
    children?: ReactNode;
}
/**
 * A flyout submenu row inside a Menu or ContextMenu. Renders like a MenuItem
 * with a trailing chevron; its child panel opens toward inline-end of the row
 * (right in LTR, left in RTL, flipping at the viewport edge) on hover with an
 * intent delay, or on the arrow key pointing into it - ArrowRight in LTR,
 * ArrowLeft in RTL per the APG - or Enter, which focuses the first child item.
 * The opposite arrow closes the flyout and returns focus to the row; Escape
 * closes the whole stack. Nests.
 */
declare function MenuSub({ label, icon, disabled, menuClassName, className, children, onClick, onKeyDown, onPointerEnter, onPointerLeave, ...rest }: MenuSubProps): react.JSX.Element;
interface MenuItemProps extends Omit<ComponentProps<'button'>, 'onSelect'> {
    /** Leading glyph. */
    icon?: ReactNode;
    /** Trailing shortcut hint, e.g. a Kbd or "⌘C". */
    shortcut?: ReactNode;
    /** Paints the row in the danger tone. */
    danger?: boolean;
    /** Called when the item is chosen; the menu then closes. */
    onSelect?: () => void;
}
/** A single action row inside a Menu. */
declare function MenuItem({ icon, shortcut, danger, onSelect, disabled, className, children, onClick, ...rest }: MenuItemProps): react.JSX.Element;
/** A divider between groups of items. */
declare function MenuSeparator({ className }: {
    className?: string;
}): react.JSX.Element;
/** A non-interactive section heading inside a Menu. */
declare function MenuLabel({ className, children }: {
    className?: string;
    children?: ReactNode;
}): react.JSX.Element;

interface SplitButtonProps extends Omit<ComponentProps<'span'>, 'children'> {
    /** Main-action label/content. */
    children: ReactNode;
    /** Fired by the main (start) segment. */
    onAction: () => void;
    /** MenuItem children for the built-in dropdown (end) segment. */
    menu: ReactNode;
    /** Accessible name for the dropdown segment. */
    menuLabel: string;
    variant?: ButtonVariant;
    size?: ControlSize;
    disabled?: boolean;
    loading?: boolean;
    fullWidth?: boolean;
    placement?: ComponentProps<typeof Menu>['placement'];
    className?: string;
}
/**
 * A button with a built-in secondary control: the start segment fires the
 * primary action, the end segment opens an attached menu of related actions.
 * Both segments are real Buttons, so every variant/size/token of the Button
 * contract applies unchanged; the pair reads as one control.
 */
declare function SplitButton({ children, onAction, menu, menuLabel, variant, size, disabled, loading, fullWidth, placement, className, ...rest }: SplitButtonProps): react.JSX.Element;

/** Step numbers: 1 unit = 4px at the min viewport, 5px at the max. */
declare const SPACE_STEPS: readonly [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];
type SpaceStep = (typeof SPACE_STEPS)[number];

/**
 * Density modes, switched by data-density on any ancestor (usually <html>).
 *
 * Two things move together: control heights, and a density scale that
 * multiplies the whole space scale. So every padding and gap built on
 * --glacier-space-* breathes with density while staying on one shared scale.
 *
 * Comfortable remains the default for backwards compatibility. The other
 * modes provide two tighter and two roomier stops around that baseline.
 */
type Density = 'extra-compact' | 'compact' | 'comfortable' | 'spacious' | 'more-space';

/**
 * @glacier/motion - the kit's micro-animation vocabulary as enums, backed by
 * framer-motion (the `motion` package) and the @glacier/tokens motion tokens.
 *
 * Usage:
 *   import { motion } from 'motion/react';
 *   import { Motion, Speed, Ease, motionProps } from '@glacier/motion';
 *
 *   <motion.div {...motionProps(Motion.ScaleIn, Speed.Fast)} />
 */

/** Physics spring presets for interruptible motion (thumbs, layout moves). */
declare enum Spring {
    Snappy = "snappy",
    Smooth = "smooth",
    Bouncy = "bouncy"
}

interface SegmentedOption {
    value: string;
    label: ReactNode;
    disabled?: boolean;
}
interface SegmentedControlProps extends ComponentProps<'div'> {
    options: SegmentedOption[];
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    size?: ControlSize;
    fullWidth?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Spring preset for the thumb. Defaults to Spring.Snappy. */
    spring?: Spring;
    disabled?: boolean;
    /** Accessible name for the group. */
    'aria-label'?: string;
    className?: string;
}
/**
 * A segmented toggle. The selected
 * thumb is a shared framer-motion layout element, so it springs between
 * segments instead of jumping. Arrow keys move the selection (native radio
 * behavior), and the thumb follows.
 */
declare function SegmentedControl({ options, value, defaultValue, onValueChange, size, fullWidth, skeleton, spring, disabled, className, 'aria-label': ariaLabel, ...rest }: SegmentedControlProps): react.JSX.Element;

declare const densityModes: readonly ["extra-compact", "compact", "comfortable", "spacious", "more-space"];
type DensityMode = Density;
interface DensitySelectorProps extends Omit<ComponentProps<'div'>, 'children' | 'onChange'> {
    /** The active density token value. */
    value: DensityMode;
    /** Called when a density card is selected. */
    onValueChange: (value: DensityMode) => void;
    /** Optional label overrides keyed by density value. */
    labels?: Partial<Record<DensityMode, ReactNode>>;
    /** Disables every density option. */
    disabled?: boolean;
    /** Accessible name for the radio group. */
    'aria-label': string;
}
/** A scroll-safe visual density picker with radio-card keyboard interactions. */
declare function DensitySelector({ value, onValueChange, labels, disabled, className, 'aria-label': ariaLabel, ...rest }: DensitySelectorProps): react.JSX.Element;

type AudioEqualizerSize = (typeof controlSizes)[number];
interface AudioEqualizerBand {
    id: string;
    /** Visible label for the band, usually a frequency like 1kHz. */
    label: string;
}
interface AudioEqualizerPreset {
    id: string;
    label: string;
    /** Per-band gain values in dB, one value per rendered band. */
    gains: readonly number[];
}
interface AudioEqualizerLabels {
    equalizer: string;
    presets: string;
    reset: string;
    gainUnit: string;
    band: string;
}
interface AudioEqualizerProps extends Omit<ComponentProps<'div'>, 'onChange' | 'defaultValue'> {
    /** Controlled per-band gain values in decibels. */
    value?: readonly number[];
    /** Initial gains when uncontrolled; missing entries default to 0dB. */
    defaultValue?: readonly number[];
    /** Called whenever any band gain changes. */
    onValueChange?: (gains: number[]) => void;
    /** Frequency bands, in visual order from low to high. */
    bands?: readonly AudioEqualizerBand[];
    /** Presets shown above the bands. */
    presets?: readonly AudioEqualizerPreset[];
    /** Controlled selected preset id. */
    preset?: string;
    /** Initial selected preset when uncontrolled. */
    defaultPreset?: string;
    /** Called when the preset selection changes. */
    onPresetChange?: (presetId: string | undefined) => void;
    /** Lowest gain per band, in dB. */
    min?: number;
    /** Highest gain per band, in dB. */
    max?: number;
    /** Gain step in dB. */
    step?: number;
    /** Layout density for slider travel and labels. */
    size?: AudioEqualizerSize;
    /** Dims the control and blocks interaction. */
    disabled?: boolean;
    /** Hides the presets row while keeping band controls. */
    hidePresets?: boolean;
    /** Label overrides for localization. */
    labels?: Partial<AudioEqualizerLabels>;
}
/**
 * Multi-band equalizer with optional presets. Each band is a vertical slider in
 * decibels so gain edits are symmetric around 0dB and easy to compare.
 *
 * The curve above the sliders is the same gains read a second way, and it is
 * draggable: a node can be pulled up or down to set its band directly, which is
 * how a curve is shaped when the shape - rather than any one number - is what
 * you are after. It is a pointer affordance only, and stays out of the
 * accessibility tree: every band it edits is a real slider a few pixels below,
 * already keyboard-operable and already announced, so exposing the nodes as
 * well would put each band in the tab order twice to say the same thing.
 */
declare function AudioEqualizer({ value, defaultValue, onValueChange, bands, presets, preset, defaultPreset, onPresetChange, min, max, step, size, disabled, hidePresets, labels, className, style, ...rest }: AudioEqualizerProps): react.JSX.Element;

/** Which axis the content overflows and scrolls along. */
type ScrollAreaOrientation = 'vertical' | 'horizontal';
type ScrollbarAppearanceName = (typeof scrollbarAppearances)[number];
interface ScrollAreaProps extends Omit<ComponentProps<'div'>, 'children'> {
    /**
     * Caps the viewport along the scroll axis: a CSS length or number of pixels.
     * For a vertical area this is a max-height; for a horizontal one, a max-width.
     */
    maxHeight?: number | string;
    /** Scroll axis. Vertical (the default) shows top/bottom fades; horizontal shows left/right. */
    orientation?: ScrollAreaOrientation;
    /** Visual treatment for the visible scrollbar. */
    scrollbarAppearance?: ScrollbarAppearanceName;
    /** Shows the half-opaque track behind the scrollbar thumb. */
    showScrollbarTrack?: boolean;
    /** Hides the scrollbar entirely; wheel, drag, keyboard, and touch scrolling all still work. */
    hideScrollbar?: boolean;
    /** The overflowing content. */
    children?: ReactNode;
}
/**
 * A styled overflow container. It caps its viewport along one axis, paints a
 * thin themed scrollbar, and fades the content at each edge only when there is
 * more to scroll in that direction. A scroll listener plus a ResizeObserver
 * keep the fade masks in sync as the content or viewport changes, so the top
 * fade appears once you scroll down and the bottom fade disappears at the end.
 * The viewport itself is focusable and keyboard-scrollable.
 */
declare function ScrollArea({ maxHeight, orientation, scrollbarAppearance, showScrollbarTrack, hideScrollbar, className, style, children, ...rest }: ScrollAreaProps): react.JSX.Element;

interface CarouselProps extends ComponentProps<'div'> {
    /** The card children laid out in a horizontal snap-scroll strip. */
    children?: ReactNode;
    /** Shows prev/next controls that appear when the strip overflows. */
    showControls?: boolean;
    /**
     * Advance to the next page every this-many milliseconds, looping back to the
     * start at the end. Off when unset. Pauses while the pointer is over the strip
     * or focus is inside it, and never runs under prefers-reduced-motion.
     */
    autoPlay?: number;
    /** Space between cards; any CSS length or a `var(--glacier-space-*)`. */
    gap?: string;
    /** Accessible label for the scrollable region. */
    'aria-label'?: string;
    className?: string;
}
/**
 * A horizontal snap-scroll strip that hosts arbitrary card children. It uses
 * CSS scroll-snap for tidy per-card stops, converts vertical wheel gestures to
 * horizontal scroll, and - when `showControls` is set - renders prev/next
 * IconButtons that appear only while the strip overflows, disabling at each end.
 */
declare function Carousel({ children, showControls, autoPlay, gap, className, style, 'aria-label': ariaLabel, ...rest }: CarouselProps): react.JSX.Element;

interface ComboboxOption {
    /** Unique submitted value. */
    value: string;
    /** Content rendered in the input and result row. */
    label: ReactNode;
    /** Plain-text filtering value when label is not a string. */
    textValue?: string;
    /** Optional muted supporting content below the label. */
    description?: ReactNode;
    disabled?: boolean;
}
interface ComboboxProps extends Omit<ComponentProps<'div'>, 'onChange'> {
    options: ComboboxOption[];
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    inputValue?: string;
    defaultInputValue?: string;
    onInputValueChange?: (value: string) => void;
    filter?: (option: ComboboxOption, inputValue: string) => boolean;
    placeholder?: string;
    emptyState?: ReactNode;
    loading?: boolean;
    size?: ControlSize;
    fullWidth?: boolean;
    disabled?: boolean;
    skeleton?: boolean;
    glass?: boolean;
    name?: string;
    id?: string;
    'aria-label'?: string;
    className?: string;
}
/**
 * An editable combobox with a portaled listbox. It keeps focus on the native
 * input and exposes the active option through aria-activedescendant, so normal
 * text editing and list navigation remain available together.
 */
declare function Combobox({ options, value, defaultValue, onValueChange, inputValue, defaultInputValue, onInputValueChange, filter, placeholder, emptyState, loading, size, fullWidth, disabled, skeleton, glass, name, id, className, 'aria-label': ariaLabel, ...rest }: ComboboxProps): react.JSX.Element;

interface MultiSelectOption {
    /** Unique submitted value. */
    value: string;
    /** Content rendered in a tag and option row. */
    label: ReactNode;
    /** Plain-text filtering value when label is not a string. */
    textValue?: string;
    /** Optional muted supporting content below the label. */
    description?: ReactNode;
    disabled?: boolean;
}
interface MultiSelectProps extends Omit<ComponentProps<'div'>, 'onChange'> {
    options: MultiSelectOption[];
    value?: string[];
    defaultValue?: string[];
    onValueChange?: (value: string[]) => void;
    inputValue?: string;
    defaultInputValue?: string;
    onInputValueChange?: (value: string) => void;
    filter?: (option: MultiSelectOption, inputValue: string) => boolean;
    placeholder?: string;
    emptyState?: ReactNode;
    loading?: boolean;
    size?: ControlSize;
    fullWidth?: boolean;
    disabled?: boolean;
    skeleton?: boolean;
    glass?: boolean;
    /** Renders one hidden form input per selected value when set. */
    name?: string;
    id?: string;
    'aria-label'?: string;
    className?: string;
}
/**
 * An editable multi-value combobox. It keeps focus on the native input,
 * exposes active suggestions with aria-activedescendant, and submits repeated
 * hidden form inputs so a normal form can retain each selected value.
 */
declare function MultiSelect({ options, value, defaultValue, onValueChange, inputValue, defaultInputValue, onInputValueChange, filter, placeholder, emptyState, loading, size, fullWidth, disabled, skeleton, glass, name, id, className, 'aria-label': ariaLabel, ...rest }: MultiSelectProps): react.JSX.Element;

type ListSize = 'sm' | 'md';
interface ListProps extends ComponentProps<'ul'> {
    size?: ListSize;
    /** Draws separators between direct ListItem children. */
    divided?: boolean;
}
interface ListItemProps extends Omit<ComponentProps<'li'>, 'onClick' | 'title'> {
    title: ReactNode;
    description?: ReactNode;
    leading?: ReactNode;
    trailing?: ReactNode;
    selected?: boolean;
    disabled?: boolean;
    href?: string;
    onClick?: MouseEventHandler<HTMLButtonElement>;
}
/** A semantic list container that gives direct ListItem children shared row metrics. */
declare function List({ size, divided, className, ...rest }: ListProps): react.JSX.Element;
/** A semantic list row with optional leading, supporting, and trailing content. */
declare function ListItem({ title, description, leading, trailing, selected, disabled, href, onClick, className, ...rest }: ListItemProps): react.JSX.Element;

/** A single dated value, e.g. one day of contribution counts. */
interface HeatmapPoint {
    /** ISO-ish date or any string key; surfaced in the cell title. */
    date: string;
    /** The magnitude for this cell. */
    value: number;
}
/**
 * The grid data: a 2D array of numbers (rows of values), or a flat list of
 * `{ date, value }` points laid out left-to-right, top-to-bottom into columns.
 */
type HeatmapData = number[][] | HeatmapPoint[];
interface HeatmapProps extends ComponentProps<'div'> {
    /** Values to plot: a 2D `number[][]` grid or a flat `{ date, value }[]` list. */
    data: HeatmapData;
    /** Number of intensity steps (including the empty step 0). Defaults to 5. */
    levels?: number;
    /** Show a less→more legend under the grid. Defaults to false. */
    legend?: boolean;
    /** Cells per column when `data` is a flat list. Defaults to 7 (a week). */
    rows?: number;
    /** Renders a placeholder grid of square skeletons with the exact geometry. */
    skeleton?: boolean;
    /** Columns the skeleton grid renders while there is no data. Rows follow `rows`. */
    skeletonColumns?: number;
    /** Accessible name for the grid. */
    'aria-label'?: string;
    className?: string;
}
/**
 * A GitHub-contribution-style intensity grid. Values - a 2D array or a flat
 * list of `{ date, value }` - are bucketed onto an accent ramp: level 0 reads
 * as an empty track, higher levels step up in accent saturation. Each cell
 * carries a title so its value is legible to pointer and screen-reader users,
 * and an optional legend spells out the less→more scale.
 */
declare function Heatmap({ data, levels, legend, rows, skeleton, skeletonColumns, className, 'aria-label': label, ...rest }: HeatmapProps): react.JSX.Element;
declare namespace Heatmap {
    var displayName: string;
}

interface BreadcrumbItem {
    label: ReactNode;
    href?: string;
    current?: boolean;
}
interface BreadcrumbsProps extends Omit<ComponentProps<'nav'>, 'children'> {
    items: BreadcrumbItem[];
    separator?: ReactNode;
}
declare function Breadcrumbs({ items, separator, className, ...rest }: BreadcrumbsProps): react.JSX.Element;

interface PaginationProps extends Omit<ComponentProps<'nav'>, 'children'> {
    page: number;
    total: number;
    pageSize?: number;
    onPageChange: (page: number) => void;
    siblingCount?: number;
    boundaryCount?: number;
}
declare function Pagination({ page, total, pageSize, onPageChange, siblingCount, boundaryCount, className, ...rest }: PaginationProps): react.JSX.Element;

interface AccordionItem {
    id: string;
    title: ReactNode;
    content: ReactNode;
    disabled?: boolean;
}
interface AccordionProps extends Omit<ComponentProps<'div'>, 'children'> {
    items: AccordionItem[];
    defaultOpen?: string | string[];
    allowMultiple?: boolean;
}
declare function Accordion({ items, defaultOpen, allowMultiple, className, ...rest }: AccordionProps): react.JSX.Element;

interface SpotlightProps {
    /** Whether the tour step is shown. */
    open: boolean;
    /** The element to highlight; the cutout and callout are positioned against it. */
    targetRef: RefObject<HTMLElement | null>;
    /** Step heading. */
    title?: ReactNode;
    /** Step body copy. */
    description?: ReactNode;
    /** Where to place the callout relative to the target before flipping and clamping. */
    placement?: Placement;
    /** Padding around the target inside the cutout, in pixels. */
    cutoutPadding?: number;
    /** 1-based index of this step. */
    step?: number;
    /** Total number of steps in the tour. */
    total?: number;
    /** Advances to the next step; the Next button is hidden when omitted. */
    onNext?: () => void;
    /** Returns to the previous step; the Back button is hidden when omitted. */
    onBack?: () => void;
    /** Dismisses the tour, via the close button, Escape, or a backdrop press. */
    onClose: () => void;
    className?: string;
}
/**
 * A guided-tour step. A dimmed, full-screen backdrop with a highlighted cutout
 * punched around a target element, plus a callout - anchored to the target with
 * the shared overlay engine - carrying a title, body, step count, and
 * Back / Next / Close controls. The callout is a role="dialog" that traps focus,
 * closes on Escape or a backdrop press, and tracks the target on scroll and
 * resize so the cutout stays glued to it.
 */
declare function Spotlight({ open, targetRef, title, description, placement, cutoutPadding, step, total, onNext, onBack, onClose, className, }: SpotlightProps): react.ReactPortal | null;

interface SelectOption {
    value: string;
    label: ReactNode;
    disabled?: boolean;
}
interface SelectProps extends ComponentProps<'div'> {
    options: SelectOption[];
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    placeholder?: string;
    size?: ControlSize;
    fullWidth?: boolean;
    disabled?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Renders the frosted glass material on the trigger instead of a solid surface. */
    glass?: boolean;
    /** Submitted with forms via a hidden input when set. */
    name?: string;
    id?: string;
    'aria-label'?: string;
    className?: string;
}
/**
 * A styled replacement for the native select: an Input-metric trigger and a
 * glass listbox that animates open. The menu portals to document.body with
 * fixed positioning, so it escapes overflow-clipping ancestors and stacking
 * contexts (glass panels, modals, scroll areas). Follows the WAI-ARIA listbox
 * pattern with aria-activedescendant; arrow keys navigate, Enter selects,
 * Escape closes.
 */
declare function Select({ options, value, defaultValue, onValueChange, placeholder, size, fullWidth, disabled, skeleton, glass, name, id, className, 'aria-label': ariaLabel, ...rest }: SelectProps): react.JSX.Element;

interface TabItem {
    value: string;
    label: ReactNode;
    content: ReactNode;
    disabled?: boolean;
}
interface TabsProps extends ComponentProps<'div'> {
    tabs: TabItem[];
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    /** Spring preset for the underline indicator. Defaults to Spring.Snappy. */
    spring?: Spring;
    /** Stretches the tabs to fill the list width. */
    fullWidth?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Accessible name for the tab list. */
    'aria-label'?: string;
    className?: string;
}
/**
 * A tab menu following the WAI-ARIA tabs pattern with automatic activation:
 * the underline indicator is a shared framer-motion layout element, so it
 * springs between tabs the same way the SegmentedControl thumb does. Arrow
 * keys move and activate (wrapping, skipping disabled tabs), Home and End
 * jump to the extremes.
 */
declare function Tabs({ tabs, value, defaultValue, onValueChange, spring, fullWidth, skeleton, className, 'aria-label': ariaLabel, ...rest }: TabsProps): react.JSX.Element;

interface TooltipProps {
    /** The bubble content: a short label, shortcut, or hint. */
    content: ReactNode;
    /** The element the tooltip describes. Its ref and event handlers are wired up. */
    children: ReactElement;
    /** Where to place the bubble relative to the trigger before flipping and clamping. */
    placement?: Placement;
    /** Milliseconds of hover intent before the bubble opens. Focus opens instantly. */
    delay?: number;
    /** Suppresses the tooltip entirely; the trigger renders untouched. */
    disabled?: boolean;
    /** Renders a placeholder with the exact geometry. */
    skeleton?: boolean;
    className?: string;
}
/**
 * A hover and focus tooltip. The bubble portals to document.body so it escapes
 * overflow-clipping ancestors and stacking contexts, then flips and clamps to
 * stay on screen. It opens on hover intent after a short delay or immediately
 * on focus, and hides on leave, blur, or Escape. The bubble is non-interactive
 * (pointer-events: none) so it can never trap the cursor, and the trigger is
 * linked to it with aria-describedby.
 */
declare function Tooltip({ content, children, placement, delay, disabled, skeleton, className, }: TooltipProps): react.JSX.Element;

type ToastTone = (typeof toastTones)[number];
interface ToastProps {
    tone?: ToastTone;
    /** The notification content. */
    message: ReactNode;
    /** Optional leading glyph. */
    icon?: ReactNode;
    /**
     * One verb, offered while the pill stands - "Undo" is the whole reason this
     * exists. Pressing it runs the handler and dismisses; a toast is not a form,
     * so one action is the ceiling and anything needing two belongs in a dialog.
     */
    action?: {
        label: string;
        onPress: () => void;
    };
    /** Whether a trailing close control is shown. */
    dismissible?: boolean;
    /** Called when the pill or its dismiss control is pressed. */
    onDismiss?: () => void;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    className?: string;
}
/**
 * The visual toast pill. Rendered on its own it is a static notification;
 * the ToastProvider wraps it in motion and a portal. A danger toast announces
 * as an alert, other tones as a status.
 */
declare function Toast({ tone, message, icon, action, dismissible, onDismiss, glass, skeleton, className, }: ToastProps): react.JSX.Element;
interface ToastOptions {
    tone?: ToastTone;
    message: ReactNode;
    icon?: ReactNode;
    /** One verb beside the message - see ToastProps.action. */
    action?: {
        label: string;
        onPress: () => void;
    };
    /** Auto-dismiss delay in milliseconds; defaults by tone, 0 disables auto-dismiss. */
    duration?: number;
    /** Whether a trailing close control is shown. */
    dismissible?: boolean;
    /** Renders the frosted glass material instead of a solid surface. */
    glass?: boolean;
}
interface ToastContextValue {
    /** Show a toast, replacing any current one (latest wins, no queue). */
    toast: (options: ToastOptions) => void;
    /** Dismiss the current toast, if any. */
    dismiss: () => void;
}
/**
 * Holds the single current toast, portals it to the bottom center of
 * document.body, and runs the auto-dismiss timer. A new toast replaces the
 * current one immediately: this is a deliberate latest-wins, no-queue design.
 */
declare function ToastProvider({ children }: {
    children: ReactNode;
}): react.JSX.Element;
/**
 * Returns the imperative toast controls. Must be called under a ToastProvider.
 * `toast({ tone, message, icon?, duration?, dismissible? })` replaces the
 * current toast; `dismiss()` clears it.
 */
declare function useToast(): ToastContextValue;

/** A value that can vary by breakpoint. Scalars apply at every width. */
type Responsive<T> = T | Partial<Record<'base' | 'sm' | 'md' | 'lg' | 'xl', T>>;
type Background = 'transparent' | 'bg' | 'surface' | 'surfaceRaised' | 'surfaceSunken' | 'accent' | 'accentSoft' | 'glass';
type RadiusToken = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
type BorderToken = boolean | 'subtle' | 'strong' | 'accent';
type ElevationToken = 0 | 1 | 2 | 3 | 4 | 5;
type ContainerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'prose' | 'full';
type WidthToken = 'auto' | 'full' | 'fit';
type HeightToken = 'auto' | 'full' | 'screen';
type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
type Justify = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';
/**
 * The shared style surface every layout primitive accepts. All values are
 * scale keys, never raw lengths, so nothing can land off the system.
 */
interface BoxStyleProps {
    /** Padding on all sides, from the space scale. */
    padding?: Responsive<SpaceStep>;
    paddingX?: Responsive<SpaceStep>;
    paddingY?: Responsive<SpaceStep>;
    paddingTop?: SpaceStep;
    paddingRight?: SpaceStep;
    paddingBottom?: SpaceStep;
    paddingLeft?: SpaceStep;
    background?: Background;
    radius?: RadiusToken;
    border?: BorderToken;
    elevation?: ElevationToken;
    width?: WidthToken;
    maxWidth?: ContainerSize;
    height?: HeightToken;
    /** Grow to fill the main axis of a parent Row or Stack. */
    grow?: boolean;
    /** Allow shrinking below content size. Layout primitives shrink by default. */
    shrink?: boolean;
    alignSelf?: Align;
}
interface FlowProps {
    /** Space between children, from the space scale. */
    gap?: Responsive<SpaceStep>;
    /** Cross-axis alignment. */
    align?: Align;
    /** Main-axis distribution. */
    justify?: Justify;
}

interface BoxProps extends BoxStyleProps, Omit<ComponentProps<'div'>, 'color'> {
    /** Rendered element. Defaults to a div. */
    as?: ElementType;
    children?: ReactNode;
}
/**
 * The base layout primitive: a block with token-locked padding, surface, and
 * sizing. Compose it, or reach for Stack, Row, and Grid for flow. min-width is
 * zero so it never overflows a flex or grid parent.
 */
declare function Box({ as, className, style, children, ...props }: BoxProps): react.JSX.Element;

interface StackProps extends BoxStyleProps, FlowProps, Omit<ComponentProps<'div'>, 'color'> {
    as?: ElementType;
    children?: ReactNode;
}
/**
 * A vertical flow. Children stack with a token gap and no margins, so the
 * rhythm is always even. Defaults to gap 4 and stretched children.
 */
declare function Stack({ as, gap, align, justify, className, style, children, ...props }: StackProps): react.JSX.Element;

interface RowProps extends BoxStyleProps, FlowProps, Omit<ComponentProps<'div'>, 'color'> {
    as?: ElementType;
    /** Wrap onto new lines when the row runs out of width. */
    wrap?: boolean;
    children?: ReactNode;
}
/**
 * A horizontal flow. Children sit in a row with a token gap, centered on the
 * cross axis by default. Set wrap to let them flow onto new lines.
 */
declare function Row({ as, gap, align, justify, wrap, className, style, children, ...props }: RowProps): react.JSX.Element;

interface GridProps extends BoxStyleProps, Omit<ComponentProps<'div'>, 'color'> {
    as?: ElementType;
    gap?: Responsive<SpaceStep>;
    /** Fixed column count, optionally per breakpoint. Ignored when minChildWidth is set. */
    columns?: Responsive<number>;
    /** Auto-fit as many equal columns as fit at this minimum child width. */
    minChildWidth?: string;
    align?: Align;
    justify?: Justify;
    children?: ReactNode;
}
/**
 * A grid. Give it a fixed column count (responsive), or a minChildWidth to
 * auto-fit as many equal tracks as fit, which reflows with no media queries.
 * Children never overflow, since each track floors at zero.
 */
declare function Grid({ as, gap, columns, minChildWidth, align, justify, className, style, children, ...props }: GridProps): react.JSX.Element;

interface CenterProps extends BoxStyleProps, Omit<ComponentProps<'div'>, 'color'> {
    as?: ElementType;
    children?: ReactNode;
}
/**
 * Centers its children on both axes. Pair with height="screen" for a
 * full-viewport centered layout, or a fixed height for a panel.
 */
declare function Center({ as, className, style, children, ...props }: CenterProps): react.JSX.Element;

interface SpacerProps {
    className?: string;
}
/**
 * A flexible gap that pushes siblings apart inside a Row or Stack. Drop one
 * between two groups to send them to opposite ends without margins.
 */
declare function Spacer({ className }: SpacerProps): react.JSX.Element;

interface ContainerProps extends Omit<BoxStyleProps, 'maxWidth' | 'width'>, Omit<ComponentProps<'div'>, 'color'> {
    as?: ElementType;
    /** Max content width. Defaults to lg. */
    size?: ContainerSize;
    children?: ReactNode;
}
/**
 * A centered, width-capped column with comfortable responsive gutters. Wrap a
 * page in one so content never runs edge to edge on wide screens.
 */
declare function Container({ as, size, className, style, children, ...props }: ContainerProps): react.JSX.Element;

/** grid wraps cards on auto-fill columns; list stacks them in one column. */
type CardGroupMode = (typeof cardGroupModes)[number];
/** The token-driven gap steps between cards. */
type CardGroupGap = (typeof cardGroupGaps)[number];
/** compact tightens the chosen gap one space step. */
type CardGroupDensity = (typeof cardGroupDensities)[number];
interface CardGroupProps extends ComponentProps<'div'> {
    /**
     * Layout mode. grid lays cards on repeat(auto-fill, minmax(...)) columns
     * that keep a stable minimum width and wrap responsively; list stacks them
     * in a single column.
     */
    mode?: CardGroupMode;
    /**
     * The minimum card width in grid mode, e.g. '16rem'. Feeds the
     * --card-group-min custom property; ignored in list mode.
     */
    minItemWidth?: string;
    /** Space between cards, from the token scale. */
    gap?: CardGroupGap;
    /** compact tightens the chosen gap one space step. */
    density?: CardGroupDensity;
    /** Renders placeholder cards so the grid geometry holds while loading. */
    skeleton?: boolean;
    /** How many placeholder cards the skeleton renders. */
    skeletonCount?: number;
    /** The cards, or any repeated surfaces. */
    children?: ReactNode;
}
/**
 * A layout shelf for repeated surfaces such as Cards and StatTiles. In grid
 * mode it lays children on auto-fill columns floored at `minItemWidth` (and
 * clamped to the container, so a card never overflows a narrow parent); in
 * list mode it stacks them in a single column. Purely visual: it renders a
 * plain div with no role, so add list semantics on top when the content is
 * semantically a list.
 */
declare function CardGroup({ mode, minItemWidth, gap, density, skeleton, skeletonCount, className, style, children, ...rest }: CardGroupProps): react.JSX.Element;

interface SidebarProps extends Omit<ComponentProps<'div'>, 'title'> {
    /** Pinned region at the top, for a brand or a search field. */
    header?: ReactNode;
    /** Pinned region at the bottom, for a profile or settings link. */
    footer?: ReactNode;
    /** Spring preset for the active pill as it slides between items. */
    spring?: Spring;
    children?: ReactNode;
}
/**
 * The bones of a side navigation: an optional pinned header, a scrollable body
 * of sections, and an optional pinned footer. Drop it into AppShell's sidebar
 * slot and fill it with SidebarSection and SidebarItem. The active pill slides
 * between items with the chosen spring.
 */
declare function Sidebar({ header, footer, spring, className, children, ...rest }: SidebarProps): react.JSX.Element;
interface SidebarSectionProps extends Omit<ComponentProps<'div'>, 'title'> {
    /** Optional uppercase group heading. */
    title?: ReactNode;
    children?: ReactNode;
}
/** A titled group of sidebar items. */
declare function SidebarSection({ title, className, children, ...rest }: SidebarSectionProps): react.JSX.Element;
interface SidebarItemProps extends Omit<ComponentProps<'button'>, 'title'> {
    /** Rendered element. Use 'a' for links. Defaults to a button. */
    as?: ElementType;
    /** Anchor href when rendered as a link. */
    href?: string;
    target?: string;
    rel?: string;
    icon?: ReactNode;
    /** Highlights the item as the current location. */
    active?: boolean;
    /** Trailing content such as a CounterBadge. */
    trailing?: ReactNode;
    children?: ReactNode;
}
/** A navigation row: icon, label, and an optional trailing slot. */
declare function SidebarItem({ as, icon, active, trailing, disabled, className, children, ...rest }: SidebarItemProps): react.JSX.Element;

interface ToolbarProps extends ComponentProps<'div'> {
    /** Content pinned to the start, such as a menu button or a title. */
    start?: ReactNode;
    /** Content pinned to the end, such as actions. */
    end?: ReactNode;
    /** Stick to the top of the scroll container. */
    sticky?: boolean;
    /** Add a bottom hairline. */
    border?: boolean;
    /** Add the translucent glass background, for app and page headers. */
    surface?: boolean;
    children?: ReactNode;
}
/**
 * A horizontal bar with start and end slots and a flexible middle. Use it for
 * app headers, page toolbars, and card headers. The middle grows, so the end
 * slot always hugs the trailing edge without a margin.
 */
declare function Toolbar({ start, end, sticky, border, surface, className, children, ...rest }: ToolbarProps): react.JSX.Element;

interface TitleBarProps extends Omit<ComponentProps<'header'>, 'title'> {
    /** One-line centered title, small and muted. It truncates instead of wrapping. */
    title?: ReactNode;
    /** Content pinned to the start, after the traffic-light gutter. Stays clickable. */
    start?: ReactNode;
    /** Content pinned to the end, such as window-level actions. Stays clickable. */
    end?: ReactNode;
    /**
     * Reserve an 88px inline-start gutter for the macOS close, minimize, and
     * zoom buttons that a titleBarStyle Overlay window paints over the bar.
     */
    trafficLightInset?: boolean;
    /** The translucent glass background with backdrop blur, like the app header. */
    surface?: boolean;
    /** A bottom hairline separating the bar from the window content. */
    border?: boolean;
    /** Renders a placeholder with the bar's exact geometry. */
    skeleton?: boolean;
    /** Extra centered content beside the title, such as a search field. */
    children?: ReactNode;
}
/**
 * The desktop window bar for Tauri and Electron shells: the fixed-height strip
 * at the very top of the window. It owns window dragging, centers a one-line
 * title (plus any children, such as a search field), and can reserve the
 * gutter where macOS paints its window controls.
 *
 * data-tauri-drag-region is a plain string attribute: Tauri starts a window
 * drag on mousedown when the pressed element itself carries it, and the
 * attribute is inert everywhere else (Electron, the browser). Only the bar
 * root and the title get it; interactive slot children do not, so their
 * buttons keep receiving clicks. -webkit-app-region is intentionally not
 * used, since the kit targets Tauri's attribute model.
 */
declare function TitleBar({ title, start, end, trafficLightInset, surface, border, skeleton, role, className, children, ...rest }: TitleBarProps): react.JSX.Element;

type SectionGap = 'sm' | 'md' | 'lg';
type SectionDensity = 'comfortable' | 'compact';
type SectionHeadingLevel = 2 | 3;
interface SectionProps extends Omit<ComponentProps<'section'>, 'title'> {
    /** Section heading; when present its generated id labels the section through aria-labelledby. */
    title?: ReactNode;
    /** Muted supporting line under the title. */
    description?: ReactNode;
    /** End-aligned content on the heading row, such as actions. */
    actions?: ReactNode;
    /** Semantic heading level for the title. */
    headingLevel?: SectionHeadingLevel;
    /** Vertical rhythm between the header block and the content. */
    gap?: SectionGap;
    /** Draw a hairline top rule so stacked sections separate cleanly. */
    divider?: boolean;
    /** Section rhythm; compact trims every gap one step down the scale. */
    density?: SectionDensity;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** The section content. */
    children?: ReactNode;
}
/**
 * A titled page region: a heading row with an optional description and
 * end-aligned actions, a token-driven rhythm gap before the content, and an
 * optional hairline divider for stacking sections down a page. With a title
 * the section is a labelled landmark region; without one it renders a plain
 * section, so pass aria-label when an untitled section should still be a
 * named region.
 */
declare function Section({ title, description, actions, headingLevel, gap, divider, density, skeleton, className, children, ...rest }: SectionProps): react.JSX.Element;

/** One row of the overflow menu behind the ellipsis button. */
interface PageHeaderAction {
    /** Stable identity for the row. */
    id: string;
    /** The row's label. */
    label: ReactNode;
    /** Called when the row is chosen; the menu then closes. */
    onSelect?: () => void;
    /** Dims the row and ignores selection. */
    disabled?: boolean;
}
interface PageHeaderProps extends Omit<ComponentProps<'header'>, 'title'> {
    /** The page title, rendered as an h1 or h2 per headingLevel. */
    title: ReactNode;
    /** Muted supporting copy under the title. */
    description?: ReactNode;
    /** Slot above the title; compose the kit Breadcrumbs. */
    breadcrumbs?: ReactNode;
    /** Inline metadata row under the title and description: pills, status dots, counts. */
    meta?: ReactNode;
    /** Primary actions, end-aligned on wide layouts. */
    actions?: ReactNode;
    /**
     * Secondary actions collected into an overflow Menu behind a localized
     * ellipsis button. The button is omitted entirely when the list is empty.
     */
    secondaryActions?: PageHeaderAction[];
    /** The heading element used for the title. */
    headingLevel?: 1 | 2;
    /** Compact trims the vertical padding and stack gap for dense screens. */
    density?: 'comfortable' | 'compact';
    /** Renders a placeholder with the header's exact geometry. */
    skeleton?: boolean;
}
/**
 * The page masthead: breadcrumbs over an h1/h2 title with a muted description
 * and an inline metadata row, primary actions end-aligned, and an overflow
 * menu of secondary actions behind an ellipsis button. The title block and
 * the actions share one wrapping flex row, so on narrow widths the actions
 * drop below the title without overlap and without any JS measurement.
 */
declare function PageHeader({ title, description, breadcrumbs, meta, actions, secondaryActions, headingLevel, density, skeleton, className, ...rest }: PageHeaderProps): react.JSX.Element;

type NavBarOrientation = (typeof navBarOrientations)[number];
interface NavBarProps extends ComponentProps<'nav'> {
    /** Horizontal row for a top nav or bottom tab bar; vertical for a slim icon rail. */
    orientation?: NavBarOrientation;
    /** Required: apps often carry more than one nav landmark, and the label tells them apart. */
    'aria-label': string;
    /** Pinned to the far end (bottom when vertical, trailing edge when horizontal), for a settings item. */
    end?: ReactNode;
    /** Show item labels beside icons in horizontal orientation. Defaults to icon-only. */
    showLabels?: boolean;
    /** Spring preset for the active pill as it slides between items. */
    spring?: Spring;
    /**
     * Bar-level plate silhouette, applied to every item. 'rect' is the untouched
     * default; the gamified plates put the bar in the game-menu register, with
     * the sliding active pill preserved, and mirror under [dir='rtl'].
     */
    shape?: ShapeName;
    /** Paints the accent leading-edge stripe on each item plate. */
    edgeAccent?: boolean;
    /** Slides the gradient sweep across an item plate on hover and focus-visible. */
    sweep?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    children?: ReactNode;
}
/**
 * An app-level primary navigation bar. It renders icon-only destinations with
 * accessible labels and tooltips by default; showLabels adds visible text to
 * horizontal items. Fill it with NavBarItem and
 * pin a settings item in the end slot. The active pill slides between items
 * with the chosen spring.
 */
declare function NavBar({ orientation, end, showLabels, spring, shape, edgeAccent, sweep, skeleton, className, children, 'aria-label': ariaLabel, ...rest }: NavBarProps): react.JSX.Element;
interface NavBarItemProps extends Omit<ComponentProps<'button'>, 'children'> {
    /** Rendered element. Use 'a' for links. Defaults to a button. */
    as?: ElementType;
    /** Anchor href when rendered as a link. */
    href?: string;
    target?: string;
    rel?: string;
    /** Required leading glyph, hidden from assistive tech. */
    icon: ReactNode;
    /**
    * Required accessible label. It appears in a tooltip by default and becomes
    * visible text when a horizontal NavBar enables showLabels.
     */
    label: string;
    /** Highlights the item as the current location. */
    active?: boolean;
    /** Optional count shown as a CounterBadge: pinned to the icon corner in vertical, inline in horizontal. */
    badge?: number;
}
/**
 * One destination in a NavBar: an icon with an accessible label, an optional
 * count badge, and the sliding active pill. Icon-only items expose the label
 * through aria-label and a tooltip.
 */
declare function NavBarItem({ as, icon, label, active, badge, disabled, className, ...rest }: NavBarItemProps): react.JSX.Element;

interface ColorPickerProps extends Omit<ComponentProps<'div'>, 'onChange' | 'defaultValue' | 'color'> {
    /** Controlled colour, as a CSS oklch() or hex string. */
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    /** Which notation to report. */
    format?: 'oklch' | 'hex';
    /** Fixed swatches offered under the sliders. */
    presets?: string[];
    /** Offers an opacity slider as a fourth channel. */
    alpha?: boolean;
    size?: 'sm' | 'md';
    disabled?: boolean;
    skeleton?: boolean;
}
/**
 * An OKLCH colour picker.
 *
 * OKLCH rather than HSL because that is the space the kit's own ramps are
 * authored in: a colour picked here sits on the same perceptual footing as
 * every token around it, and its lightness means the same thing at every hue
 * which is exactly what HSL does not give you.
 *
 * Three plain range inputs rather than a 2D gradient canvas. A canvas is only
 * operable by dragging, so it cannot be used without sight or without a mouse;
 * three labelled sliders plus a hex field can be driven entirely from the
 * keyboard, and each slider paints the gradient it actually traverses.
 *
 * Out-of-gamut colours are named rather than silently clamped, so the swatch
 * never quietly shows something other than what was asked for.
 */
declare function ColorPicker({ value: valueProp, defaultValue, onValueChange, format, presets, alpha, size, disabled, skeleton, className, ...rest }: ColorPickerProps): react.JSX.Element;

type PlayerBarQuality = 'low' | 'medium' | 'high' | 'lossless';
type PlayerBarPosition = (typeof playerBarPositions)[number];
/** Every label the strip needs, so it can be spoken in any language. */
interface PlayerBarLabels extends TransportControlsLabels, VolumeBarLabels {
    seek: string;
    favorite: string;
    unfavorite: string;
    quality: string;
    qualityLow: string;
    qualityMedium: string;
    qualityHigh: string;
    qualityLossless: string;
}
interface PlayerBarProps extends Omit<ComponentProps<'div'>, 'title' | 'defaultValue' | 'onChange' | 'onVolumeChange'> {
    /** Album art, forwarded to the track block. Takes the full height of the strip. */
    artwork?: ReactNode;
    /** What is playing. */
    title?: ReactNode;
    /**
     * A second line, the artist. There is no third: a strip is read at a glance
     * from across a room, and the album is the one of the three nobody is
     * scanning for.
     */
    subtitle?: ReactNode;
    /** Track length in seconds. */
    duration: number;
    /** Controlled playhead position in seconds. */
    value?: number;
    defaultValue?: number;
    onValueChange?: (seconds: number) => void;
    onSeekEnd?: (seconds: number) => void;
    /** Controlled play state. */
    playing?: boolean;
    defaultPlaying?: boolean;
    onPlayingChange?: (playing: boolean) => void;
    /** Omit a handler and that control is not rendered. */
    onSkipBack?: () => void;
    onSkipForward?: () => void;
    /** Controlled shuffle. Omit both this and the handler to drop the control. */
    shuffle?: boolean;
    defaultShuffle?: boolean;
    onShuffleChange?: (on: boolean) => void;
    /** Controlled repeat mode. Omit both this and the handler to drop the control. */
    repeat?: PlayerRepeat;
    defaultRepeat?: PlayerRepeat;
    onRepeatChange?: (mode: PlayerRepeat) => void;
    /**
     * Controlled favourite state. Omit both this and the handler to drop the
     * heart - a strip that cannot save anything should not offer to.
     */
    favorite?: boolean;
    defaultFavorite?: boolean;
    onFavoriteChange?: (on: boolean) => void;
    /** Controlled fader position, 0-100. Omit both this and the handler to drop the fader. */
    volume?: number;
    defaultVolume?: number;
    onVolumeChange?: (volume: number) => void;
    /** Controlled mute state. */
    muted?: boolean;
    defaultMuted?: boolean;
    onMutedChange?: (muted: boolean) => void;
    /** Controlled stream quality. */
    quality?: PlayerBarQuality;
    defaultQuality?: PlayerBarQuality;
    onQualityChange?: (quality: PlayerBarQuality) => void;
    /** What the fader's readout prints; forwarded to the VolumeBar. */
    volumeReadout?: VolumeReadout;
    /**
     * Controls flanking the bar and its transport, on the rail either side of
     * them. This is where a strip's second thoughts go - a lyrics toggle, a cast
     * button - so they sit with the playback controls rather than out on the
     * trailing edge with the output.
     */
    leading?: ReactNode;
    trailing?: ReactNode;
    /**
     * Buttons on the trailing edge, before the fader. A slot rather than props,
     * because a queue button carrying a count is the app's idea of what it has
     * queued, not the kit's.
     */
    actions?: ReactNode;
    /** A quiet line under the fader for what the output is doing. */
    status?: ReactNode;
    /** How the strip sits against the window. */
    position?: PlayerBarPosition;
    /** How tightly it is packed. */
    density?: PlayerDensity;
    /**
     * Counts the trailing clock down rather than printing the total. A strip is
     * read while listening, when what is left matters more than how long it was.
     */
    remaining?: boolean;
    /** Forwarded to the seek bar. */
    shape?: SeekBarProps['shape'];
    tone?: SeekBarProps['tone'];
    fill?: SeekBarProps['fill'];
    rail?: SeekBarProps['rail'];
    levels?: number[];
    beat?: SeekBarProps['beat'];
    intensity?: SeekBarProps['intensity'];
    /**
     * Draws the seek bar's tracer, the shadow trailing the beat. On, as on a
     * card: the bar is the only moving thing on a strip, so it is what the eye
     * goes to. Without a `beat` there is nothing to trail, so a still strip pays
     * nothing for it.
     */
    tracer?: SeekBarProps['tracer'];
    /** Formats both clocks. */
    formatTime?: (seconds: number) => string;
    /** Dims the strip and blocks every control. */
    disabled?: boolean;
    /** Loads every part as its own placeholder, keeping the strip's exact height. */
    skeleton?: boolean;
    /** Overrides the control labels; merged over the English defaults. */
    labels?: Partial<PlayerBarLabels>;
}
/**
 * The whole player on one line: what is playing on the leading edge, the seek
 * bar with the transport under it through the middle, and the output controls -
 * actions, volume, format - on the trailing edge.
 *
 * A strip is chrome rather than a card. It is docked against an edge of the
 * window and is never the subject of the screen, which is what decides most of
 * its shape: the cover takes the height the controls set rather than choosing
 * its own, the track block is two lines rather than three, and the strip takes
 * no focus of its own, so tabbing into a document never lands here first.
 *
 * It is assembled from three components that each stand alone - `TrackInfo`,
 * `TransportControls`, and `VolumeBar` - so an app that wants a different strip
 * can build one out of the same parts rather than fighting this one.
 */
declare function PlayerBar({ artwork, title, subtitle, duration, value, defaultValue, onValueChange, onSeekEnd, playing, defaultPlaying, onPlayingChange, onSkipBack, onSkipForward, shuffle, defaultShuffle, onShuffleChange, repeat, defaultRepeat, onRepeatChange, favorite, defaultFavorite, onFavoriteChange, volume, defaultVolume, onVolumeChange, muted, defaultMuted, onMutedChange, quality, defaultQuality, onQualityChange, volumeReadout, leading, trailing, actions, status, position, density, remaining, shape, tone, fill, rail, levels, beat, intensity, tracer, formatTime, disabled, skeleton, labels, className, style, ...rest }: PlayerBarProps): react.JSX.Element;

interface RichTextEditorProps extends Omit<ComponentProps<'div'>, 'onChange' | 'defaultValue'> {
    /** Controlled markdown text. */
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    placeholder?: string;
    /** Which inline controls to offer. Defaults to all four. */
    marks?: MarkdownMark[];
    /** Which block controls to offer. Defaults to all four. */
    blocks?: MarkdownBlock[];
    rows?: number;
    maxLength?: number;
    disabled?: boolean;
    skeleton?: boolean;
}
/**
 * A markdown editor with a formatting toolbar - the writable counterpart to
 * `CodeBlock`.
 *
 * Markdown over `contenteditable`, deliberately. A contenteditable surface is a
 * DOM-only construct with no React Native equivalent, so an editor built on one
 * could never have a native binding; and it means reimplementing selection,
 * undo, spellcheck, and dictation, all of which a plain `<textarea>` already
 * does properly. The value here is a string, and every transform is pure string
 * arithmetic living in @glacier/logic - so Bold does exactly the same thing
 * in the native editor.
 *
 * The toolbar reads the document as well as writing to it: a control is pressed
 * when its mark already surrounds the caret, which is what lets you tell "this
 * is bold" from "make this bold".
 */
declare function RichTextEditor({ value: valueProp, defaultValue, onValueChange, placeholder, marks, blocks, rows, maxLength, disabled, skeleton, className, id, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, 'aria-describedby': ariaDescribedBy, ...rest }: RichTextEditorProps): react.JSX.Element;

/** The imperative surface, for scrolling to a row the user has not scrolled to. */
interface VirtualListHandle {
    /** Scrolls the row at `index` into view. Does nothing if it already is. */
    scrollToIndex: (index: number, align?: 'auto' | 'start' | 'center' | 'end') => void;
}
interface VirtualListProps extends Omit<ComponentProps<'div'>, 'children' | 'ref'> {
    /** How many rows there are in total. */
    count: number;
    /** Height of one row in pixels. Every row is this tall. */
    itemSize: number;
    /** Renders the row at an index. Called only for rows inside the window. */
    renderItem: (index: number) => ReactNode;
    /** Viewport height. Defaults to filling its parent. */
    height?: string | number;
    /** Extra rows rendered beyond each edge of the viewport. */
    overscan?: number;
    /** Called with the first and last rendered index whenever the window moves. */
    onVisibleChange?: (start: number, end: number) => void;
    /** A stable key for the row at an index. Defaults to the index. */
    getKey?: (index: number) => string | number;
    emptyLabel?: ReactNode;
    skeleton?: boolean;
    ref?: Ref<VirtualListHandle>;
}
/**
 * Renders only the rows the scroller can actually show.
 *
 * A tall spacer holds the true scroll height so the scrollbar describes the
 * data, and a small absolutely-positioned window holds the rows that are
 * currently on screen. The arithmetic - which rows, how tall, how far down -
 * all comes from @glacier/logic, so the native list renders the same slice
 * for the same scroll position.
 *
 * Fixed row heights only, on purpose. Variable heights need every row measured
 * and the scroll offset corrected as estimates are replaced; that is a
 * different component, and pretending otherwise produces a list that jitters
 * while you scroll it.
 *
 * The rows carry `aria-setsize` and `aria-posinset` describing the whole list
 * rather than the window, because a screen reader announcing "3 of 12" while
 * the user is at item 40,000 is worse than no announcement.
 */
declare function VirtualList({ count, itemSize, renderItem, height, overscan, onVisibleChange, getKey, emptyLabel, skeleton, className, ref, ...rest }: VirtualListProps): react.JSX.Element;

/** The minimum a row must provide: something stable to key and track it by. */
interface SortableItemLike {
    id: string;
}
interface SortableListProps<T extends SortableItemLike> extends Omit<ComponentProps<'ul'>, 'children' | 'onDrop'> {
    /** The rows in their current order. Controlled. */
    items: T[];
    /** Called with the reordered array once a move is committed. */
    onReorder: (items: T[]) => void;
    /** Renders one row's content; the handle and row chrome are the list's. */
    renderItem: (item: T, index: number) => ReactNode;
    /** The name announced as a row moves. Defaults to the id. */
    getLabel?: (item: T) => string;
    size?: 'sm' | 'md' | 'lg';
    disabled?: boolean;
    skeleton?: boolean;
    /** How many placeholder rows to draw while loading. */
    skeletonRows?: number;
}
/**
 * A list whose rows can be reordered by dragging a handle - or entirely from
 * the keyboard, which is the part most drag-and-drop implementations skip.
 *
 * Two gestures, one model. A pointer drag tracks the handle and drops on
 * release; a keyboard reorder *lifts* a row with Space, moves it with the
 * arrows, and drops it with Space again, with Escape restoring the original
 * order. Both resolve through the same `moveItem` in @glacier/logic, so a row
 * dropped in the fourth slot lands in the fourth slot either way.
 *
 * Controlled by design: the list never reorders itself. It reports the array it
 * would like and the caller decides, which is what lets a reorder be rejected,
 * persisted, or undone.
 */
declare function SortableList<T extends SortableItemLike>({ items, onReorder, renderItem, getLabel, size, disabled, skeleton, skeletonRows, className, ...rest }: SortableListProps<T>): react.JSX.Element;

type CardFanSize = 'sm' | 'md' | 'lg';
/** The minimum a fan needs to identify and render one card. */
interface CardFanItem {
    id: string;
}
interface CardFanProps<T extends CardFanItem = CardFanItem> extends Omit<ComponentProps<'ul'>, 'onSelect' | 'children'> {
    /** The cards, in the order they sit along the fan. */
    items: T[];
    /** Renders one card's body. The placement and magnification are the fan's. */
    renderItem: (item: T, index: number) => ReactNode;
    /** The name announced for a card; its id is rarely what a person wants read. */
    getLabel?: (item: T) => string;
    /** Controlled selection, by id. */
    selected?: string;
    defaultSelected?: string;
    onSelect?: (id: string) => void;
    size?: CardFanSize;
    /** Multiplies the lean and the bow. 0 lays the fan flat into a row. */
    spread?: number;
    /** Grows the card under the pointer and its near neighbours. */
    magnify?: boolean;
    disabled?: boolean;
    skeleton?: boolean;
}
/**
 * A hand of cards spread along a fixed arc.
 *
 * The spread is a slinky rather than an even step, which is what lets one
 * component hold seven cards or forty in the same strip: the track is a fixed
 * length and the cards are distributed across it by weight, so focusing one
 * opens the fan around it while the rest compress. The ends stay pinned, so the
 * silhouette never moves and the fan cannot overflow. All of that arithmetic is
 * in @glacier/logic, so the native fan lays out identically.
 *
 * Placement is a track position, not a transform - the two are kept apart so the
 * transform stays free for the lean, the lift and any drag the caller adds. It
 * also means a pointer sweeping a forty-card fan reshapes it by writing one
 * custom property per card, without re-rendering forty cards a frame.
 */
declare function CardFan<T extends CardFanItem = CardFanItem>({ items, renderItem, getLabel, selected: selectedProp, defaultSelected, onSelect, size, spread, magnify, disabled, skeleton, className, ...rest }: CardFanProps<T>): react.JSX.Element;

interface CalendarViewProps extends Omit<ComponentProps<'div'>, 'onSelect'> {
    /** Everything to lay over the range. Events outside it are ignored. */
    events: CalendarEvent[];
    mode?: CalendarViewMode;
    defaultMode?: CalendarViewMode;
    onModeChange?: (mode: CalendarViewMode) => void;
    /** Controlled anchor date; the range shown is the one containing it. */
    date?: Date;
    defaultDate?: Date;
    onDateChange?: (date: Date) => void;
    /** 0 for Sunday, 1 for Monday. */
    weekStartsOn?: WeekStart;
    selected?: Date;
    /** Omit to leave day cells unpressable. */
    onSelectDay?: (date: Date) => void;
    /** Omit to leave event chips unpressable. */
    onSelectEvent?: (event: CalendarEvent) => void;
    /** Which day to mark as today; injectable so a test is not clock-dependent. */
    today?: Date;
    /** How many days the agenda lists. */
    agendaDays?: number;
    formatTime?: (date: Date) => string;
    emptyLabel?: ReactNode;
    skeleton?: boolean;
    /**
     * Turns on the built-in editor: pressing an event opens it for editing, and
     * double-pressing empty day space opens a blank one on that day.
     *
     * The calendar still does not own the events - it reports what the user did
     * through the three callbacks below and re-renders from the `events` you pass
     * back. `upsertEvent` and `removeEvent` in @glacier/logic do that update.
     */
    editable?: boolean;
    onEventCreate?: (event: CalendarEvent) => void;
    onEventChange?: (event: CalendarEvent) => void;
    /** Omit to hide the editor's delete control. */
    onEventDelete?: (id: string) => void;
    /** Mints the id for a new event. Defaults to one unique to this calendar. */
    newEventId?: () => string;
}
/**
 * A scheduler surface: events laid over a month grid, a week, or an agenda.
 *
 * Distinct from `DatePicker`, which is an input - this one shows what is
 * *scheduled*, and its day cells are content rather than choices. All the date
 * arithmetic, bucketing, and paging live in @glacier/logic, so the native
 * calendar builds the same grid from the same inputs.
 *
 * Month and week are one `role="grid"` with roving focus: exactly one cell is
 * tabbable and the arrows move within, so Tab leaves the calendar rather than
 * walking forty-two cells. Agenda is a plain list, because it has no second
 * axis and announcing a grid there would describe a structure that is not
 * present.
 */
declare function CalendarView({ events, mode: modeProp, defaultMode, onModeChange, date: dateProp, defaultDate, onDateChange, weekStartsOn, selected, onSelectDay, onSelectEvent, today: todayProp, agendaDays, formatTime, emptyLabel, skeleton, editable, onEventCreate, onEventChange, onEventDelete, newEventId, className, ...rest }: CalendarViewProps): react.JSX.Element;

interface CommandPaletteProps {
    open: boolean;
    /** Called with false when the user dismisses, or runs a command. */
    onOpenChange: (open: boolean) => void;
    /**
     * Every command the palette can run, in the order they should be offered.
     * Priority is the caller's to decide - the palette filters and groups but
     * never reorders.
     */
    commands: CommandDescriptor[];
    /** Called with the chosen command's id, after the palette has closed. */
    onRun: (id: string) => void;
    /** Controlled query text. */
    query?: string;
    /** Initial query when uncontrolled; the palette resets to it on each open. */
    defaultQuery?: string;
    onQueryChange?: (query: string) => void;
    placeholder?: string;
    /** Shown in place of the list when nothing matches. */
    emptyLabel?: ReactNode;
    /** Replaces the default key-hint strip. Pass null to drop it. */
    footer?: ReactNode;
    size?: 'sm' | 'md' | 'lg';
    /** Binds ⌘K / Ctrl+K globally. Turn it off to own the chord yourself. */
    shortcut?: boolean;
}
/**
 * A ⌘K overlay that searches every action in the app.
 *
 * One text field drives the whole surface: typing narrows the list, the arrow
 * keys move a cursor through it, and Enter runs what the cursor is on. Focus
 * never leaves the field - the active row is named by `aria-activedescendant`
 * rather than focused, which is what lets a single input control a list.
 *
 * Matching, grouping, and cursor movement all live in @glacier/logic, so this
 * component is only the surface: the native palette answers the same query with
 * the same list in the same order.
 */
declare function CommandPalette({ open, onOpenChange, commands, onRun, query: queryProp, defaultQuery, onQueryChange, placeholder, emptyLabel, footer, size, shortcut, }: CommandPaletteProps): react.ReactPortal | null;

/**
 * What a slot renderer is told about the message it is decorating.
 *
 * The reactions, attachments, and quoted-reply components are built separately;
 * this is the contract between them and the run. It carries the message plus the
 * geometry facts a decoration might need - a reaction bar under the last bubble
 * of a run sits beside a tail, and one under a middle bubble does not.
 */
interface MessageSlotContext<M extends ChatMessage = ChatMessage> {
    message: M;
    /** Position within this run, not within the transcript. */
    index: number;
    /** Where the message sits in the run; the same value that cut its corners. */
    position: BubblePosition;
    /** The viewer wrote it. */
    own: boolean;
    layout: MessageLayout;
    /** This is the message that ends the run - the one wearing the tail. */
    last: boolean;
}
interface MessageGroupProps<M extends ChatMessage = ChatMessage> extends Omit<ComponentProps<'div'>, 'children' | 'content'> {
    /** The run, exactly as `groupMessages` in @glacier/logic built it. */
    group: MessageGroup$1<M>;
    layout?: MessageLayout;
    /** The viewer wrote this run. Derived from `viewerId` when omitted. */
    own?: boolean;
    /** The reading user, compared against the run's authorId. */
    viewerId?: string;
    /**
     * Overrides the edge authorship would choose, for the whole run.
     *
     * Logical, never physical, so a right-to-left transcript still mirrors as a
     * whole. This is how a thread becomes one column of bubbles without lying
     * about `own` - which would move the run and silently take its delivery
     * state with it, since a run that is not local is not allowed one.
     */
    side?: MessageSide;
    /** Drawn once at the head of the run, never on a continued one. */
    avatar?: ReactNode;
    /** Drawn once at the head of the run, never on a continued one. */
    authorName?: ReactNode;
    /**
     * The author's name as a plain string. A continued run hides its visible
     * header but must still be announced, or a screen reader hears an unlabelled
     * group of messages from nobody.
     */
    authorLabel?: string;
    /** Draws a tail on the message that ends the run. Ignored in row layout. */
    tails?: boolean;
    /** The instant timestamps are read against. */
    now?: Millis;
    /** BCP-47 tag for the timestamp formatter. */
    locale?: string;
    /** Replaces the default text rendering for one message. */
    renderBody?: (context: MessageSlotContext<M>) => ReactNode;
    /** Returns the reaction bar for one message. */
    renderReactions?: (context: MessageSlotContext<M>) => ReactNode;
    /** Returns the attachment block for one message. */
    renderAttachments?: (context: MessageSlotContext<M>) => ReactNode;
    /** Returns the quoted preview for one message. */
    renderReplyTo?: (context: MessageSlotContext<M>) => ReactNode;
    /** Translated delivery and edited words. */
    labels?: Partial<MessageLabels>;
    /** How many reader names the run's receipt line has room for. */
    readByMax?: number;
    /** Translated read-receipt sentences, one per shape. */
    receiptTemplates?: Partial<ReadReceiptTemplates>;
    /** Renders the run as placeholders at its real footprint. */
    skeleton?: boolean;
}
/**
 * One author's run of messages.
 *
 * A run exists so a burst of typing reads as one utterance rather than four
 * interruptions, and that only works if the repeated parts are said once: the
 * avatar at the head, the name at the head, and a single timestamp and delivery
 * line at the foot instead of one per message.
 *
 * The `continued` flag is the subtle case and the one most easily got wrong.
 * When the unread divider lands mid-run, `insertSeparators` splits the run and
 * marks the trailing half continued - it is the same person still talking, with
 * a line drawn through their sentence. Repeating the avatar and name there would
 * turn one speaker into two and make the divider look like a change of author,
 * so a continued run suppresses both while keeping the gutter reserved, and its
 * text stays on exactly the same line as the half above it.
 *
 * The run's delivery status is the least advanced of its members, not the last
 * one's, so a stack holding a failed send says so even when everything after it
 * went through.
 */
declare function MessageGroup<M extends ChatMessage = ChatMessage>({ group, layout, own, viewerId, side, avatar, authorName, authorLabel, tails, now, locale, renderBody, renderReactions, renderAttachments, renderReplyTo, labels, readByMax, receiptTemplates, skeleton, className, style, ...rest }: MessageGroupProps<M>): react.JSX.Element;

interface ConversationViewProps<M extends ChatMessage = ChatMessage> extends Omit<ComponentProps<'div'>, 'children' | 'onScroll'> {
    /** The transcript as a flat, chronological log. */
    messages: M[];
    /**
     * The reading user. Authorship is derived from this, so a caller never tags
     * a message as own or other - the same log renders correctly in two windows
     * signed in as two different people.
     */
    viewerId: string;
    layout?: MessageLayout;
    /**
     * Pins every run to one edge, keeping the bubbles, the fill, and the delivery
     * marks.
     *
     * Logical, never physical, so a right-to-left transcript mirrors as a whole.
     * The alternative an app would otherwise reach for - lying about `own` to
     * move a run - has a side effect it will not notice: a run that is not local
     * is not allowed a delivery state, so faking authorship silently deletes
     * every tick in the thread.
     */
    side?: MessageSide;
    /** The instant timestamps are read against. */
    now?: Millis;
    /** BCP-47 tag for the timestamp formatter. */
    locale?: string;
    /** Pause after which a new run begins; defaults to the shared window. */
    groupWindowMs?: number;
    /**
     * Weaves a date row in wherever the local calendar day changes. Off by
     * default: a thread of today's messages does not need a row saying today.
     */
    dayHeaders?: boolean;
    /**
     * The id of the first unread message, captured once when the thread opened.
     *
     * Pinning an id rather than recomputing from a read watermark is the entire
     * trick behind a divider that stays where the reader left it: messages append
     * after it and only its count grows.
     */
    unreadAnchorId?: string;
    /**
     * Fallback watermark, consulted only when no anchor id resolves. It picks the
     * first message after the mark that the viewer did not send.
     */
    lastReadAt?: Millis;
    /**
     * Reports the anchor the divider settled on, so a caller reading from
     * `lastReadAt` on the first render can pin it and stop the line walking down
     * the screen as messages are marked read.
     */
    onUnreadAnchor?: (anchorId: string | undefined) => void;
    /** How many reader names a run's receipt line has room for. */
    readByMax?: number;
    /** Translated read-receipt sentences, one per shape. */
    receiptTemplates?: Partial<ReadReceiptTemplates>;
    /** The avatar for one author, drawn once at the head of each run. */
    avatarFor?: (authorId: string) => ReactNode;
    /** The display name for one author, drawn once at the head of each run. */
    authorNameFor?: (authorId: string) => ReactNode;
    /** Replaces the default text rendering for one message. */
    renderBody?: (context: MessageSlotContext<M>) => ReactNode;
    /** Translated delivery and edited words, forwarded to every run. */
    labels?: Partial<MessageLabels>;
    /** Replaces the default empty state. */
    empty?: ReactNode;
    /** Accessible name for the scroll region, e.g. the other participant. */
    label?: string;
    /** Follows the live end while the reader is already at it. */
    stick?: boolean;
    /** Fires when the reader arrives at or leaves the live end. */
    onAtBottomChange?: (atBottom: boolean) => void;
    /** Renders the placeholder thread at the geometry it will settle into. */
    skeleton?: boolean;
}
/**
 * A scrolling conversation, built from a flat log and the reader's id.
 *
 * It exists to keep two axes apart that are constantly conflated, and almost
 * everything about the component follows from that:
 *
 * **Authorship - local or remote.** Which client produced the message. It
 * decides the edge, the fill, and which side of the column the run hugs, and it
 * is derived here from `viewerId` rather than demanded of the caller, because
 * "mine" is not a property of a message: the same row is mine in one window and
 * theirs in another.
 *
 * **Acknowledgement - optimistic or confirmed.** Whether the server has it.
 * This is about delivery, not authorship, and it exists on the local side only.
 *
 * The interaction is the part worth stating: **a remote run never shows a
 * tick, and a local run always does.** Not "does not by default" - never.
 * `conversationRuns` strips a status off a remote message rather than declining
 * to draw one, because a delivery mark is a claim about our outbox and there is
 * nothing behind that claim for a message someone else sent; a transport that
 * stamps every row it syncs is an ordinary thing, and the resulting tick would
 * be a lie the reader has no way to detect. The mirror of that rule fills a
 * status in on a local message that arrived without one, because a local
 * message reporting nothing is indistinguishable from one that never sent.
 *
 * An unacknowledged send reads as *in flight*, not as broken: the run keeps its
 * colour and steps back by a single alpha, and the delivery atom's clock glyph
 * carries the rest. No spinners. Every message is optimistic for a moment, and
 * a transcript that spun for each of them would be a loading screen with words
 * in it. A failed send does the opposite and stays at full strength with the
 * danger border, because it is the one row asking to be acted on.
 *
 * Scrolling is deliberately thin. It follows the live end while the reader is
 * already there and does nothing at all once they have scrolled up. There is no
 * anchoring, no offset preservation across prepends, no jump-to-latest button -
 * the heavy machinery belongs to a virtualised list, and the honest version of
 * "stick to bottom" is one comparison, in @glacier/logic, shared with native.
 */
declare function ConversationView<M extends ChatMessage = ChatMessage>({ messages, viewerId, layout, side, now, locale, groupWindowMs, dayHeaders, unreadAnchorId, lastReadAt, onUnreadAnchor, readByMax, receiptTemplates, avatarFor, authorNameFor, renderBody, labels, empty, label, stick, onAtBottomChange, skeleton, className, style, ...rest }: ConversationViewProps<M>): react.JSX.Element;

interface ModalProps {
    open: boolean;
    /** Called when the user dismisses via Escape, the close button, or the overlay. */
    onClose: () => void;
    title?: ReactNode;
    description?: ReactNode;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    footer?: ReactNode;
    children?: ReactNode;
}
/**
 * A glass dialog rendered in a portal. Springs open, closes instantly.
 * Locks body scroll, traps Tab focus inside the panel, closes on Escape and
 * overlay press, and restores focus to the opener on close.
 */
declare function Modal({ open, onClose, title, description, size, footer, children }: ModalProps): react.ReactPortal | null;

type DrawerSide = (typeof drawerSides)[number];
type DrawerSize = (typeof drawerSizes)[number];
interface DrawerProps extends Omit<ComponentProps<typeof motion.div>, 'title'> {
    open: boolean;
    onClose: () => void;
    title?: ReactNode;
    description?: ReactNode;
    side?: DrawerSide;
    size?: DrawerSize;
    /**
     * Detach the sheet into a floating card with a gutter on every edge and all
     * corners rounded. Defaults to following the host's layout mode: a root
     * data-layout='floating' attribute floats every drawer; omit it (or set
     * 'full') for flush, edge-to-edge sheets. The prop forces the mode per
     * drawer either way.
     */
    floating?: boolean;
    footer?: ReactNode;
    dismissible?: boolean;
    children?: ReactNode;
}
/** A modal sheet that enters from a viewport edge and shares dialog focus behavior with Modal. */
declare function Drawer({ open, onClose, title, description, side, size, floating, footer, dismissible, children, className, ...rest }: DrawerProps): react.ReactPortal | null;

type AlertDialogTone = (typeof alertDialogTones)[number];
interface AlertDialogProps extends Omit<ComponentProps<typeof motion.div>, 'title'> {
    open: boolean;
    onClose: () => void;
    title: ReactNode;
    description?: ReactNode;
    actionLabel: ReactNode;
    onAction: () => void;
    cancelLabel?: ReactNode;
    tone?: AlertDialogTone;
    actionDisabled?: boolean;
    actionLoading?: boolean;
    /** Allows Escape and backdrop dismissal. Defaults to false for deliberate confirmation flows. */
    dismissible?: boolean;
    children?: ReactNode;
}
/** A confirmation dialog that focuses its least destructive action first. */
declare function AlertDialog({ open, onClose, title, description, actionLabel, onAction, cancelLabel, tone, actionDisabled, actionLoading, dismissible, children, className, ...rest }: AlertDialogProps): react.ReactPortal | null;

interface AppShellProps extends ComponentProps<'div'> {
    /** The persistent side navigation. */
    sidebar: ReactNode;
    /** Optional top bar content, placed to the right of the mobile menu button. */
    header?: ReactNode;
    /** Optional primary navigation pinned below mobile content and at the bottom of the desktop sidebar. */
    bottomNav?: ReactNode;
    /** Sidebar width on desktop. Defaults to 16rem. */
    sidebarWidth?: string;
    /** Accessible name for the sidebar landmark. */
    sidebarLabel?: string;
    /** Detach the desktop sidebar into a floating, rounded card with a gutter. */
    floating?: boolean;
    /** Force the mobile or desktop layout. When omitted, follows the lg viewport breakpoint. */
    isMobile?: boolean;
    /** Let the user drag the divider (or arrow-key it) to resize the sidebar. */
    resizable?: boolean;
    /** Called with the next sidebar width (a px string) while resizing. */
    onSidebarWidthChange?: (width: string) => void;
    /** Clamp for the resize drag, in pixels. */
    minSidebarWidth?: number;
    maxSidebarWidth?: number;
    children?: ReactNode;
}
/**
 * The app frame: a sticky sidebar next to a scrollable main column with an
 * optional sticky header. Below the lg breakpoint the sidebar collapses into
 * an off-canvas drawer with a built-in menu button and backdrop. Escape, the
 * backdrop, and any link or button tap inside the sidebar close the drawer.
 */
declare function AppShell({ sidebar, header, bottomNav, sidebarWidth, sidebarLabel, floating, isMobile, resizable, onSidebarWidthChange, minSidebarWidth, maxSidebarWidth, children, style, ...rest }: AppShellProps): react.JSX.Element;

/** Derived from the spec so the union cannot drift. */
type PopoverOpenOn = (typeof popoverOpenOns)[number];
interface PopoverProps {
    /** The element that toggles the popover. Its ref and click are wired up. */
    trigger: ReactElement;
    /** Where to place the panel relative to the trigger. */
    placement?: Placement;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    /**
     * What opens the panel. Hover opens it on pointer and on focus and leaves the
     * trigger's press alone, for a trigger that already does something of its own
     * - a mute button that shows a fader while the pointer is on it. The panel
     * does not take focus when it opens that way, since the pointer went to it and
     * the keyboard did not; Tab from the trigger hands focus over.
     */
    openOn?: PopoverOpenOn;
    /** Accessible label for the panel when it has no heading. */
    'aria-label'?: string;
    className?: string;
    children?: ReactNode;
}
/**
 * A floating panel anchored to a trigger. The panel portals to the body so it
 * escapes overflow-clipping ancestors, flips and clamps to stay on screen, and
 * closes on outside press and Escape. This is the anchored-overlay bone that
 * menus, pickers, and rich tooltips build on.
 */
declare function Popover({ trigger, placement, open, defaultOpen, onOpenChange, openOn, className, children, ...rest }: PopoverProps): react.JSX.Element;

interface TreeItem {
    id: string;
    label: ReactNode;
    /** Leading glyph, hidden from assistive tech. */
    icon?: ReactNode;
    /** Trailing content such as a CounterBadge or Pill. */
    /**
     * Trailing content such as a CounterBadge, Pill - or a button.
     *
     * Interactive trailing content is isolated from the row: a click or key
     * press that lands on a button, link or input inside this slot does not
     * also activate the row (select it, toggle its children). A plain badge
     * keeps the old behaviour - tapping it still activates the row, so the
     * slot does not eat tap target from rows that only wear a count.
     */
    trailing?: ReactNode;
    /** Skipped by arrow navigation and unselectable. */
    disabled?: boolean;
    /** Child items; their presence makes the row an expandable parent. */
    children?: TreeItem[];
}
interface TreeViewProps extends Omit<ComponentProps<'ul'>, 'onSelect'> {
    items: TreeItem[];
    /** Controlled list of expanded parent ids. */
    expandedIds?: string[];
    /** Initially expanded parent ids when uncontrolled. */
    defaultExpandedIds?: string[];
    onExpandedChange?: (expandedIds: string[]) => void;
    /** Controlled selected row id (single-select). */
    selectedId?: string;
    /** Initially selected row id when uncontrolled. */
    defaultSelectedId?: string;
    onSelect?: (id: string) => void;
    /** Accessible name for the tree. Required: a tree without a name is a maze. */
    'aria-label': string;
    /** Renders the frosted glass material behind the tree. */
    glass?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
}
/**
 * A hierarchical list of expandable rows following the WAI-ARIA tree pattern:
 * a role="tree" of nested role="treeitem" rows with role="group" branches,
 * one roving tabindex across the visible rows. Arrow keys walk the visible
 * rows (Down/Up), expand or descend (Right), collapse or ascend (Left);
 * Home and End jump to the extremes; Enter and Space select, also toggling
 * parent rows. Branches animate open and closed, and the selected row wears
 * the accent soft tint like an active SidebarItem.
 */
declare function TreeView({ items, expandedIds, defaultExpandedIds, onExpandedChange, selectedId, defaultSelectedId, onSelect, glass, skeleton, className, 'aria-label': ariaLabel, ...rest }: TreeViewProps): react.JSX.Element;

interface Point {
    x: number;
    y: number;
}
interface FloatingPanelProps {
    /** Whether the panel is shown. */
    open: boolean;
    /** Panel title, rendered in the drag handle bar. */
    title: ReactNode;
    /** Called when the user dismisses via the close button or Escape. */
    onClose: () => void;
    /** Initial top-left position in viewport pixels. */
    defaultPosition?: Point;
    /** Extra class names merged onto the panel. */
    className?: string;
    /** Panel body content. */
    children?: ReactNode;
}
/**
 * A draggable, dismissable NON-modal floating panel. A glass Surface portalled
 * to the body with a header grab-bar you drag to move it (pointer events), a
 * title, and a close button. Its position is clamped to the viewport so it can
 * never be dragged fully off-screen. Unlike Modal it does not lock scroll, trap
 * focus, or render an overlay - it floats above the page and lets you keep
 * working underneath.
 */
declare function FloatingPanel({ open, title, onClose, defaultPosition, className, children, }: FloatingPanelProps): react.ReactPortal | null;

interface TabbedPanelTab {
    id: string;
    label: ReactNode;
    /** Optional count rendered as a CounterBadge on the tab. */
    count?: number;
    content: ReactNode;
    disabled?: boolean;
}
interface TabbedPanelProps extends ComponentProps<'div'> {
    tabs: TabbedPanelTab[];
    /** Controlled active tab id. */
    value?: string;
    /** Initial active tab id when uncontrolled. */
    defaultValue?: string;
    onValueChange?: (id: string) => void;
    /** Actions rendered at the end of the header row, e.g. a Button or Menu. */
    actions?: ReactNode;
    /** Accessible name for the tab list. */
    'aria-label'?: string;
    className?: string;
}
/**
 * A framed panel with a header row of tabs and a bounded content body that
 * switches per active tab. Each tab may carry a numeric count as a
 * CounterBadge, and the header has an optional end slot for actions. Follows
 * the WAI-ARIA tabs pattern with automatic activation: a role="tablist" of
 * role="tab" buttons drives a role="tabpanel" body. Arrow keys move and
 * activate the tabs (wrapping, skipping disabled), Home and End jump to the
 * extremes.
 */
declare function TabbedPanel({ tabs, value, defaultValue, onValueChange, actions, className, 'aria-label': ariaLabel, ...rest }: TabbedPanelProps): react.JSX.Element;

interface TabbedModalSection {
    /** Stable identifier for the section, matched against `value`. */
    id: string;
    /** Section navigation label. */
    label: ReactNode;
    /** Optional leading glyph in the nav rail. */
    icon?: ReactNode;
    /** Body shown in the scrollable pane when this section is active. */
    content: ReactNode;
    /** Dims the rail entry and skips it in navigation. */
    disabled?: boolean;
}
interface TabbedModalProps {
    open: boolean;
    /** Called when the user dismisses via Escape, the close button, or the overlay. */
    onClose: () => void;
    /** Sections listed in the responsive tab navigation; the active one fills the content pane. */
    sections: TabbedModalSection[];
    /** Controlled active section id. */
    value?: string;
    /** Initial active section id when uncontrolled. */
    defaultValue?: string;
    /** Called with the next active section id. */
    onValueChange?: (value: string) => void;
    /** Heading shown above the two panes. */
    title?: ReactNode;
    /** Action row passed through to the underlying Modal, below both panes. */
    footer?: ReactNode;
    /**
     * The hairline between the nav rail and the pane. On by default; turn it off
     * where the sections are few enough to read as one surface without a rule
     * splitting them.
     */
    divider?: boolean;
    className?: string;
}
/**
 * A settings-style dialog with section tabs and a scrollable active pane. It
 * composes the kit's Modal, inheriting its portal, focus trap, scroll lock, and
 * dismiss behaviour. The WAI-ARIA tablist is a vertical rail on wide screens
 * and a horizontal strip on narrow screens; Up/Down or Left/Right move and
 * activate tabs respectively, while Home and End jump to the ends.
 */
declare function TabbedModal({ open, onClose, sections, value, defaultValue, onValueChange, title, footer, divider, className, }: TabbedModalProps): react.JSX.Element;

interface TabStripItem {
    /** Stable identity of the tab; also the value reported by onValueChange. */
    id: string;
    /** Visible label. */
    label: ReactNode;
    /** Optional leading glyph. */
    icon?: ReactNode;
}
interface TabStripProps extends ComponentProps<'div'> {
    tabs: TabStripItem[];
    /** Controlled active tab id. */
    value?: string;
    /** Initial active tab id when uncontrolled; defaults to the first tab. */
    defaultValue?: string;
    /** Called with the id of the tab that becomes active. */
    onValueChange?: (id: string) => void;
    /** Called with the id of the tab whose close button is pressed. */
    onClose?: (id: string) => void;
    /** Spring preset for the active indicator. Defaults to Spring.Snappy. */
    spring?: Spring;
    /** Shows the horizontal scrollbar beneath overflowing tabs. Hidden by default so the baseline hairline stays flush with the tabs. */
    showScrollbar?: boolean;
    /** Accessible name for the strip. */
    'aria-label'?: string;
    className?: string;
}
/**
 * A horizontal strip of closable document tabs, like editor or browser tabs.
 * The active tab carries a springing underline indicator (a shared
 * framer-motion layout element), the strip scrolls horizontally when the tabs
 * overflow, and each tab has its own close (×) button. Left/Right move the
 * active tab; Delete or Backspace closes the focused tab.
 *
 * Reordering by drag is out of scope for v1.
 */
declare function TabStrip({ tabs, value, defaultValue, onValueChange, onClose, spring, showScrollbar, className, 'aria-label': ariaLabel, ...rest }: TabStripProps): react.JSX.Element;

type SplitOrientation = 'horizontal' | 'vertical';
interface ResizableSplitPaneProps extends Omit<ComponentProps<'div'>, 'children'> {
    /** Exactly two children: the start pane and the end pane. */
    children: [ReactNode, ReactNode];
    /**
     * Split direction. `horizontal` places the panes side by side with a vertical
     * divider; `vertical` stacks them with a horizontal divider.
     */
    orientation?: SplitOrientation;
    /** Controlled size of the start pane as a fraction of the container, 0–1. */
    ratio?: number;
    /** Initial start-pane fraction when uncontrolled. */
    defaultRatio?: number;
    /** Called with the next ratio on drag, keyboard step, or reset. */
    onRatioChange?: (ratio: number) => void;
    /** Smallest start-pane fraction the divider can reach. */
    min?: number;
    /** Largest start-pane fraction the divider can reach. */
    max?: number;
    /** Fraction the divider snaps back to on double-click. Defaults to `defaultRatio`. */
    resetRatio?: number;
    /** Fraction the divider moves per arrow-key press. */
    step?: number;
    /** Accessible name for the divider. */
    'aria-label'?: string;
    className?: string;
}
/**
 * A container that splits into two panes with a draggable divider. It hosts
 * exactly two children - a start pane and an end pane - and sizes the start pane
 * by a ratio of the container. The divider is a `role="separator"` handle:
 * drag it with a pointer, nudge it with the arrow keys, or double-click to reset.
 * The ratio is controlled-or-uncontrolled, so a consumer can persist it.
 */
declare function ResizableSplitPane({ children, orientation, ratio, defaultRatio, onRatioChange, min, max, resetRatio, step, className, style, 'aria-label': ariaLabel, ...rest }: ResizableSplitPaneProps): react.JSX.Element;

interface TableColumn {
    key: string;
    header: ReactNode;
    align?: 'left' | 'center' | 'right';
    render?: (row: Record<string, unknown>, index: number) => ReactNode;
}
interface TableProps extends Omit<ComponentProps<'table'>, 'children'> {
    columns: TableColumn[];
    data: Record<string, unknown>[];
    caption?: ReactNode;
    emptyState?: ReactNode;
}
declare function Table({ columns, data, caption, emptyState, className, ...rest }: TableProps): react.JSX.Element;

/** The semantic color family a marker can wear. */
type TimelineTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
interface TimelineItem {
    /** Stable identity (string or number) for the event. */
    id: string | number;
    /** The event headline. */
    title: ReactNode;
    /** Body copy under the header row. */
    description?: ReactNode;
    /** Muted time slot at the end of the header row; pass a <time> element for machine-readable dates. */
    timestamp?: ReactNode;
    /** Avatar or name slot composed by the consumer, leading the header row. */
    actor?: ReactNode;
    /** Glyph inside the marker dot; falls back to a plain dot. */
    icon?: ReactNode;
    /** Colors the marker. Defaults to neutral. */
    tone?: TimelineTone;
    /** Optional media or preview block under the description. */
    media?: ReactNode;
    /** Optional action row of small buttons or links. */
    actions?: ReactNode;
}
interface TimelineProps extends Omit<ComponentProps<'ol'>, 'children'> {
    /** The events, in reading order: the DOM order is the chronological order you choose. */
    items: TimelineItem[];
    /** Accessible name for the feed. Required: a feed without a name is just a list. */
    'aria-label': string;
    /** Vertical rhythm; compact trims the space between events. */
    density?: 'comfortable' | 'compact';
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** How many placeholder rows the skeleton draws. */
    skeletonCount?: number;
}
/**
 * A vertical activity feed: a semantic ordered list of events, each with a
 * tone-colored marker on a connector rail and a content column of header
 * (actor, title, timestamp), description, media, and actions. The DOM order
 * is the reading order - pass items newest-first or oldest-first and the
 * ordered-list semantics carry that chronology to assistive tech. Markers
 * and connectors are decorative; all meaning lives in the content column.
 */
declare function Timeline({ items, 'aria-label': ariaLabel, density, skeleton, skeletonCount, className, ...rest }: TimelineProps): react.JSX.Element;

type TimelineScrubberMarkerTone = (typeof timelineScrubberMarkerTones)[number];
interface TimelineScrubberMarker {
    /** Epoch milliseconds; clamped into the window. */
    time: number;
    /** Tick color family. Defaults to neutral. */
    tone?: TimelineScrubberMarkerTone;
    /** Accessible description of the event, surfaced as the tick tooltip. */
    label?: string;
}
interface TimelineScrubberProps extends Omit<ComponentProps<'div'>, 'onChange'> {
    /** Window start, epoch milliseconds. */
    start: number;
    /** Window end, epoch milliseconds. While live this is "now" and advances as new samples arrive. */
    end: number;
    /** The inspected time. Omit to pin the playhead to the live edge. */
    value?: number;
    /** Called with the scrubbed time as the playhead moves, or null when the user returns to live. */
    onChange?: (time: number | null) => void;
    /** Optional normalized 0-1 context series rendered as the track backdrop. */
    activity?: number[];
    /** Flagged instants drawn as thin ticks over the track. */
    markers?: TimelineScrubberMarker[];
    /** Arrow-key step in milliseconds; PageUp/PageDown move by ten steps. */
    step?: number;
    /** Formats a timestamp for the readout, the ticks, and aria-valuetext. */
    formatTime?: (time: number) => string;
    /** Track height step. The handle adds its overhang above the track. */
    size?: 'sm' | 'md';
    /** Renders the track on the frosted glass material. */
    glass?: boolean;
    /** Blocks scrubbing and dims the control. */
    disabled?: boolean;
    /** Renders a placeholder with the exact geometry. */
    skeleton?: boolean;
    /** Accessible name for the scrubber. */
    'aria-label': string;
}
/**
 * A flight-recorder control: a horizontal band over a recorded time window
 * with an activity backdrop, event markers, and a draggable playhead. Scrub
 * to inspect any recorded moment, or pin the playhead to the live edge and
 * let new time stream in. Controlled: `value` is the inspected time (omit for
 * live) and `onChange` reports scrubs, with null meaning "back to live".
 */
declare function TimelineScrubber({ start, end, value, onChange, activity, markers, step, formatTime, size, glass, disabled, skeleton, className, 'aria-label': ariaLabel, ...rest }: TimelineScrubberProps): react.JSX.Element;

type ChartSeriesTone = (typeof chartSeriesTones)[number];
type TimeSeriesChartShape = (typeof timeSeriesChartShapes)[number];
interface TimeSeriesChartSeries {
    /** Stable identity; keeps color and toggle state across data updates. */
    id: string;
    /** Name shown in the legend and readout. */
    label: string;
    /** The samples, aligned index-for-index with times. */
    values: (number | null)[];
    /** Ink assignment. Defaults to the fixed categorical order by position. */
    tone?: ChartSeriesTone;
}
interface TimeSeriesChartProps extends ComponentProps<'div'> {
    /** The shared time axis in epoch milliseconds, oldest first. */
    times: number[];
    /** The plotted series. Keep it to a handful; roll the tail into an "other" series in gray. */
    series: TimeSeriesChartSeries[];
    /** Thin lines, or lines over a translucent soft fill. */
    shape?: TimeSeriesChartShape;
    /** Fixed lower bound of the value axis. Defaults to 0. */
    min?: number;
    /** Fixed upper bound of the value axis. Defaults to the data maximum. */
    max?: number;
    /** Formats a value for the y axis and the readout. Defaults to a compact number. */
    formatValue?: (value: number) => string;
    /** Formats a timestamp for the x axis and the readout. */
    formatTime?: (time: number) => string;
    /** Shows the legend when two or more series are plotted. */
    showLegend?: boolean;
    /** Plot height as a CSS length; the width is fluid and follows the container. */
    height?: string;
    /** Message shown while times is empty. */
    emptyLabel?: string;
    /** Frames the plot on the frosted glass material. */
    glass?: boolean;
    /** Renders a placeholder with the exact geometry. */
    skeleton?: boolean;
    /** Accessible name describing what the chart plots. */
    'aria-label': string;
}
/**
 * A streaming time-series plot for telemetry: one shared time axis, a handful
 * of series as thin lines or soft areas, a crosshair with a value readout on
 * hover, and a legend that never repaints survivors when series toggle.
 * Canvas-rendered via uPlot, so a one-second feed stays cheap. Series colors
 * follow the fixed categorical order from the spec (never cycled, never
 * re-ranked); pin `max` (e.g. 100 for percentages) so frames share one scale.
 */
declare function TimeSeriesChart({ times, series, shape, min, max, formatValue, formatTime, showLegend, height, emptyLabel, glass, skeleton, className, 'aria-label': ariaLabel, ...rest }: TimeSeriesChartProps): react.JSX.Element;

/** A row's stable identity. Every row must carry an `id`. */
type DataGridRowId = string | number;
/** The minimum shape a row must satisfy: an `id` plus arbitrary column values. */
interface DataGridRow {
    id: DataGridRowId;
    [key: string]: unknown;
}
type SortDirection = 'asc' | 'desc';
/** The active sort: which column and which direction, or null for unsorted. */
interface DataGridSort {
    columnKey: string;
    direction: SortDirection;
}
interface DataGridColumn {
    /** Matches a key on each row, and identifies the column for sorting. */
    key: string;
    /** Header content. */
    header: ReactNode;
    /** Cell text alignment. Defaults to start. */
    align?: 'start' | 'center' | 'end';
    /** When true, the header becomes an activatable sort control. */
    sortable?: boolean;
    /** A fixed or minimum column width, e.g. '12rem'. */
    width?: string;
    /** Custom cell renderer. Defaults to String(row[key]). */
    render?: (row: DataGridRow, rowIndex: number) => ReactNode;
    /** Custom comparable value for sorting. Defaults to row[key]. */
    sortValue?: (row: DataGridRow) => string | number;
}
interface DataGridProps extends Omit<ComponentProps<'div'>, 'onSelect'> {
    columns: DataGridColumn[];
    data: DataGridRow[];
    /** Accessible name for the grid. */
    'aria-label'?: string;
    sort?: DataGridSort | null;
    defaultSort?: DataGridSort | null;
    onSortChange?: (sort: DataGridSort | null) => void;
    /** Skip built-in client sorting; report sort changes and render data as given. */
    manualSort?: boolean;
    /** Render a leading checkbox column with select-all in the header. */
    selectable?: boolean;
    selectedIds?: DataGridRowId[];
    defaultSelectedIds?: DataGridRowId[];
    onSelectionChange?: (ids: DataGridRowId[]) => void; /** Called with a row's id when it is clicked or Enter opens it. */
    onRowActivate?: (id: DataGridRowId) => void;
    loading?: boolean;
    loadingRows?: number;
    emptyState?: ReactNode;
    density?: 'comfortable' | 'compact';
    stickyHeader?: boolean;
    /** Cap the body height and scroll vertically; pairs with stickyHeader. */
    maxHeight?: string;
    skeleton?: boolean;
}
/**
 * A data grid: column-driven table with client sorting, row selection,
 * loading and empty states, responsive overflow, and a roving-focus keyboard
 * grid. Distinct from Table, which is a static semantic table with no
 * interaction model. For very large datasets, pair with a windowing layer
 * (feed only the visible slice as `data` and drive `sort`/`selectedIds`
 * yourself with `manualSort`).
 */
declare function DataGrid({ columns, data, 'aria-label': ariaLabel, sort: controlledSort, defaultSort, onSortChange, manualSort, selectable, selectedIds: controlledSelected, defaultSelectedIds, onSelectionChange, onRowActivate, loading, loadingRows, emptyState, density, stickyHeader, maxHeight, skeleton, className, style, ...rest }: DataGridProps): react.JSX.Element;

interface WizardStep {
    /** Stable identity; keys the panel transition. */
    id: string;
    /** Step name: shown as the panel heading and used for a11y labelling. */
    label: ReactNode;
    /** The panel body for this step. */
    content: ReactNode;
    /**
     * The forward gate, run when Next/Finish is pressed on this step:
     * `true` passes; `false` blocks silently (the step's own fields display
     * their errors); a string blocks AND shows that message in the wizard's
     * error live region. May return a Promise of the same: Next shows its
     * loading state and the footer is inert until it settles; a rejection is
     * treated as a silent block.
     */
    validate?: () => boolean | string | Promise<boolean | string>;
}
interface WizardProps extends Omit<ComponentProps<'div'>, 'children'> {
    steps: WizardStep[];
    /** Required accessible name for the wizard region. */
    'aria-label': string;
    /** Controlled zero-based index of the active step. */
    activeStep?: number;
    /** Uncontrolled start; THE resume point (default 0). */
    defaultActiveStep?: number;
    /** Fires with the new index on every committed navigation. */
    onStepChange?: (index: number) => void;
    /**
     * Save callback: fires with the index being LEFT when its gate passes on
     * forward navigation. The parent persists it; resume via defaultActiveStep.
     */
    onSave?: (index: number) => void;
    /** Finish pressed on the last step and its gate passed. */
    onComplete?: () => void;
    /** Defaults to the localized kit Previous message. */
    previousLabel?: ReactNode;
    /** Defaults to the localized kit Next message. */
    nextLabel?: ReactNode;
    /** Defaults to the localized kit Done message. */
    finishLabel?: ReactNode;
    /** Heading element for the step label. */
    headingLevel?: 2 | 3;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
}
/**
 * A stepped flow: the connected Steps header, one step panel at a time, and a
 * gated footer. Next runs the active step's validate before advancing (and
 * fires onSave for the step being left); Previous always returns ungated.
 * A blocking message from the gate is voiced by a polite live region, and
 * every committed navigation moves focus to the new panel.
 */
declare function Wizard({ steps, 'aria-label': ariaLabel, activeStep, defaultActiveStep, onStepChange, onSave, onComplete, previousLabel, nextLabel, finishLabel, headingLevel, skeleton, className, ...rest }: WizardProps): react.JSX.Element;

/**
 * The translation mandate.
 *
 * A message is not a string; it is a string for EVERY supported locale. Because
 * `Message` is `Record<Locale, string>`, an object literal that omits a locale
 * fails to compile. Add a locale to `locales` and every message in the codebase
 * turns red until it is translated, so a new language can never ship
 * half-translated and a new string can never skip a language.
 */
/**
 * Every locale the app ships strings for. This is the single source of truth:
 * widen it and TypeScript forces a translation for the new locale everywhere.
 *
 * It starts with a single base locale on purpose. That is enough to wire every
 * component through the translator and ban plain strings; the day a second
 * locale is added here, every message in the codebase fails to compile until it
 * is translated. Rename or add to this tuple to choose the languages.
 */
declare const locales: readonly ["en", "es", "fr", "de", "ja", "pt", "zh", "ar"];
type Locale = (typeof locales)[number];
/** The locale used when no LocaleProvider is present. */
declare const DEFAULT_LOCALE: Locale;
/** Locales written right to left. */
declare const rtlLocales: ReadonlySet<Locale>;
/** The writing direction for a locale, for the html dir attribute. */
declare function direction(locale: Locale): 'ltr' | 'rtl';
/**
 * One translated string, mandated across all locales. Omitting any locale is a
 * compile error: `Property 'xx' is missing in type ... but required in Message`.
 */
type Message = Record<Locale, string>;
/** A catalog of named messages, each mandated across all locales. */
type MessageCatalog<K extends string = string> = Record<K, Message>;
/**
 * Defines a message catalog. The generic pins every value to `Message`, so a
 * catalog with a message missing a locale fails to compile at the call site,
 * while preserving the exact keys for `t(messages.someKey)` autocomplete.
 *
 * `const m = defineMessages({ save: { en: 'Save', es: 'Guardar' } })`
 */
declare function defineMessages<T extends MessageCatalog>(catalog: T): T;
/** Interpolates `{name}` placeholders in a resolved string. */
declare function format(template: string, params?: Record<string, string | number>): string;

/** The translator: resolves a message to the active locale, with interpolation. */
type Translate = (message: Message, params?: Record<string, string | number>) => string;
interface LocaleProviderProps {
    locale: Locale;
    children: ReactNode;
}
/**
 * Sets the active locale for everything inside it. Kit components read it
 * through useT; without a provider they fall back to DEFAULT_LOCALE, so the kit
 * works untranslated out of the box.
 */
declare function LocaleProvider({ locale, children }: LocaleProviderProps): react.JSX.Element;
/** The active locale. */
declare function useLocale(): Locale;
/**
 * Returns the translator bound to the active locale. Call it with a message
 * object: `const t = useT(); t(messages.dismiss)`. Because a message must carry
 * every locale by type, there is nothing to miss at the call site.
 */
declare function useT(): Translate;

/**
 * The kit's own user-facing strings, the ones baked into components (mostly
 * aria-labels on close, dismiss, and stepper controls). Routing them through a
 * catalog means every consuming app inherits real translations instead of
 * hardcoded English, and adding a locale forces translating all of them.
 *
 * These are the exact strings the audit found hardcoded across the kit.
 */
declare const kitMessages: {
    dismiss: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    close: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    cancel: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    closeTour: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    previous: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    next: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    announcements: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    announcementsUpdates: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    announcementsPrevious: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    announcementsNext: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    announcementsPause: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    announcementsResume: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    announcementsPosition: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarPrevious: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarNext: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarToday: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarViewLabel: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarMonth: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarWeek: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarAgenda: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarMore: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarEmpty: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarAddEvent: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarEditEvent: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarSaveEvent: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarDeleteEvent: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarEventTitle: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarEventDate: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarStartTime: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarEndTime: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarAllDay: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarEventTone: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarFieldRequired: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarFieldInvalid: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarEndBeforeStart: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarToneInfoNote: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarTone_accent: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarTone_success: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarTone_warning: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarTone_danger: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarTone_info: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    calendarTone_neutral: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    cardFan: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    sortableHandle: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    sortableLifted: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    sortableMoved: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    sortableDropped: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    sortableCancelled: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    editorToolbar: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    editorBold: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    editorItalic: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    editorCode: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    editorStrike: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    editorHeading: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    editorQuote: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    editorBullet: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    editorNumber: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    colorPicker: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    colorLightness: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    colorChroma: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    colorHue: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    colorAlpha: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    colorHex: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    colorPresets: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    colorOutOfGamut: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    commandPaletteLabel: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    commandPalettePlaceholder: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    commandPaletteEmpty: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    commandPaletteHint: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    clearSearch: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    oneTimeCode: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    decrease: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    increase: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    openNavigation: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    closeNavigation: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    resizeSidebar: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    loading: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    noOptions: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    copy: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    copied: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    back: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    done: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    less: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    more: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    densityExtraCompact: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    densityCompact: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    densityDefault: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    densityComfortable: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    densityMoreSpace: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    /** Parameterized: t(kitMessages.stepOf, { step, total }). */
    stepOf: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarLabel: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarPlaceholder: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarSend: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarAttach: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarAttachments: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    /** Parameterized: t(kitMessages.messageBarRemoveAttachment, { name }). */
    messageBarRemoveAttachment: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarHintEnter: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    /** Parameterized: t(kitMessages.messageBarHintModifier, { modifier }). */
    messageBarHintModifier: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    /** Parameterized: t(kitMessages.messageBarReplyingTo, { name }). */
    messageBarReplyingTo: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarReplying: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarCancelReply: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarEditing: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarCancelEdit: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    /** Parameterized: t(kitMessages.messageBarCount, { count, max }). */
    messageBarCount: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    /** Parameterized: t(kitMessages.messageBarRemaining, { remaining }). */
    messageBarRemaining: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    /** Parameterized: t(kitMessages.messageBarOver, { over }). */
    messageBarOver: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarKeyEnter: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarKeyShift: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarTypingOne: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarTypingTwo: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarTypingSeveral: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageBarTypingMany: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    /** Parameterized: t(kitMessages.messageReadAt, { time }). */
    messageReadAt: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageReadByOne: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageReadByTwo: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageReadBySeveral: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    messageReadByMany: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    conversationUnread: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
    /** Parameterized: t(kitMessages.conversationUnreadCount, { count }). */
    conversationUnreadCount: {
        en: string;
        es: string;
        fr: string;
        de: string;
        ja: string;
        pt: string;
        zh: string;
        ar: string;
    };
};
type KitMessageKey = keyof typeof kitMessages;

/**
 * Web haptics, best-effort and gracefully degrading.
 *
 * The web platform has no rich haptic API. What exists:
 *   - Android (Chrome, Firefox): navigator.vibrate() buzzes the device motor.
 *     There is no light/medium/heavy taptic, so intensity is approximated with
 *     short durations and patterns.
 *   - iOS Safari 17.4+: no navigator.vibrate, but toggling a hidden
 *     <input switch> pulses the Taptic Engine. A single fixed tap, no intensity.
 *   - Everywhere else (desktop): a no-op.
 *
 * Rich impact haptics only exist in a native shell (React Native, Capacitor, a
 * Tauri plugin). HapticsProvider accepts an `impl` so such a shell can replace
 * this web engine with real haptics without any call site changing.
 */
type HapticKind = 'selection' | 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';
/** Turn the web haptic engine on or off. HapticsProvider drives this. */
declare function setHapticsEnabled(next: boolean): void;
declare function hapticsEnabled(): boolean;
/**
 * Fire feedback of the given kind: buzz the motor (when haptics are enabled)
 * and announce it on the shared bus so the visual-feedback layer can react in
 * the same frame. This is the programmatic entry point - what useHaptics()
 * returns and what components call directly - so a single call keeps taptic and
 * shockwave in lockstep. Safe to call anywhere.
 */
declare function haptic(kind?: HapticKind): void;
type HapticFn = (kind?: HapticKind) => void;

/** The haptic fire function from the nearest provider, else the web engine. */
declare const useHaptics: () => HapticFn;
interface HapticsProviderProps {
    /** Master switch, wired to a user preference. Off by default. */
    enabled?: boolean;
    /**
     * Replaces the web engine, e.g. a native shell passing its own haptics so the
     * kit fires real impact feedback instead of navigator.vibrate.
     */
    impl?: HapticFn;
    children: ReactNode;
}
/**
 * Enables haptic feedback for every touch press under it via one delegated
 * pointerdown listener, so no component needs wiring. Mouse and pen are ignored
 * (no motor), and it is a clean no-op where the platform cannot vibrate.
 *
 * The hook it exposes (useHaptics) also announces each fire on the shared
 * feedback bus, so a VisualFeedbackProvider can paint a matching effect in the
 * same frame. Delegated presses stay off the bus - the visual layer watches
 * presses through its own listener - so the two never double up.
 */
declare function HapticsProvider({ enabled, impl, children }: HapticsProviderProps): react.JSX.Element;

/** The on-screen effect a press paints. */
type VisualFeedbackVariant = 'shockwave' | 'pulse' | 'glow' | 'nudge';
/** How far the effect carries. Subtle by default: this is background texture. */
type VisualFeedbackIntensity = 'subtle' | 'normal' | 'strong';
/** Trigger an effect by hand, in addition to the automatic press feedback. */
type VisualFeedbackFn = (kind?: HapticKind, origin?: {
    x: number;
    y: number;
}) => void;
/** Fire a visual effect by hand from the nearest provider (a no-op with none). */
declare const useVisualFeedback: () => VisualFeedbackFn;
interface VisualFeedbackProviderProps {
    /** Master switch, wired to a user preference. Off by default. */
    enabled?: boolean;
    /** The effect style. Defaults to shockwave (a ring from the press point). */
    variant?: VisualFeedbackVariant;
    /** How far the effect carries. Defaults to subtle. */
    intensity?: VisualFeedbackIntensity;
    children: ReactNode;
}
/**
 * Paints subtle on-screen feedback for every press, in lockstep with the device
 * haptics. Where HapticsProvider buzzes the motor, this draws a shockwave, a
 * tinted pulse, an edge glow, or a whole-screen nudge, colored by the press's
 * semantic kind. It works for every pointer type (so it is the desktop stand-in
 * for haptics), fires programmatic feedback through the shared bus so a
 * haptic('success') lands a matching effect, and collapses to a still color cue
 * under prefers-reduced-motion. Off by default; gate it behind a preference.
 */
declare function VisualFeedbackProvider({ enabled, variant, intensity, children, }: VisualFeedbackProviderProps): react.JSX.Element;

/**
 * The shared feedback bus.
 *
 * Feedback in the kit is one intent - "a control was pressed" or "something
 * semantic just happened" - that two independent consumers can react to: the
 * haptic engine buzzes the device, and the visual-feedback layer paints a
 * subtle on-screen effect. Routing programmatic feedback through this bus is
 * what lets the two fire in lockstep: a single haptic('success') call reaches
 * both, so the shockwave lands on the same frame as the taptic.
 *
 * Pointer presses do NOT go through the bus. Each consumer installs its own
 * delegated listener so it can apply its own rules (haptics is touch-only and
 * needs no coordinates; visual feedback fires for every pointer type and wants
 * the press point for spatial effects). The bus carries only the programmatic
 * path, keeping the two press listeners from double-firing each other.
 */
interface FeedbackEvent {
    /** The semantic kind, reused from the haptic vocabulary. */
    kind: HapticKind;
    /** Viewport origin for spatial effects. Absent for programmatic feedback, which centers. */
    x?: number;
    y?: number;
}
type Listener = (event: FeedbackEvent) => void;
/** Subscribe to programmatic feedback. Returns an unsubscribe function. */
declare function subscribeFeedback(listener: Listener): () => void;
/** Notify every subscriber. Cheap no-op when nothing is listening. */
declare function emitFeedback(event: FeedbackEvent): void;

/**
 * The kit's light-animation utilities: class names you drop on any element.
 *
 * - `riseIn` - the staggerable entrance. Pair with staggerVars(i) on each item.
 * - `shimmer` - a highlight travelling across the element, looping.
 * - `glowPulse` - the accent halo breathing, looping.
 *
 * Every one of them rests on its FINISHED frame, and the two loops only run
 * under prefers-reduced-motion: no-preference. See fx.module.css for the full
 * reduced-motion policy.
 */
declare const fx: {
    readonly riseIn: string | undefined;
    readonly shimmer: string | undefined;
    readonly glowPulse: string | undefined;
};
type FxName = keyof typeof fx;
/**
 * The per-item stagger index, as an inline style. The delay itself is
 * `index x --glacier-stagger-step`, so the whole cascade retunes from one token
 * and collapses with it under reduced motion.
 *
 * ```tsx
 * items.map((item, i) => <Card key={item.id} className={fx.riseIn} style={staggerVars(i)} />)
 * ```
 */
declare function staggerVars(index: number): CSSProperties;

type DeliveryStatusSize = 'sm' | 'md';
interface DeliveryStatusProps extends Omit<ComponentProps<'span'>, 'children'> {
    /** How far the message got. */
    status?: DeliveryStatus$1;
    /**
     * A run's states, collapsed with `leastDelivery` to the least advanced of
     * them - so a stack holding one failed send says failed rather than claiming
     * the "read" of whichever message happened to be last. Ignored when `status`
     * is set.
     */
    statuses?: (DeliveryStatus$1 | undefined)[];
    size?: DeliveryStatusSize;
    /** Overrides the text alternative; defaults to the status's own name. */
    label?: string;
    /**
     * Hides the glyph from assistive tech. Only for a bubble whose own accessible
     * name already reports the state - otherwise the mark is unreadable to anyone
     * not looking at it.
     */
    decorative?: boolean;
    /** Renders a placeholder with the component's exact geometry. */
    skeleton?: boolean;
    /** Overrides the status words; merged over the kit's translations. */
    labels?: Partial<DeliveryLabels>;
}
/**
 * How far a sent message got, as one small mark beside its timestamp.
 *
 * The rule the whole component exists to hold: **no two states share a
 * silhouette.** A clock, one tick, two ticks, a tick inside a solid disc, a
 * warning triangle. It would be easier to draw "delivered" and "read" as the
 * same double tick in two colours - most chat apps do - but this is the
 * smallest element in a transcript, about the height of a lowercase letter, and
 * that is precisely the size at which hue stops carrying meaning: a colour-blind
 * reader, a monochrome display, or a phone in sunlight all reduce it to the same
 * grey mark. Shape survives all three. Colour is layered on top for the two
 * states worth spending it on, never underneath as the only signal.
 *
 * It is `role="img"` with a label naming the state, not a live region: a
 * transcript holds hundreds of these, and hundreds of live regions would re-read
 * the conversation every time a receipt landed.
 *
 * Retrying a failed send belongs to the bubble, not here - the mark reports, it
 * never acts, so it never becomes a tap target the size of a letter.
 */
declare function DeliveryStatus({ status, statuses, size, label, decorative, skeleton, labels, className, ...rest }: DeliveryStatusProps): react.JSX.Element | null;

interface TypingIndicatorProps extends Omit<ComponentProps<'div'>, 'children'> {
    /** Who is typing, as display names. */
    names: string[];
    /** How many names the row has room for. */
    max?: number;
    /** Draws the animated dots beside the sentence. */
    dots?: boolean;
    /** Translated sentences, one per shape, merged over the kit catalog. */
    templates?: Partial<TypingTemplates>;
    /** Renders a placeholder at the row's exact height. */
    skeleton?: boolean;
}
/**
 * The row that says who is typing.
 *
 * It takes names, never a sentence. "Ana and Bo are typing" is three
 * translation problems at once - the conjunction, the verb agreement, and the
 * word order, none of which survive a naive join in Japanese or Arabic - so the
 * count chooses a template in @glacier/logic and the catalog supplies the
 * words. `Intl.ListFormat` joins the names, because joining a list is itself
 * locale work.
 *
 * Nobody typing renders nothing at all rather than an empty line: a row that
 * reserved its height would make the composer jump by a line every time someone
 * paused, which is the most distracting thing a typing indicator can do.
 */
declare function TypingIndicator({ names, max, dots, templates, skeleton, className, style, ...rest }: TypingIndicatorProps): react.JSX.Element | null;

type ComposerSubmitMode = (typeof composerSubmitModes)[number];
type DraftCountMode = (typeof draftCountModes)[number];

/** What a replaced send control is told, so it stays as correct as the default. */
interface MessageBarState {
    /** The draft as typed, untrimmed. */
    text: string;
    /** The single authority, the same one the key handler consults. */
    canSend: boolean;
    busy: boolean;
    disabled: boolean;
    submitMode: ComposerSubmitMode;
    /**
     * The draft against its budget. With no `maxLength` the draft is not counted
     * at all - counting graphemes on every keystroke to answer a question nobody
     * asked is waste - so `count` reads 0 and `state` reads `idle`.
     */
    meter: DraftMeter;
    attachments: ChatAttachment[];
    /** Sends, if it can. Calling it when `canSend` is false does nothing. */
    send: () => void;
}
/** What a staged-attachment renderer is told about the file it is drawing. */
interface StagedAttachmentContext {
    attachment: ChatAttachment;
    /** Resolved through `attachmentKind`, so a staged voice note and a sent one agree. */
    kind: AttachmentKind;
    index: number;
    /** Unstages this file. Wired to the caller's `onAttachmentsChange`. */
    remove: () => void;
}
interface MessageBarLabels {
    placeholder: string;
    send: string;
    attach: string;
    cancelReply: string;
    cancelEdit: string;
}
interface MessageBarProps extends Omit<ComponentProps<'div'>, 'onSubmit' | 'children' | 'defaultValue'> {
    /** The draft, controlled. */
    value?: string;
    /** The initial draft when the bar owns its own state. */
    defaultValue?: string;
    /** Called with the next draft on every edit. */
    onValueChange?: (next: string) => void;
    /** Called with the trimmed text, the staged files, and the reply and edit ids. */
    onSend?: (submission: ComposerSubmission) => void;
    /** Which chord sends. */
    submitMode?: ComposerSubmitMode;
    /** Empty-field prompt; defaults to the translated kit string. */
    placeholder?: string;
    /** Rows the empty field shows. */
    minRows?: number;
    /** Rows the field grows to before it scrolls. */
    maxRows?: number;
    /** The character budget. Never applied as a `maxlength`; see the component doc. */
    maxLength?: number;
    /** What counts as a character, so the counter agrees with the server. */
    countAs?: DraftCountMode;
    /** The staged attachments, controlled. */
    attachments?: ChatAttachment[];
    /** Called with the next staged list after one is added or removed. */
    onAttachmentsChange?: (next: ChatAttachment[]) => void;
    /** Draws one staged attachment; receives its resolved kind and a remover. */
    renderAttachment?: (context: StagedAttachmentContext) => ReactNode;
    /** The message being answered, resolved by `replyPreview` rather than as markup. */
    replyTo?: ReplyPreview | null;
    /** Dismisses the reply banner. Its presence is what gives Escape a meaning. */
    onCancelReply?: () => void;
    /** The message being rewritten; travels with the send as `editingId`. */
    editingId?: string;
    /** Leaves edit mode. Its presence is what gives Escape a meaning. */
    onCancelEdit?: () => void;
    /** Who is typing, as display names. Never a pre-joined sentence. */
    typing?: string[];
    /** How many typist names the row has room for. */
    typingMax?: number;
    /** A send is already in flight. */
    busy?: boolean;
    /** A closed thread: nothing is editable and nothing goes out. */
    disabled?: boolean;
    /** Replaces the send control, receiving the live state. */
    renderSend?: (state: MessageBarState) => ReactNode;
    /** The leading slot, for an attachment or media control. */
    attach?: ReactNode;
    /** The trailing slot before the send control. */
    actions?: ReactNode;
    /** Shows the submit policy as visible keys. The spoken one is always present. */
    keyboardHint?: boolean;
    /** The frosted material, for a bar pinned over a scrolling transcript. */
    glass?: boolean;
    /** Hosts the bar in a `form`. Off by default; see the component doc. */
    asForm?: boolean;
    /** Forwarded to the textarea. Its `onKeyDown` runs first and can claim a key. */
    inputProps?: Omit<ComponentProps<'textarea'>, 'value' | 'defaultValue' | 'onChange'>;
    /** Translated strings, merged over the kit catalog. */
    labels?: Partial<MessageBarLabels>;
    /** Renders a placeholder at the bar's exact geometry. */
    skeleton?: boolean;
}
/**
 * The composer at the foot of a thread.
 *
 * Almost every decision here follows from one fact: Enter sends something that
 * cannot be recalled. So the key policy lives in @glacier/logic as a pure
 * function of four booleans rather than in this file, both bindings call it,
 * and the IME guard is its first line - because while an input method is open
 * every Enter belongs to the IME, and a composer that reads one as a send fires
 * a message on the way to the first kanji of a sentence.
 *
 * Two other refusals are worth stating, because both look like features:
 *
 * **There is no `maxlength`.** The attribute blocks keystrokes, truncates a
 * paste silently, and cuts an input method off mid-word. `maxLength` here
 * counts instead - through `Intl.Segmenter` by default, so a flag is one
 * character and not four - refuses to send while over, and lets the text stand.
 * Losing the end of what someone pasted is a worse failure than a message that
 * will not go yet.
 *
 * **There is no `canSend` override.** Sendability is `composerCanSend` in
 * commons, consulted by the key handler and by the send control's own disabled
 * state, so a draft of three spaces cannot get two different answers. An
 * attachment with no caption already sends, honestly, because that function
 * knows what an attachment is.
 *
 * The host is a `div`, not a `form`. Implicit submission applies to single-line
 * inputs only, so Enter in a textarea is hand-handled under either host, and
 * the landmark is not worth an invalid nested form the first time this bar is
 * dropped inside a page form. `asForm` is there for callers who want it.
 */
declare function MessageBar({ value, defaultValue, onValueChange, onSend, submitMode, placeholder, minRows, maxRows, maxLength, countAs, attachments, onAttachmentsChange, renderAttachment, replyTo, onCancelReply, editingId, onCancelEdit, typing, typingMax, busy, disabled, renderSend, attach, actions, keyboardHint, glass, asForm, inputProps, labels, skeleton, className, style, ...rest }: MessageBarProps): react.JSX.Element;

interface MessageBubbleProps extends Omit<ComponentProps<'div'>, 'content'> {
    /** Bubble draws a tinted, edge-aligned capsule; row draws full-width prose. */
    layout?: MessageLayout;
    /** The viewer sent it. */
    own?: boolean;
    /** Where it sits in its author's run; drives the corner geometry. */
    position?: BubblePosition;
    /** Draws the tail. Only meaningful on the message that ends a run. */
    tail?: boolean;
    /** Overrides the edge authorship would choose. Logical, never physical. */
    side?: MessageSide;
    /** Rendered in the leading gutter. */
    avatar?: ReactNode;
    /**
     * Reserves the gutter without filling it, so a message whose avatar was
     * suppressed still lines up with the one above it. Defaults on in row layout,
     * where every line shares one column.
     */
    gutter?: boolean;
    /** The name and time line above the body, in row layout. */
    header?: ReactNode;
    /** When it was sent, epoch milliseconds. Renders a meta line when given. */
    at?: Millis;
    /** The instant timestamps are read against. */
    now?: Millis;
    /** BCP-47 tag for the timestamp formatter. */
    locale?: string;
    /** How far along the send is; omitted for anything received. */
    status?: DeliveryStatus$1;
    /**
     * When it was read. Drawn only on the viewer's own message: a receipt about
     * something you received says nothing, exactly as a delivery tick there does.
     */
    readAt?: Millis;
    /** Who read it, for a group thread where one tick cannot name them. */
    readBy?: MessageReader[];
    /** How many reader names the receipt line has room for. */
    readByMax?: number;
    /** Translated read-receipt sentences, one per shape. */
    receiptTemplates?: Partial<ReadReceiptTemplates>;
    /** Marks a message its author changed after sending. */
    edited?: boolean;
    /** Replaces the default timestamp and status line entirely. */
    meta?: ReactNode;
    /** Slot under the body for the reaction bar. */
    reactions?: ReactNode;
    /** Slot above the text for images, files, and media. */
    attachments?: ReactNode;
    /** Slot above the body for a quoted preview of the message being answered. */
    replyTo?: ReactNode;
    /** Translated delivery and edited words. */
    labels?: Partial<MessageLabels>;
    /** Renders a placeholder with the bubble's exact geometry. */
    skeleton?: boolean;
}
/**
 * One message, in either of the two layouts chat apps actually use.
 *
 * **Bubble** is iMessage and WhatsApp: a tinted capsule on the edge its author
 * owns, sized to its content, whose corners are decided by `bubblePosition` in
 * @glacier/logic rather than by this component. That indirection is the point.
 * A run of four messages has to read as one utterance, and it only does so if
 * the corners facing a neighbour tighten while the corners facing open space
 * stay round - so the stacked edge behaves like a single tall shape that has
 * been sliced, and the free edge keeps the silhouette that says which side of
 * the conversation it came from. Both bindings ask the same function, so a run
 * cannot break differently on a phone than it does in a browser.
 *
 * **Row** is Slack and Discord: full width, no fill, avatar in a leading gutter,
 * name and time as a header line. Alignment means nothing in a single-column
 * transcript, so the header does the work colour and position do in a bubble.
 *
 * Which edge is "mine" is expressed logically - the viewer's messages take the
 * *trailing* edge, not the right one - so an Arabic transcript mirrors as a
 * whole and the viewer's own words stay on the side their language puts them.
 * The one thing that cannot be logical is the tail's path, since SVG has no
 * writing direction; see the stylesheet for how that is inverted exactly once.
 */
declare function MessageBubble({ layout, own, position, tail, side, avatar, gutter, header, at, now, locale, status, readAt, readBy, readByMax, receiptTemplates, edited, meta, reactions, attachments, replyTo, labels, skeleton, className, style, children, ...rest }: MessageBubbleProps): react.JSX.Element;

interface MessageMetaProps extends Omit<ComponentProps<'span'>, 'children'> {
    /** The moment to print, epoch milliseconds. */
    at?: Millis;
    /**
     * The instant it is read against. Injected rather than defaulted inside the
     * formatter so a transcript, a test, and a screenshot all render the same.
     */
    now?: Millis;
    /** BCP-47 tag for the formatter; falls back to the active locale. */
    locale?: string;
    /** How much of the moment to spell out. */
    timestampStyle?: MessageTimestampStyle;
    /** One message's delivery state. */
    status?: DeliveryStatus$1;
    /**
     * A run's delivery states, collapsed with `leastDelivery` to the least
     * advanced of them - so a stack holding one failed send says failed, not
     * "read", which is what the last message in it might otherwise claim.
     */
    statuses?: (DeliveryStatus$1 | undefined)[];
    /**
     * When it was read. The tick says *that* a message was opened and this says
     * *when*, which is the difference between a status and a receipt - and the
     * fact the sender was actually waiting for.
     */
    readAt?: Millis;
    /**
     * Who read it. The only honest answer in a group thread, where one `read`
     * tick cannot say which of five people opened the message.
     */
    readBy?: MessageReader[];
    /** How many reader names the line has room for before "and N others". */
    readByMax?: number;
    /** Translated read-receipt sentences, one per shape. */
    receiptTemplates?: Partial<ReadReceiptTemplates>;
    /** Marks a message its author changed after sending. */
    edited?: boolean;
    /** Sits inside an accent-filled bubble, so the line takes the contrast colour. */
    own?: boolean;
    /**
     * Whether the timestamp reaches the accessibility tree. False where an
     * enclosing group already announced the same moment, so it is not read twice.
     */
    announceTime?: boolean;
    /** Spells the timestamp; defaults to the platform's Intl. */
    formatTimestamp?: (stamp: MessageTimestamp, locale?: string) => string;
    /** Translated delivery and edited words, merged over the English defaults. */
    labels?: Partial<MessageLabels>;
    /** Renders a placeholder at the line's exact height. */
    skeleton?: boolean;
}
/**
 * The timestamp and delivery line under a message or a run.
 *
 * It carries two things that look decorative and are not. The status is the only
 * signal that a message did not go out, so it is always paired with a written
 * word - an icon alone is unreadable to anything that is not looking at the
 * screen. And a run's status is the *least* advanced of its members rather than
 * the last one's: a stack whose final message was read still holds a failed send
 * two messages up, and reporting "read" would hide the one thing the user has to
 * act on.
 */
declare function MessageMeta({ at, now, locale, timestampStyle, status, statuses, readAt, readBy, readByMax, receiptTemplates, edited, own, announceTime, formatTimestamp, labels, skeleton, className, ...rest }: MessageMetaProps): react.JSX.Element;

export { Accordion, AlertDialog, Announcements, AppShell, AudioEqualizer, Avatar, Banner, Box, Breadcrumbs, Button, Calendar, CalendarView, Callout, Card, CardFan, CardGroup, Carousel, Center, Checkbox, CodeBlock, ColorPicker, Combobox, CommandPalette, Container, ContextMenu, ConversationView, CounterBadge, DEFAULT_LOCALE, DataGrid, DatePicker, DeliveryStatus, DensitySelector, DeviceFrame, Divider, Drawer, EmptyState, Field, Fieldset, FileUpload, FilterChip, FloatingPanel, FormSection, Grid, HapticsProvider, Heading, Heatmap, IconBackfill, IconButton, Image, Input, Kbd, Label, Link, List, ListItem, LocaleProvider, Lyrics, Menu, MenuItem, MenuLabel, MenuSeparator, MenuSub, MessageBar, MessageBubble, MessageGroup, MessageMeta, Meter, Modal, MultiSelect, NavBar, NavBarItem, NumberInput, OtpField, PageHeader, Pagination, Pill, PlayerBar, PlayerCard, Popover, ProgressBar, ProgressRing, Radio, RadioCard, Rating, ResizableSplitPane, RichTextEditor, Row, ScrollArea, ScrollbarAppearance, SearchField, Section, SeekBar, SegmentedBar, SegmentedControl, Select, Sidebar, SidebarItem, SidebarSection, Size, Skeleton, SkeletonVariant$1 as SkeletonVariant, Slider, SortableList, Spacer, Sparkline, Spinner, SplitButton, Spotlight, Stack, StatTile, StatusDot, Steps, Surface, Switch, TabStrip, TabbedModal, TabbedPanel, Table, Tabs, Text, TextTone, Textarea, TimeSeriesChart, Timeline, TimelineScrubber, TitleBar, Toast, ToastProvider, Toggle, Tone, Toolbar, Tooltip, TrackInfo, TransportControls, TreeView, TypingIndicator, Variant, VirtualList, VisualFeedbackProvider, VolumeBar, Wizard, restFocus as cardFanRestFocus, createAnalyserMeter, defineMessages, densityModes, direction, emitFeedback, format, fx, haptic, hapticsEnabled, kitMessages, locales, resolveDirection, rtlLocales, setHapticsEnabled, staggerVars, subscribeFeedback, useBeat, useDirection, useField, useHaptics, useLiveLevels, useLocale, useT, useToast, useVisualFeedback, volumeAmplitude, volumeGain };
export type { AccordionItem, AccordionProps, AlertDialogProps, AlertDialogTone, Align, AnalyserMeter, AnnouncementItem, AnnouncementMotion, AnnouncementTone, AnnouncementsProps, AppShellProps, AudioEqualizerBand, AudioEqualizerLabels, AudioEqualizerPreset, AudioEqualizerProps, AudioEqualizerSize, AvatarProps, Background, BannerProps, BannerTone, BorderToken, BoxProps, BreadcrumbItem, BreadcrumbsProps, ButtonProps, ButtonVariant, CalendarEvent, CalendarMode, CalendarProps, CalendarRange, CalendarViewMode, CalendarViewProps, CalloutProps, CalloutTone, CardFanItem, CardFanProps, CardFanSize, CardGroupDensity, CardGroupGap, CardGroupMode, CardGroupProps, CardProps, CardVariant, CarouselProps, CenterProps, ChartSeriesTone, CheckboxProps, CodeBlockProps, ColorPickerProps, ComboboxOption, ComboboxProps, CommandDescriptor, CommandPaletteProps, ComposerSubmission, ComposerSubmitMode, ContainerProps, ContainerSize, ContextMenuProps, ControlSize, ConversationViewProps, CounterBadgeProps, DataGridColumn, DataGridProps, DataGridRow, DataGridRowId, DataGridSort, DatePickerProps, DeliveryStatusProps, DeliveryStatusSize, DensityMode, DensitySelectorProps, DeviceFrameProps, DeviceFrameSize, Direction, DividerProps, DraftCountMode, DrawerProps, DrawerSide, DrawerSize, Elevation, EmptyStateProps, FeedbackEvent, FieldProps, FieldsetProps, FileUploadProps, FileUploadRejection, FileUploadRejectionReason, FilterChipProps, FloatingPanelProps, FormSectionProps, FxName, GridProps, HapticFn, HapticKind, HeadingProps, HeatmapData, HeatmapPoint, HeatmapProps, IconBackfillProps, IconButtonProps, ImageFit, ImageProps, ImageRadius, InputProps, Justify, KbdProps, KitMessageKey, LabelProps, LinkProps, ListItemProps, ListProps, ListSize, Locale, LocaleProviderProps, LoudnessMeter, LyricLine, LyricsProps, MarkdownBlock, MarkdownMark, MenuItemProps, MenuProps, MenuSubProps, Message, MessageBarLabels, MessageBarProps, MessageBarState, MessageBubbleProps, MessageCatalog, MessageGroupProps, MessageMetaProps, MessageSlotContext, MeterProps, MeterTone, ModalProps, MultiSelectOption, MultiSelectProps, NavBarItemProps, NavBarOrientation, NavBarProps, NumberInputProps, OtpFieldProps, OtpFieldType, PageHeaderAction, PageHeaderProps, PaginationProps, PillProps, PillTone, PillVariant, Placement, PlayerBarLabels, PlayerBarPosition, PlayerBarProps, PlayerCardLabels, PlayerCardProps, PlayerDensity, PlayerLayout, PlayerRepeat, PopoverProps, ProgressBarProps, ProgressRingProps, RadioCardProps, RadioProps, RadiusToken, RatingProps, ReplyPreview, ResizableSplitPaneProps, Responsive, RichTextEditorProps, RowProps, ScrollAreaOrientation, ScrollAreaProps, ScrollbarAppearanceName, SearchFieldProps, SectionDensity, SectionGap, SectionHeadingLevel, SectionProps, SeekBarFill, SeekBarProps, SeekBarRail, SeekBarShape, SeekBarTone, SegmentedBarProps, SegmentedControlProps, SegmentedOption, SelectOption, SelectProps, ShapeName, SidebarItemProps, SidebarProps, SidebarSectionProps, SkeletonProps, SliderProps, SortDirection, SortableItemLike, SortableListProps, SpacerProps, SparklineProps, SparklineShape, SparklineTone, SpinnerProps, SplitButtonProps, SplitOrientation, SpotlightProps, StackProps, StagedAttachmentContext, StatTileProps, StatusDotProps, StepsProps, StepsSize, StepsTone, SurfaceLevel, SurfaceProps, SwitchProps, TabItem, TabStripItem, TabStripProps, TabbedModalProps, TabbedModalSection, TabbedPanelProps, TabbedPanelTab, TableColumn, TableProps, TabsProps, TextAlign, TextProps, TextareaProps, TimeSeriesChartProps, TimeSeriesChartSeries, TimeSeriesChartShape, TimelineItem, TimelineProps, TimelineScrubberMarker, TimelineScrubberMarkerTone, TimelineScrubberProps, TimelineTone, TitleBarProps, ToastContextValue, ToastOptions, ToastProps, ToastTone, ToggleProps, ToolbarProps, TooltipProps, TrackInfoAlign, TrackInfoProps, TrackInfoSize, Translate, TransportControlsLabels, TransportControlsProps, TransportEmphasis, TreeItem, TreeViewProps, TypingIndicatorProps, TypingTemplates, UseBeatOptions, UseLiveLevelsOptions, VirtualListHandle, VirtualListProps, VisualFeedbackFn, VisualFeedbackIntensity, VisualFeedbackVariant, VolumeBarLabels, VolumeBarProps, VolumeBarSize, VolumeReadout, WeekStart, WizardProps, WizardStep };
