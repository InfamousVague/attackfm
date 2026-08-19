/**
 * The server this build points at before anyone has chosen one.
 *
 * Empty for the installed apps, deliberately: someone who downloaded AttackFM
 * to run their OWN library should not be handed somebody else's address, and
 * the field they meet is the honest question "where is your server?".
 *
 * The hosted player at attack.fm/listen is the opposite case. It is reached
 * from a page advertising one particular library, by people who mostly do not
 * have a server of their own yet, and meeting an empty box that says
 * "music.example.com" tells them nothing about where they just arrived. So that
 * build sets VITE_DEFAULT_SERVER (see scripts/deploy-listen.mjs) and the field
 * arrives filled in, still editable.
 */
const configured = (import.meta.env?.VITE_DEFAULT_SERVER as string | undefined)?.trim() ?? '';

/** The address to offer first, or '' when this build has no opinion. */
export const DEFAULT_SERVER = configured.replace(/\/+$/, '');

/** True when this build was made to point at one particular server. */
export const hasDefaultServer = DEFAULT_SERVER.length > 0;
