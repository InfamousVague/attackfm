/**
 * A tap is not a hover, and the phone has been pretending otherwise.
 *
 * Touch has no pointer-leave. Tap a button on iOS or Android and the engine
 * applies `:hover` to satisfy the stylesheet, then has no event with which to
 * take it away again - so the button keeps its hover paint until you tap
 * something else, which is the only thing that moves the phantom pointer. Every
 * button in the app was doing this, because between the app's own stylesheets
 * and the vendored kit there were 193 `:hover` rules and exactly one of them
 * was guarded.
 *
 * The web's answer is `@media (hover: hover)`: a query that is false on a
 * touch-primary device, so the rules simply never apply there and there is no
 * state left over to be stuck in. Desktop is untouched - the query is true, the
 * rules match, nothing about a mouse changes.
 *
 * ## Why a build step rather than 193 edits
 *
 * Because 89 of them are in `vendor/@glacier/react/dist/styles.css`, which is a
 * BUILD ARTIFACT. Editing it works until the next kit sync silently reverts the
 * lot, and rebuilding the kit from source ships whatever else is uncommitted in
 * that working tree along with it. Doing it here catches both stylesheets on
 * the way through Vite, survives the next `cp` over the vendored dist, and
 * covers rules nobody has written yet.
 *
 * ## Why the selector list is split rather than wrapped
 *
 * The kit writes `a:hover, a:focus-visible { ... }` constantly - one rule
 * serving mouse and keyboard together. Wrapping that whole rule would take the
 * keyboard's focus ring away from anyone on a tablet, which is a worse bug than
 * the one being fixed and an invisible one. So the list is split: the `:hover`
 * halves move into the query and everything else stays exactly where it was.
 *
 * Checked before writing this, and worth re-checking if it ever misbehaves:
 * neither stylesheet contains `:not(:hover)` (which INVERTS the sense, so
 * hiding it from touch would change how the page looks rather than only what it
 * does on a pointer), nor `:hover` nested inside `:is()`/`:where()`, which this
 * splits by whole selector and could not take apart.
 */

const HOVER = /:hover\b/;

/** Already inside a hover query - either hand-written or one of ours from an
 *  earlier pass. Without this the walker would re-wrap its own output forever. */
function insideHoverQuery(rule) {
  for (let node = rule.parent; node; node = node.parent) {
    if (node.type === 'atrule' && node.name === 'media' && /hover\s*:/i.test(node.params)) {
      return true;
    }
  }
  return false;
}

export default function hoverIsNotATap() {
  return {
    postcssPlugin: 'attackfm-hover-is-not-a-tap',
    OnceExit(root, { AtRule }) {
      root.walkRules((rule) => {
        if (!HOVER.test(rule.selector) || insideHoverQuery(rule)) return;

        const hoverSelectors = rule.selectors.filter((s) => HOVER.test(s));
        const rest = rule.selectors.filter((s) => !HOVER.test(s));

        const guarded = new AtRule({ name: 'media', params: '(hover: hover)' });
        guarded.append(rule.clone({ selectors: hoverSelectors }));
        rule.after(guarded);

        // Whatever was sharing the rule keeps its place in the cascade. Order
        // matters here: the guarded copy is inserted immediately after, so two
        // declarations of equal specificity still resolve the way the author
        // wrote them.
        if (rest.length > 0) rule.selectors = rest;
        else rule.remove();
      });
    },
  };
}

hoverIsNotATap.postcss = true;
