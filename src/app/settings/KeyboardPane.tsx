import { Button, IconButton, Kbd } from '@glacier/react';
import { RotateCcw, TriangleAlert } from '@glacier/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { KEY_ACTIONS, KEY_ACTION_GROUPS, keyAction, type KeyActionId } from '../keys/actions.ts';
import { chordCaps, chordFromEvent, formatChord, parseChord } from '../keys/chords.ts';
import {
  bindingConflicts,
  customBindingCount,
  isShippedBinding,
  resetAllBindings,
  resetBinding,
  setBinding,
  useKeymap,
} from '../keys/keymap.ts';
import { PaneSection, SettingRow, SettingsFootnote } from './kit/settingsKit.tsx';
import { useT } from '../i18n/LocaleShell.tsx';

/**
 * The Keyboard pane: every action the keys can reach (keys/actions.ts), the
 * chord each one answers to, and a way to change it.
 *
 * Changing a key is RECORDED rather than typed. A field you type "shift+s"
 * into asks a person to know this file's spelling; pressing the keys asks
 * nothing. While a row is listening, the pane holds one capture-phase
 * listener that takes the next press whole - and stops it there, so the
 * global listener (which turns away anything already spent) cannot act on
 * the very key being assigned, and the kit's modal cannot hear the Escape
 * that cancels.
 *
 * Two actions on one chord is allowed and said out loud on both rows, rather
 * than refused: a person halfway through swapping two keys has to pass
 * through that state, and a pane that blocks the first half of a swap is a
 * pane where the swap cannot be made.
 */
export function KeyboardPane() {
  const t = useT();
  const map = useKeymap();
  const [recording, setRecording] = useState<KeyActionId | null>(null);
  const conflicts = bindingConflicts(map);
  const custom = customBindingCount(map);

  useEffect(() => {
    if (!recording) return;
    const target = recording;
    const onKey = (event: KeyboardEvent) => {
      // Tab is how a keyboard leaves the row, and a media action on Tab would
      // take that away from the whole app: it cancels, and moves focus as Tab
      // always does.
      if (event.key === 'Tab') {
        setRecording(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(null);
        return;
      }
      // Backspace and Delete take the key away rather than becoming it - the
      // one pair of keys nobody binds to a media app, and the only way to say
      // "no key" without a second control on every row.
      if (event.key === 'Backspace' || event.key === 'Delete') {
        setBinding(target, null);
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(event);
      // A bare modifier is the first half of a chord: keep listening.
      if (!chord) return;
      setBinding(target, formatChord(chord));
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  const capsFor = (chord: string | null): ReactNode => {
    const parsed = chord ? parseChord(chord) : null;
    if (!parsed) return <span className="keyCaps keyCaps--none">{t('keys.unbound')}</span>;
    const caps = chordCaps(parsed, t);
    return (
      <span className="keyCaps">
        {caps.map((cap, i) => (
          <span key={`${i}-${cap}`} className="keyCaps__cap">
            {i > 0 && (
              <span className="keyCaps__plus" aria-hidden>
                +
              </span>
            )}
            <Kbd>{cap}</Kbd>
          </span>
        ))}
      </span>
    );
  };

  return (
    <div className="prefsBody">
      {KEY_ACTION_GROUPS.map((group, gi) => (
        <PaneSection
          key={group.id}
          title={t(group.labelKey)}
          description={gi === 0 ? t('settings.keyboardIntro') : undefined}
        >
          {KEY_ACTIONS.filter((a) => a.group === group.id).map((action) => {
            const listening = recording === action.id;
            const clash = conflicts.get(action.id);
            return (
              <SettingRow
                key={action.id}
                // The search index anchors on the first row (settingsShared).
                id={action.id === 'playPause' ? 'keyboard-shortcuts' : undefined}
                label={t(action.labelKey)}
                hint={
                  clash ? (
                    <span className="keysConflict">
                      <TriangleAlert size={14} aria-hidden />
                      {t('settings.keyboardConflict', { action: t(keyAction(clash[0]!).labelKey) })}
                    </span>
                  ) : (
                    t(action.hintKey)
                  )
                }
                value={
                  listening ? (
                    <span className="keysRecording" role="status">
                      {t('settings.keyboardRecording')}
                    </span>
                  ) : (
                    capsFor(map[action.id])
                  )
                }
                control={
                  <span className="keysRow__controls">
                    <Button
                      variant={listening ? 'outline' : 'ghost'}
                      size="sm"
                      aria-pressed={listening}
                      onClick={() => setRecording(listening ? null : action.id)}
                    >
                      {listening ? t('common.cancel') : t('settings.keyboardChange')}
                    </Button>
                    {!isShippedBinding(action.id, map) && (
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label={t('settings.keyboardReset', { action: t(action.labelKey) })}
                        onClick={() => resetBinding(action.id)}
                      >
                        <RotateCcw size={16} />
                      </IconButton>
                    )}
                  </span>
                }
              />
            );
          })}
        </PaneSection>
      ))}

      <PaneSection footer={<SettingsFootnote>{t('settings.keyboardMediaKeys')}</SettingsFootnote>}>
        <SettingRow
          label={t('settings.keyboardResetAll')}
          hint={t('settings.keyboardResetAllHint')}
          control={
            <Button variant="outline" size="sm" disabled={custom === 0} onClick={() => resetAllBindings()}>
              {t('settings.keyboardResetAllAction')}
            </Button>
          }
        />
      </PaneSection>
    </div>
  );
}
