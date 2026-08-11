/**
 * The toolbox's shared furniture: the shell every tool renders inside (back
 * row, title, blurb), the three recurring notes (quiet, missing-endpoint,
 * error-with-retry), and the handful of inline style objects that keep the
 * five tools looking like one page. Styles are inline because a bundled
 * plugin cannot ship CSS - glacier tokens do the theming.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Button, Spinner, Text } from '@glacier/react';
import { ArrowLeft } from '@glacier/icons';
import { missingNote } from './api.ts';

export const panel: CSSProperties = {
  background: 'var(--glacier-surface)',
  border: '1px solid var(--glacier-border-subtle)',
  borderRadius: 'var(--glacier-radius-lg)',
  padding: 14,
};

export const stack = (gap: number): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap,
});

export const row = (gap: number): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap,
});

/** The 56px cover square list rows wear, with a sunken fallback behind it. */
export const coverBox: CSSProperties = {
  width: 56,
  height: 56,
  flexShrink: 0,
  borderRadius: 'var(--glacier-radius-md)',
  background: 'var(--glacier-surface-sunken)',
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--glacier-text-subtle)',
};

export const coverImg: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' };

/** A full-width row that behaves like a button without wearing one's chrome. */
export const rowButton: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  width: '100%',
  padding: 10,
  border: 'none',
  borderRadius: 'var(--glacier-radius-md)',
  background: 'transparent',
  color: 'var(--glacier-text)',
  textAlign: 'left',
  cursor: 'pointer',
  font: 'inherit',
};

/** A small badge for codec / lossless / count chips on track rows. */
export function Chip({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 'var(--glacier-radius-full)',
        fontSize: 'var(--glacier-font-size-xs)',
        whiteSpace: 'nowrap',
        background: accent ? 'var(--glacier-accent-soft)' : 'var(--glacier-surface-sunken)',
        color: accent ? 'var(--glacier-accent-text)' : 'var(--glacier-text-muted)',
      }}
    >
      {children}
    </span>
  );
}

/**
 * The frame every tool renders inside: a back row to the toolbox index, the
 * tool's name and one-line promise, then whatever the tool is.
 */
export function ToolShell({
  title,
  blurb,
  onBack,
  actions,
  children,
}: {
  title: string;
  blurb: string;
  onBack: () => void;
  /** Optional right-aligned header controls, e.g. a refresh button. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={{ ...stack(16), padding: '18px 20px 28px', maxWidth: 860, margin: '0 auto' }}>
      <div style={row(10)}>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={15} /> Toolbox
        </Button>
        <div style={{ flex: 1 }} />
        {actions}
      </div>
      <div style={stack(4)}>
        <Text as="div" size="lg" weight="semibold" role="heading" aria-level={1}>
          {title}
        </Text>
        <Text tone="muted" size="sm">
          {blurb}
        </Text>
      </div>
      {children}
    </div>
  );
}

/** A quiet aside - the tone for anything that is a fact, not a failure. */
export function QuietNote({ children }: { children: ReactNode }) {
  return (
    <div style={{ ...panel, padding: 12 }}>
      <Text tone="muted" size="sm">
        {children}
      </Text>
    </div>
  );
}

/** The old-server note, worded identically in every tool. */
export function MissingNote({ tool }: { tool: string }) {
  return <QuietNote>{missingNote(tool)}</QuietNote>;
}

/** A failure the user can do something about: the message, and a retry. */
export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div style={{ ...panel, padding: 12, ...row(10) }}>
      <Text tone="danger" size="sm" style={{ flex: 1 }}>
        {message}
      </Text>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** The in-flight row: spinner plus what is being waited on. */
export function BusyRow({ label }: { label: string }) {
  return (
    <div style={{ ...row(10), padding: 12 }}>
      <Spinner size="sm" aria-label="" />
      <Text tone="muted" size="sm">
        {label}
      </Text>
    </div>
  );
}

/** Shown on the destructive tools when the signed-in account cannot write. */
export function AdminNote({ verb }: { verb: string }) {
  return <QuietNote>Only a server admin can {verb} - ask whoever runs your server.</QuietNote>;
}
