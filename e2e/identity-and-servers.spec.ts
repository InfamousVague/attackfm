/**
 * The front door, and the boxes behind it.
 *
 * Everything here is about the two things a listener owns that are not music:
 * WHO they are (a central account on the registry) and WHERE they listen (one
 * or more hubs). The suite runs against a real registry as well as a real hub,
 * because every interesting failure in this area has been a disagreement
 * between the two - an invite the hub would not honour, a friendship the hub
 * had not mirrored yet, a token the registry had aged out.
 *
 * TWO THINGS TO KNOW BEFORE ADDING A TEST HERE.
 *
 * 1. The shipped bundle's registry address is baked in at build time and points
 *    at production. `useLocalRegistry` turns those calls around to this run's
 *    registry; a context that will hold an identity must install it BEFORE it
 *    navigates. See e2e/fixtures/registry-and-hubs.ts.
 *
 * 2. `disconnect()` (Log out) calls `POST /api/auth/logout`, which DELETES the
 *    bearer it was called with. Signing the shared `matt` storage state out
 *    would revoke the token every other suite in the run is holding. So the
 *    sign-out scenario signs itself in through the door first and spends its
 *    own token.
 */
import { cleanContext, contextAs, expect, test } from './fixtures/hub.ts';
import {
  RegistryApi,
  seedIdentity,
  startSecondHub,
  useLocalRegistry,
  type RegistryIdentity,
  type SecondHub,
} from './fixtures/registry-and-hubs.ts';

/** Handles are minted per run so a re-run against a warm registry cannot
 *  collide with the last one's accounts. */
const stamp = Date.now().toString(36).slice(-5);
const handleFor = (who: string) => `${who}${stamp}`;
const PASSWORD = 'attackfm-e2e-account';

/**
 * A second hub, stood up once for the whole file.
 *
 * Two scenarios need one and neither can be written without it: an invite is
 * only a real gate on a server that already has an owner, and "what does the
 * library look like with two servers" needs a second library to look at. It is
 * also what keeps the shared hub clean - a stranger joining lands HERE, so the
 * run's `matt`/`kim`/`ana` hub still holds exactly the three accounts every
 * other suite expects.
 */
let second: SecondHub;
/** The account that owns the second hub, so it is invite-only rather than
 *  crowning whoever arrives next. */
let secondOwner: RegistryIdentity;
let registry: RegistryApi;

test.beforeAll(async ({ world }) => {
  registry = new RegistryApi(world.registryUrl);
  second = await startSecondHub(world, 'The other hub', 1);
  secondOwner = await registry.signup(handleFor('owner'), PASSWORD);
  // Straight at the hub's own door: an empty hub crowns its first registry
  // arrival, which is exactly what makes every arrival after this one need an
  // invite (registry_auth.rs).
  const enter = await fetch(`${second.url}/api/registry/enter`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: secondOwner.token, invite: '' }),
  });
  expect(enter.ok, `the second hub refused its owner: ${await enter.text()}`).toBe(true);
});

test.afterAll(() => {
  second?.stop();
});

/** The registry's own storage key, read back to prove a sign-in persisted. */
const REGISTRY_KEY = 'attackfm-registry-session';

const stored = (page: import('@playwright/test').Page, key: string) =>
  page.evaluate((k) => localStorage.getItem(k), key);

/** A token shaped like the registry's and good for nothing, so a launch has to
 *  find another way in. */
const DEAD_TOKEN = 'afm1.expired.expired.expired';

// --- the door ---------------------------------------------------------------

test('the front door leads with sign in, not with sign up', async ({ browser, world }) => {
  const context = await cleanContext(browser, world);
  const page = await context.newPage();
  await page.goto('/');

  // The default face is SIGN IN. A door is opened far more often by someone
  // who already lives there, and leading with the form that makes a SECOND
  // account is how a returning listener locks themselves out of their own
  // servers under a handle they did not mean to register.
  await expect(page.getByRole('textbox', { name: 'Handle' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create an account instead' })).toBeVisible();

  // And both ways past identity are on the same screen: the owner's direct
  // sign-in, and no account at all.
  await expect(page.getByRole('button', { name: 'Sign into a server directly' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use without an account' })).toBeVisible();

  await context.close();
});

test('a wrong account password is refused, and the right one is an identity and not a library', async ({
  browser,
  world,
}) => {
  const handle = handleFor('dora');
  await registry.signup(handle, PASSWORD);

  const context = await cleanContext(browser, world);
  await useLocalRegistry(context, world);
  const page = await context.newPage();
  await page.goto('/');

  await page.getByRole('textbox', { name: 'Handle' }).fill(handle);
  await page.getByRole('textbox', { name: 'Password' }).fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // The registry's own sentence, shown as it came. A door that swallows this
  // looks identical to one that is simply slow.
  await expect(page.getByText(/wrong handle or password/i)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Handle' })).toBeVisible();
  expect(await stored(page, REGISTRY_KEY)).toBeNull();

  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // Identity first is the whole architecture: an account is WHO you are and a
  // server is only where some music happens to live, so a good password lands
  // on step two - find a library - and never inside one.
  await expect(page.getByText(/now find some music/i)).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  expect(await stored(page, REGISTRY_KEY)).toContain(handle);

  await context.close();
});

test('signing into a hub directly: the address is probed, a wrong password is refused, the right one opens the library', async ({
  browser,
  world,
}) => {
  const context = await cleanContext(browser, world);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign into a server directly' }).click();

  await page.getByRole('textbox', { name: 'Server address' }).fill(world.hubUrl);
  // The probe INFORMS the step rather than gating it, and what it found is the
  // server's own name and its real count - not a hopeful "looks like a server".
  // `count` and not `tracks.length`: what a server reports is everything it
  // holds, and the fixture's twelve songs sit beside a twelve-chapter book.
  await expect(page.getByText(`Found E2E hub · ${world.library.count} tracks`)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('textbox', { name: 'Username' }).fill('matt');
  await page.getByRole('textbox', { name: 'Password' }).fill('nope-nope-nope');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/wrong name or password/i)).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);

  await page.getByRole('textbox', { name: 'Password' }).fill(world.users.matt!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByText(`${world.library.tracks.length} songs`)).toBeVisible();
  // Both keys, because the app reads the single one and falls back to the set:
  // a sign-in that seeds only one of them works until the day it does not.
  expect(await stored(page, 'attackfm-server-session')).toContain(world.hubUrl);
  expect(await stored(page, 'attackfm-sessions')).toContain(world.hubUrl.toLowerCase());

  await context.close();
});

test('signing out takes the session with it, and a reload does not walk back in', async ({
  browser,
  world,
}) => {
  // Its OWN sign-in, deliberately: Log out deletes the bearer it is holding,
  // and the shared `matt` state's bearer belongs to the whole run.
  const context = await cleanContext(browser, world);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign into a server directly' }).click();
  await page.getByRole('textbox', { name: 'Server address' }).fill(world.hubUrl);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'Username' }).fill('matt');
  await page.getByRole('textbox', { name: 'Password' }).fill(world.users.matt!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

  const revoked = await page.evaluate(() => {
    const raw = localStorage.getItem('attackfm-server-session');
    return raw ? (JSON.parse(raw) as { token: string }).token : '';
  });
  expect(revoked).not.toBe('');

  await page.getByRole('button', { name: 'Settings', exact: true }).last().click();
  await page.getByText('Account & devices').click();
  await page.getByRole('button', { name: 'Log out' }).click();

  // Out of the app entirely, and back at a door. Which door is the one this
  // session came in by - the gate keeps the direct sign-in open - so the
  // assertion is that the LIBRARY is gone, not which screen replaced it.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Server address' })).toBeVisible();

  // The interesting half. A sign-out that only drops the React state leaves
  // both storage keys behind, and the app walks straight back in on the next
  // launch - which is how "it will not sign me out" gets reported.
  expect(await stored(page, 'attackfm-server-session')).toBeNull();
  expect(await stored(page, 'attackfm-sessions')).not.toContain(world.hubUrl.toLowerCase());

  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Handle' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);

  // And the hub agrees: the token that was signed out is not a token any more.
  const check = await fetch(`${world.hubUrl}/api/me`, { headers: { authorization: `Bearer ${revoked}` } });
  expect(check.status).toBe(401);

  await context.close();
});

// --- invites ----------------------------------------------------------------

test('the invite card mints a real code, and a standing one says it never expires', async ({
  browser,
  world,
}) => {
  const identity = await registry.signup(handleFor('host'), PASSWORD);
  const context = await contextAs(browser, world, 'matt');
  await useLocalRegistry(context, world);
  await seedIdentity(context, identity);
  const page = await context.newPage();
  await page.goto('/');

  await page.getByRole('button', { name: 'Invite a friend' }).click();

  // The QR's alt text carries the code, which is also how a screen reader is
  // told what the picture is - so the code can be read without pinning a class.
  const qr = page.getByRole('img', { name: /^Invite code / });
  await expect(qr).toBeVisible();
  const code = ((await qr.getAttribute('alt')) ?? '').replace('Invite code ', '').trim();
  expect(code).toHaveLength(6);

  // A week is the default lifetime, and the card says so rather than printing
  // a dead code with no explanation for why it stopped working.
  await expect(page.getByText(/attack\.fm · code valid until /)).toBeVisible();

  // The code the card shows is one the REGISTRY will honour, for THIS hub. A
  // card that draws beautifully and mints against the wrong server is the
  // failure this catches, and it is invisible from the card alone.
  const preview = await registry.call<{ serverUrl: string; expired: boolean; spent: boolean }>(
    `/v1/invites/${code}`,
  );
  expect(preview.serverUrl.replace(/\/$/, '')).toBe(world.hubUrl);
  expect(preview.expired).toBe(false);
  expect(preview.spent).toBe(false);

  // 0 is the registry's mark for a standing invite, and the card has to say
  // that in words: a picture outlives the code on it, so "never expires" is
  // the difference between a poster and a mystery.
  await page.getByRole('button', { name: 'How long the code lasts' }).click();
  await page.getByRole('option', { name: 'Never expires' }).click();
  await expect(page.getByText('attack.fm · code never expires')).toBeVisible();
  const other = ((await qr.getAttribute('alt')) ?? '').replace('Invite code ', '').trim();
  expect(other).not.toBe(code);
  // The registry's own word for it, which is what the card's sentence is
  // reporting: standing, unlimited, and never expired.
  const forever = await registry.call<{ standing: boolean; maxUses: number | null; expired: boolean }>(
    `/v1/invites/${other}`,
  );
  expect(forever.standing).toBe(true);
  expect(forever.maxUses).toBeNull();
  expect(forever.expired).toBe(false);

  await context.close();
});

test('an invited stranger makes an account at the door and lands in that server library', async ({
  browser,
  world,
}) => {
  const invite = await registry.invite(secondOwner.token, second.url, 'The other hub', {
    ttlSecs: 3600,
    maxUses: 5,
  });

  const context = await cleanContext(browser, world);
  await useLocalRegistry(context, world);
  const page = await context.newPage();
  await page.goto('/');

  // Step one: an identity, made at the door by someone who has never seen the
  // app - which is what an invite link actually delivers.
  const handle = handleFor('nina');
  await page.getByRole('button', { name: 'Create an account instead' }).click();
  await page.getByRole('textbox', { name: 'Handle' }).fill(handle);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // Step two: a library. The account has no memberships, so the door asks for
  // an invite rather than offering a list of nothing.
  await expect(page.getByText(/now find some music/i)).toBeVisible();

  // Pasted as a LINK, because that is what arrives in a message - and the
  // field checks it the moment it carries a code rather than waiting for a
  // button nobody knows to press.
  await page.getByRole('textbox', { name: 'Invite link' }).fill(`https://attack.fm/i/${invite.code}`);

  // The preview names the server before anything is spent. An invite that
  // cannot be previewed reads as broken here rather than at the join.
  await expect(page.getByText(/Join .*The other hub/)).toBeVisible();
  await page.getByRole('button', { name: 'Join', exact: true }).click();

  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByText(`${second.tracks} songs`)).toBeVisible();
  expect(await stored(page, 'attackfm-server-session')).toContain(second.url);

  await context.close();
});

// --- keys ------------------------------------------------------------------

test('recovery codes are shown once, and one of them opens the door', async ({ browser, world }) => {
  const handle = handleFor('rex');
  const identity = await registry.signup(handle, PASSWORD);

  const owner = await contextAs(browser, world, 'matt');
  await useLocalRegistry(owner, world);
  await seedIdentity(owner, identity);
  const page = await owner.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click();
  await page.getByText('Account & devices').click();

  await expect(page.getByRole('heading', { name: 'Recovery codes' })).toBeVisible();
  await page.getByRole('button', { name: 'Make recovery codes' }).click();

  const sheet = page.getByRole('dialog', { name: 'Your recovery codes' });
  await expect(sheet).toBeVisible();
  const codes = await sheet.getByRole('listitem').allInnerTexts();
  expect(codes.length).toBeGreaterThanOrEqual(4);
  const code = codes[0]!.trim();
  expect(code).not.toBe('');
  await page.getByRole('button', { name: 'I have saved them' }).click();

  // The registry counts them down, which is the only readout there is - the
  // codes themselves are hashed and cannot be shown twice.
  await expect(page.getByText(`${codes.length} unused codes on your sheet`, { exact: false })).toBeVisible();
  await owner.close();

  // A fresh device, no password, no key: the code IS the way back in.
  const back = await cleanContext(browser, world);
  await useLocalRegistry(back, world);
  const door = await back.newPage();
  await door.goto('/');
  await door.getByRole('button', { name: 'Lost the password? Use a recovery code' }).click();
  await door.getByRole('textbox', { name: 'Handle' }).fill(handle);
  await door.getByRole('textbox', { name: 'Recovery code' }).fill(code);
  await door.getByRole('button', { name: 'Sign in with the code' }).click();
  // Step two, whichever face it wears: this account has been on a server (the
  // pane above is a signed-in one), so the door offers to carry on there
  // rather than asking for an invite. Either way the ACCOUNT step is behind us,
  // which is what a recovery code buys.
  await expect(door.getByText(/now find some music|pick one to carry on/i)).toBeVisible();
  await expect(door.getByRole('button', { name: 'Sign in with the code' })).toHaveCount(0);
  expect(await stored(door, REGISTRY_KEY)).toContain(handle);
  await back.close();

  // Each works ONCE. A sheet that kept working would be a password with extra
  // steps, printed on a piece of paper.
  const again = await fetch(`${world.registryUrl}/v1/login/recovery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, code }),
  });
  expect(again.status).toBe(401);
});

test("a token that aged out is renewed by this device's key, with nobody asked for a password", async ({
  browser,
  world,
}) => {
  const handle = handleFor('kaye');
  const context = await cleanContext(browser, world);
  await useLocalRegistry(context, world);
  const page = await context.newPage();

  // Every registry call this context makes, so the renewal can be told apart
  // from a re-signin: one is `/v1/login/device`, the other is `/v1/login`.
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith('https://registry.attack.fm/')) calls.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account instead' }).click();
  await page.getByRole('textbox', { name: 'Handle' }).fill(handle);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText(/now find some music/i)).toBeVisible();

  // Enrolment is deliberately not awaited by the sign-in (`void enrolDevice`),
  // so this waits for the registry to have been told rather than assuming it.
  await expect.poll(() => calls.includes('POST /v1/device'), { timeout: 15_000 }).toBe(true);

  // Age the stored token out, exactly as a fortnight away from the app would.
  await page.evaluate(
    ([key, dead]) => {
      const held = JSON.parse(localStorage.getItem(key!)!) as { token: string };
      held.token = dead!;
      localStorage.setItem(key!, JSON.stringify(held));
    },
    [REGISTRY_KEY, DEAD_TOKEN] as const,
  );

  calls.length = 0;
  await page.reload();

  // The key signs the registry's challenge and a live token is written back.
  // No password field is ever put in front of anyone - which is the point of
  // the whole device-key path.
  await expect
    .poll(async () => JSON.parse((await stored(page, REGISTRY_KEY))!).token as string, { timeout: 20_000 })
    .not.toBe(DEAD_TOKEN);
  const after = JSON.parse((await stored(page, REGISTRY_KEY))!) as {
    token: string;
    account: { handle: string };
  };
  expect(after.account.handle).toBe(handle);
  // Good for something, not merely different: the registry's tokens carry a
  // one-second `iat`, so a renewal inside the same second is byte-identical to
  // the one it replaced and "it changed" would be a coin toss.
  const proof = await fetch(`${world.registryUrl}/v1/refresh`, {
    method: 'POST',
    headers: { authorization: `Bearer ${after.token}` },
  });
  expect(proof.ok).toBe(true);
  expect(calls).toContain('POST /v1/login/challenge');
  expect(calls).toContain('POST /v1/login/device');
  expect(calls.filter((c) => c === 'POST /v1/login')).toEqual([]);

  await context.close();
});

test('a pairing code signs a second device in without a password', async ({ browser, world }) => {
  const owner = await contextAs(browser, world, 'matt');
  const page = await owner.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click();
  await page.getByText('Account & devices').click();
  await page.getByRole('button', { name: 'Link a device' }).click();

  // The QR and the typed code carry the same thing; the code is what a person
  // reads off one screen and taps into another. Printed in two halves for the
  // eye, so the gap comes back out before it is typed - which is exactly what
  // the Copy button beside it does too.
  const shown = await page.getByLabel('Pairing code').innerText();
  const code = shown.replace(/\s+/g, '');
  expect(code).toHaveLength(6);
  await owner.close();

  const phone = await cleanContext(browser, world);
  const second2 = await phone.newPage();
  await second2.goto('/');
  await second2.getByRole('button', { name: 'Sign into a server directly' }).click();
  await second2.getByRole('textbox', { name: 'Server address' }).fill(world.hubUrl);
  await second2.getByRole('button', { name: 'Log in with a code' }).click();
  // No camera in a headless browser, so the scanner stands aside and the typed
  // pair is what is left - which is the path this is about anyway.
  await second2.getByRole('textbox', { name: 'Server address' }).fill(world.hubUrl);
  await second2.getByRole('textbox', { name: 'Pairing code' }).fill(code);
  await second2.getByRole('button', { name: 'Connect' }).click();

  await expect(second2.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(second2.getByText(`${world.library.tracks.length} songs`)).toBeVisible();
  expect(await stored(second2, 'attackfm-server-session')).toContain('"username":"matt"');

  // Spent: a pairing code is one device, once.
  const replay = await fetch(`${world.hubUrl}/api/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  expect(replay.ok).toBe(false);

  await phone.close();
});

// --- two servers -----------------------------------------------------------

test('a second server joins the account, and the library holds both', async ({ browser, world }) => {
  const invite = await registry.invite(secondOwner.token, second.url, 'The other hub', {
    ttlSecs: 3600,
    maxUses: 5,
  });
  const identity = await registry.signup(handleFor('duo'), PASSWORD);

  const context = await contextAs(browser, world, 'matt');
  await useLocalRegistry(context, world);
  await seedIdentity(context, identity);
  const page = await context.newPage();
  await page.goto('/');
  // The first library has to be cached before the second arrives: the merged
  // list reads the OTHER servers out of their caches, so a switch made before
  // the first sync finished would show one library and look like a bug in the
  // merge rather than a race in the test.
  await expect(page.getByText(`${world.library.tracks.length} songs`)).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).last().click();
  await page.getByText('Account & devices').click();
  await page.getByText('Join another server').click();
  await page.getByRole('textbox', { name: 'Invite link' }).fill(`https://attack.fm/i/${invite.code}`);
  await expect(page.getByText(/Join .*The other hub/)).toBeVisible();
  await page.getByRole('button', { name: 'Join', exact: true }).click();

  // Both are on the account now, and the one just joined is the one being
  // listened to. Signing into a second server is ADDING, not leaving.
  const sessionSet = async () =>
    JSON.parse((await stored(page, 'attackfm-sessions')) ?? '{}') as {
      byUrl?: Record<string, unknown>;
      primary?: string;
    };
  await expect.poll(async () => (await sessionSet()).primary).toBe(second.url.toLowerCase());
  expect(Object.keys((await sessionSet()).byUrl ?? {}).sort()).toEqual(
    [world.hubUrl.toLowerCase(), second.url.toLowerCase()].sort(),
  );

  // And the library is the SUM. The second server's songs come off the wire;
  // the first server's come out of its cache, which is the whole reason a
  // second library appears instantly instead of after a round trip.
  //
  // Read after a relaunch, which is both the way past the join sheet that is
  // still up and the more interesting question: two servers have to survive
  // being closed, or "join another" is a session-long novelty.
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  const both = world.library.tracks.length + second.tracks;
  await expect(page.getByText(`${both} songs`)).toBeVisible({ timeout: 20_000 });

  await context.close();
});

// --- friends ---------------------------------------------------------------

test('a friend request through the registry: asked, accepted, and on both lists', async ({
  browser,
  world,
}) => {
  const asker = await registry.signup(handleFor('ari'), PASSWORD);
  const asked = await registry.signup(handleFor('bea'), PASSWORD);

  // Two people, two hub sessions, two identities - which is the only way to
  // see a friendship from both ends at once.
  const askerCtx = await contextAs(browser, world, 'matt');
  await useLocalRegistry(askerCtx, world);
  await seedIdentity(askerCtx, asker);
  const askedCtx = await contextAs(browser, world, 'kim');
  await useLocalRegistry(askedCtx, world);
  await seedIdentity(askedCtx, asked);

  const one = await askerCtx.newPage();
  await one.goto('/');
  await one.getByRole('button', { name: 'Profile', exact: true }).last().click();
  // The section head's verb opens a dialog with the same field in it; the
  // empty state carries a second copy inline. Scoped to the dialog so the
  // handle and the button that sends it are certainly the same form.
  await one.getByRole('button', { name: 'Add', exact: true }).first().click();
  const ask = one.getByRole('dialog', { name: 'Add a friend' });
  await ask.getByRole('textbox', { name: 'Add a friend by handle' }).fill(asked.account.handle);
  await ask.getByRole('button', { name: 'Add', exact: true }).click();
  // Asked, not friends: the row says so rather than pretending it landed.
  await expect(one.getByText(asked.account.handle, { exact: false }).first()).toBeVisible();
  await expect(one.getByText('invited · waiting')).toBeVisible();

  const two = await askedCtx.newPage();
  await two.goto('/');
  await two.getByRole('button', { name: 'Profile', exact: true }).last().click();
  await expect(two.getByRole('heading', { name: 'Wants to be friends' })).toBeVisible();
  await expect(two.getByText(asker.account.handle, { exact: false }).first()).toBeVisible();
  await two.getByRole('button', { name: 'Accept' }).click();

  // Both ends. A friendship that only shows on the accepting side is the
  // shape of every "they cannot see me" report there has ever been.
  await expect(two.getByRole('heading', { name: 'Wants to be friends' })).toHaveCount(0);
  await expect(two.getByText(asker.account.handle, { exact: false }).first()).toBeVisible();

  await one.reload();
  await one.getByRole('button', { name: 'Profile', exact: true }).last().click();
  await expect(one.getByText('invited · waiting')).toHaveCount(0);
  await expect(one.getByText(asked.account.handle, { exact: false }).first()).toBeVisible();

  await askerCtx.close();
  await askedCtx.close();
});
