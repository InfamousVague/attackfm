import { Avatar, Button, IconButton, Label, Text } from '@glacier/react';
import { X } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { forgetProfile, otherProfiles, type Profile } from './household.ts';
import { useServerSession } from './serverSession.tsx';

/**
 * The household: the other accounts this device has been signed into, one tap
 * away.
 *
 * A hub in a house holds several people, and the phone on the kitchen counter
 * gets handed around. Everything that makes an account worth having - your
 * plays, your resume positions, your mixes, your stats - is already kept apart
 * server-side, so the only thing standing between two listeners was a password
 * prompt. This is that prompt, removed for accounts this device already knows
 * (household.ts), and nothing more: a profile here was minted by someone who
 * had the credentials, and forgetting one takes it off this device.
 */
export function HouseholdSection() {
  const { session, applySession } = useServerSession();
  const [known, setKnown] = useState<Profile[]>(() => otherProfiles(session));

  // Re-read on every switch: `persist` remembers the account being left, so
  // the list is different the moment one is taken.
  useEffect(() => {
    setKnown(otherProfiles(session));
  }, [session]);

  if (known.length === 0) return null;

  return (
    <div className="prefsSection">
      <Label>Household</Label>
      <Text size="sm" tone="muted">
        Other accounts this device knows. Switching keeps each person&rsquo;s own plays, mixes
        and resume points.
      </Text>
      <div className="householdRow">
        {known.map((p) => (
          <div key={`${p.session.url}:${p.session.username}`} className="householdCard">
            <Avatar name={p.session.username} size="sm" />
            <span className="householdCard__name">{p.session.username}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                applySession(p.session);
                setKnown(otherProfiles(p.session));
              }}
            >
              Switch
            </Button>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={`Forget ${p.session.username} on this device`}
              onClick={() => {
                forgetProfile(p.session);
                setKnown(otherProfiles(session));
              }}
            >
              <X size={14} />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  );
}
