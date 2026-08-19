/**
 * Storage keys shared by the identity provider and the settings sync.
 *
 * Its own file to break a cycle: registrySession mounts the sync, and the sync
 * needs to read the stored identity. Importing the key from the provider worked
 * only because the read happens inside a function - at module scope it would
 * have been undefined, which is the kind of bug that shows up as "sync silently
 * never runs" long after anyone remembers why these import each other.
 */

/** Where the signed-in registry identity is persisted. */
export const REGISTRY_SESSION_KEY = 'attackfm-registry-session';
