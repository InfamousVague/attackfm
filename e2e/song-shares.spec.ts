/**
 * Sending the song that is playing to a friend, from the Now Playing screen.
 *
 * Written against the real registry rather than as a render test, because the
 * interesting half of this feature is not the button - it is that a NAME
 * crosses between two accounts on a machine neither of them owns. A component
 * test can prove a drawer opened; only this can prove the other account's
 * inbox has the song this browser was listening to, and that the registry
 * agreed it was allowed to travel.
 *
 * TWO THINGS THIS FILE HAS TO DO THAT OTHERS DO NOT.
 *
 * 1. THE ACCOUNTS ARE REGISTRY ACCOUNTS, MINTED HERE. The world's matt/kim/ana
 *    are HUB accounts, befriended on the hub - and a hub friendship is a
 *    MIRROR of the registry's, not the source (friendMirror.ts). A send reads
 *    the registry's own graph, so this file makes its own two accounts there
 *    and befriends them there. They are named per run for the same reason the
 *    identity suite names its own: a re-run against a warm registry must not
 *    collide with the last one's handles.
 *
 * 2. THE BUNDLE'S REGISTRY ADDRESS IS BAKED IN AT BUILD TIME and points at
 *    production, so a context that will hold an identity installs
 *    `useLocalRegistry` BEFORE it navigates or the app quietly reaches the real
 *    internet. See e2e/fixtures/registry-and-hubs.ts.
 */
import { contextAs, expect, test, type World } from './fixtures/hub.ts';
import { cards, nowPlaying, openLibrary, soloDeck } from './fixtures/deck.ts';
import {
  RegistryApi,
  seedIdentity,
  useLocalRegistry,
  type RegistryIdentity,
} from './fixtures/registry-and-hubs.ts';
import type { Browser, BrowserContext, Page } from '@playwright/test';

const stamp = Date.now().toString(36).slice(-5);
const handleFor = (who: string) => `${who}${stamp}`;
const PASSWORD = 'attackfm-e2e-share';

/** A device id of this file's own, so the hub's Connect seat is never one
 *  another suite is also claiming. See DEVICE in fixtures/deck.ts. */
const DEVICE = 'e2e-share-sender';

/** Who the lead card of the Recently added shelf is by - `writeLibrary` stages
 *  the stamps, so it is the same record every run. */
const LEAD_ARTIST = 'Marla Vane';

let registry: RegistryApi;
let sender: RegistryIdentity;
let receiver: RegistryIdentity;

test.beforeAll(async ({ world }) => {
  registry = new RegistryApi(world.registryUrl);
  sender = await registry.signup(handleFor('sends'), PASSWORD);
  receiver = await registry.signup(handleFor('gets'), PASSWORD);
  // Each asks the other, which is the registry's own shortcut: "their ask
  // crossing yours IS the answer" (registry/main.rs). Two calls, rather than a
  // request plus an accept whose id would have to be read back out.
  const ask = (from: RegistryIdentity, to: RegistryIdentity) =>
    registry.call<{ friends: boolean }>('/v1/friends/requests', {
      method: 'POST',
      token: from.token,
      body: { handle: to.account.handle },
    });
  await ask(sender, receiver);
  const settled = await ask(receiver, sender);
  expect(settled.friends, 'the two registry accounts never became friends').toBe(true);
});

interface Listening {
  context: BrowserContext;
  page: Page;
  /** Anything the page threw, from before the first paint onwards. */
  crashes: string[];
}

/**
 * A page signed into the hub for its music AND into the registry for its
 * identity - the two sign-ins this feature sits across - with a song playing
 * and Now Playing open.
 */
async function listening(browser: Browser, world: World, identity: RegistryIdentity | null): Promise<Listening> {
  const context = await contextAs(browser, world, 'kim');
  await useLocalRegistry(context, world);
  if (identity) await seedIdentity(context, identity);
  const page = await context.newPage();
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));
  await soloDeck(page, world);
  await openLibrary(page, DEVICE);
  // The lead card, opened onto its own record and played from the top.
  await cards(page).first().dblclick();
  await expect(nowPlaying(page)).toBeVisible({ timeout: 20_000 });
  return { context, page, crashes };
}

/** The control this file is about, found by its class rather than by its name:
 *  the name is translated, and a locale run must not need a new selector. */
const sendSeat = (page: Page) => page.locator('.npScreen__send');

test('the song playing reaches a friend’s inbox on another account', async ({ browser, world }) => {
  const { context, page, crashes } = await listening(browser, world, sender);

  // WHERE IT IS. Beside the heart, in the row that names the song - not in the
  // header, whose middle is the ALBUM and whose one verb is about a
  // destination, and not on the actions row, which is already over its width
  // at a desktop's size. Asserted rather than described, so moving it is a
  // decision somebody makes on purpose.
  await expect(sendSeat(page)).toBeVisible();
  await expect(page.locator('.npScreen__meta .npScreen__send')).toHaveCount(1);
  await expect(page.locator('.npScreen__head .npScreen__send')).toHaveCount(0);
  await expect(page.locator('.npScreen__actions .npScreen__send')).toHaveCount(0);
  // And ONE share affordance on this screen, not two.
  await expect(page.getByRole('button', { name: 'Send to a friend', exact: true })).toHaveCount(1);
  // WHAT IT LOOKS LIKE: the three-node share glyph the profile card's Share
  // button wears, not a paper plane. The icon set stamps its own name on the
  // svg, which is the one thing about the drawing a test can read back.
  await expect(sendSeat(page).locator('svg.lucide-share-2')).toHaveCount(1);
  await expect(sendSeat(page).locator('svg.lucide-send')).toHaveCount(0);

  const title = (await nowPlaying(page).locator('.npScreen__title').first().innerText()).trim();
  await sendSeat(page).click();

  // The drawer names the song before it names anybody to send it to, so what
  // is about to travel is on screen at the moment of the decision - and the
  // friend it offers came from the REGISTRY's graph, not the hub's.
  const drawer = page.getByRole('dialog', { name: 'Send to a friend' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(title, { exact: false })).toBeVisible();
  await expect(drawer.getByText(receiver.account.handle, { exact: true })).toBeVisible({ timeout: 10_000 });

  await drawer.getByRole('button', { name: 'Send', exact: true }).click();

  // A FIRST song to somebody is an ASK, not a delivery: they have never said
  // they take songs from this account, so the registry answers `pending` and
  // the row says so rather than claiming it went.
  await expect(drawer.getByRole('button', { name: 'Asked', exact: true })).toBeVisible();

  // THE OTHER ACCOUNT. Asked with the RECEIVER's own token, on the registry
  // this run stood up - the only oracle that can say the song left this
  // browser at all.
  const inbox = await registry.call<{ inbox: { artist: string; title: string; from: string }[] }>(
    '/v1/shares',
    { token: receiver.token },
  );
  expect(inbox.inbox.map((s) => ({ artist: s.artist, title: s.title, from: s.from }))).toEqual([
    { artist: LEAD_ARTIST, title, from: sender.account.handle },
  ]);

  expect(crashes, 'the page threw while sending').toEqual([]);
  await context.close();
});

test('a book chapter has no send seat, with the same account that gets one for a song', async ({
  browser,
  world,
}) => {
  /*
   * THE ACCOUNT IS THE SAME ONE the first scenario sends with - which is what
   * makes this about the BOOK rather than about being signed out. What crosses
   * the wire is a name the recipient's hub goes looking for a SONG by, and
   * "Chapter 3" by Ada Sorrel either finds nothing or finds something else.
   *
   * The screen already reshapes itself for a book, and the header's bookmark
   * (where a song's Add-to-playlist sits) is the proof that this IS the book's
   * Now Playing and not a song's.
   */
  const context = await contextAs(browser, world, 'kim');
  await useLocalRegistry(context, world);
  await seedIdentity(context, sender);
  const page = await context.newPage();
  await soloDeck(page, world);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Library section' }).getByText('Books', { exact: true }).click();
  await page.getByRole('button', { name: 'Chapters of The Long Ascent' }).click();
  const chapters = page.getByRole('dialog', { name: 'The Long Ascent' });
  await expect(chapters).toBeVisible();
  await chapters.getByRole('button', { name: /(^|\s)Chapter 3$/ }).click();

  await expect(nowPlaying(page)).toBeVisible({ timeout: 20_000 });
  await expect(nowPlaying(page).getByRole('button', { name: 'Bookmark this place' })).toBeVisible();
  await expect(sendSeat(page)).toHaveCount(0);
  await context.close();
});

test('with no central account there is no seat at all, rather than one that fails', async ({
  browser,
  world,
}) => {
  // The drawer needs a registry token to fetch a friends list; without one it
  // would spin for ever. So the seat is not there - which is also what the
  // song's own menu does, on the same test. The heart proves the row it would
  // have sat in is drawn.
  const { context, page } = await listening(browser, world, null);
  await expect(nowPlaying(page).locator('.npScreen__heart')).toBeVisible();
  await expect(sendSeat(page)).toHaveCount(0);
  await context.close();
});
