import i18next from 'i18next';

/**
 * The translator for code that is NOT a component - a notification body, a
 * share sheet's text, anything built in a plain function.
 *
 * NOT REACTIVE, deliberately: it reads whatever language i18next is in at the
 * moment it is called, and nothing re-runs when that changes. That is right
 * for a string handed to the OS and wrong for one on screen, so anything
 * inside a render should use useT() instead and will re-render properly.
 */
export function translate(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, { ns: 'app', ...options });
}
