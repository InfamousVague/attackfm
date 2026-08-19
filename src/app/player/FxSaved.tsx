import { useEffect, useState } from 'react';
import { Button, Input, SegmentedControl, Text } from '@glacier/react';
import { ChevronDown, ChevronUp, Save, Trash2 } from '@glacier/icons';
import { request } from '../api/http.ts';
import { nodeSpec, type FxNode } from './fxChain.ts';
import { useChainEdit } from './fxEditing.tsx';
import { useServerSession } from '../servers/serverSession.tsx';

/**
 * The two things that act on the WHOLE chain: A/B, and saving it under a name.
 *
 * These used to sit on the HiFi Lab page, which made them look like the rack's
 * own features. They never were - both read and write `chain.nodes`, pedals
 * included - so a "rack" saved from that page quietly carried your pedalboard
 * with it, and A/B swapped the board too. Hoisting them to the console is what
 * makes that honest: they live below the room switcher, where it is plain they
 * belong to neither room.
 */

interface ServerPreset {
  id: number;
  name: string;
  chain: { t: string; [k: string]: unknown }[];
}

/** A saved chain comes back as wire nodes; rebuild editor nodes from them,
 *  clamping anything that has drifted out of range rather than trusting it. */
function fromWire(chain: ServerPreset['chain']): FxNode[] {
  const out: FxNode[] = [];
  for (const item of chain) {
    const spec = nodeSpec(item.t);
    if (!spec) continue; // a tag this build does not know
    const params: Record<string, number> = {};
    for (const p of spec.params) {
      const v = item[p.key];
      params[p.key] =
        typeof v === 'number' && Number.isFinite(v)
          ? Math.min(p.max, Math.max(p.min, v))
          : p.default;
    }
    out.push({ t: spec.t, on: true, params, key: Math.random().toString(36).slice(2, 10) });
  }
  return out;
}

/** Where the other half of an A/B lives. Named for the page it was born on,
 *  and kept that way: renaming the key would throw away everyone's B. */
const AB_KEY = 'attackfm-hifi-lab-ab';

export function FxSaved() {
  const { chain, edit } = useChainEdit();
  const { session } = useServerSession();
  const [openList, setOpenList] = useState(false);
  const [presets, setPresets] = useState<ServerPreset[]>([]);
  const [name, setName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [slot, setSlot] = useState<'A' | 'B'>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(AB_KEY) ?? '{}') as { slot?: string };
      return raw.slot === 'B' ? 'B' : 'A';
    } catch {
      return 'A';
    }
  });

  const say = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote((n) => (n === text ? null : n)), 3500);
  };

  useEffect(() => {
    if (!session || !openList) return;
    let live = true;
    void request<{ presets: ServerPreset[] }>(session.url, '/api/fx/presets', {
      token: session.token,
    })
      .then((r) => {
        if (live) setPresets(r.presets ?? []);
      })
      .catch(() => {
        if (live) say('Could not reach the server for your saved chains.');
      });
    return () => {
      live = false;
    };
  }, [session, openList]);

  /** Park the current chain in the slot being left, and bring back the other. */
  const flip = (to: 'A' | 'B') => {
    if (to === slot) return;
    try {
      const raw = JSON.parse(localStorage.getItem(AB_KEY) ?? '{}') as Record<string, unknown>;
      raw[slot] = chain.nodes;
      raw.slot = to;
      localStorage.setItem(AB_KEY, JSON.stringify(raw));
      const incoming = Array.isArray(raw[to]) ? (raw[to] as FxNode[]) : [];
      // Switching into a slot you have never filled leaves the chain empty,
      // and an empty chain that claims to be on is a lie the store would fix
      // anyway - so disarm rather than let the switch flicker back.
      edit(incoming, incoming.length > 0 ? chain.on : false);
    } catch {
      // A storage that will not hold the other side still lets the label move.
    }
    setSlot(to);
  };

  const live = chain.nodes.filter((n) => n.on).length;

  const save = () => {
    const trimmed = name.trim();
    if (!session || !trimmed || live === 0) return;
    const wire = chain.nodes.filter((n) => n.on).map((n) => ({ t: n.t, ...n.params }));
    void request<{ id: number }>(session.url, '/api/fx/presets', {
      method: 'POST',
      token: session.token,
      body: JSON.stringify({ name: trimmed, chain: wire }),
    })
      .then(({ id }) => {
        // The server replaces by name, so the local list must too or the same
        // chain appears twice until the next fetch.
        setPresets((prev) => [{ id, name: trimmed, chain: wire }, ...prev.filter((p) => p.name !== trimmed)]);
        setName('');
        say(`Saved “${trimmed}”.`);
      })
      .catch(() => say('Could not save — is the server reachable?'));
  };

  const drop = (p: ServerPreset) => {
    if (!session) return;
    // Every rejection is a failure, including the ones fetch throws that are
    // not ServerError - offline, DNS, the request module's 30s deadline. An
    // earlier version swallowed those on the theory that they were a delete
    // that succeeded and answered with a body that would not parse; the two
    // are indistinguishable from here, and guessing "succeeded" is the
    // expensive way to be wrong. The row vanished, nothing was said, and the
    // preset came back the next time the list was opened.
    void request(session.url, `/api/fx/presets/${p.id}`, { method: 'DELETE', token: session.token })
      .then(() => setPresets((prev) => prev.filter((x) => x.id !== p.id)))
      .catch(() => say('Could not delete that one.'));
  };

  return (
    <div className="fxSaved">
      <div className="fxSaved__row">
        {/* Two whole chains, one switch. The comparison people actually make
            is "this against that", not "on against off" - the master switch
            already covers the second one. */}
        <SegmentedControl
          aria-label="Compare two chains"
          size="sm"
          value={slot}
          options={[
            { value: 'A', label: 'A' },
            { value: 'B', label: 'B' },
          ]}
          onValueChange={(v) => flip(v as 'A' | 'B')}
        />
        <button
          type="button"
          className="fxSaved__toggle"
          aria-expanded={openList}
          onClick={() => setOpenList((v) => !v)}
        >
          Saved chains
          {openList ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {openList && (
        <div className="fxSaved__body">
          {!session ? (
            <Text tone="muted" size="xs">
              Saved chains live on your server, so sign in to keep one.
            </Text>
          ) : (
            <>
              <div className="fxSaved__save">
                <Input
                  aria-label="Name this chain"
                  placeholder="Name this chain"
                  size="sm"
                  value={name}
                  onChange={(e: { target: { value: string } }) => setName(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="soft"
                  disabled={!name.trim() || live === 0}
                  onClick={save}
                >
                  <Save size={14} />
                  Save
                </Button>
              </div>
              {/* Said out loud because it is the one surprising thing here:
                  a save takes the rack and the board together, and leaves out
                  whatever is bypassed. */}
              <Text tone="muted" size="xs">
                Saves the {live} box{live === 1 ? '' : 'es'} currently switched in — rack and
                pedals together. Bypassed boxes are left out.
              </Text>

              {presets.length > 0 && (
                <ul className="fxSaved__list">
                  {presets.map((p) => (
                    <li key={p.id} className="fxSaved__item">
                      <button
                        type="button"
                        className="fxSaved__load"
                        onClick={() => {
                          edit(fromWire(p.chain), true);
                          say(`Loaded “${p.name}”.`);
                        }}
                      >
                        <span className="fxSaved__name">{p.name}</span>
                        <span className="fxSaved__count">
                          {p.chain.length} box{p.chain.length === 1 ? '' : 'es'}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="fxSaved__drop"
                        aria-label={`Delete ${p.name}`}
                        onClick={() => drop(p)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {note && (
        <Text tone="muted" size="xs">
          {note}
        </Text>
      )}
    </div>
  );
}
