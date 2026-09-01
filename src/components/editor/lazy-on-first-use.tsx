import dynamic from "next/dynamic";
import { startTransition, useEffect, useState, type ComponentType, type ReactElement } from "react";

/** Modules a `lazyOnFirstUse` component has loaded, by their `load`; later first mounts from the same module skip the boundary. */
const loadedModules = new WeakMap<() => Promise<unknown>, unknown>();

/**
 * `next/dynamic` with `ssr: false` for UI that is mounted the first time the user asks for it — a side
 * panel, a dialog, the palette — plus one nudge so that first appearance is not held back by React.
 *
 * A `React.lazy` component suspends on its very first render even when its module is already cached, and
 * react-dom commits a retry-only re-render of a boundary that has just shown its fallback no earlier than
 * 300 ms after that fallback (`FALLBACK_THROTTLE_MS`; a `null` fallback counts, and so does a transition,
 * because a boundary mounted by the same render is the shell). So a dialog opened for the first time on a
 * fast connection would appear ~300 ms after the click although its chunk landed in 20. The wrapper calls
 * the same `load()` and sets state once the module promise settles: that ordinary update re-renders the
 * boundary outside the retry lane, so the content is committed as soon as the chunk is in.
 *
 * Once a module is in, every component picked from it mounts in the same commit as the state update that
 * asked for it, exactly like a static import — not only the component that loaded it. Each `React.lazy`
 * suspends on its own first render even when its module is long cached, and that one deferred commit is
 * enough to break a focus hand-off: a dialog opened from the ⋮ menu must mount while the menu item still
 * has focus (`RememberOpener` in ui/dialog.tsx) and before the closing menu hands focus back to its trigger
 * in a `setTimeout(0)`; a dialog mounted a task later had its `autoFocus` input robbed by that hand-back.
 *
 * `load` must be the module's one `import()` (hoisted, and reused by any prefetch): an `import()` written
 * inside `dynamic()` is rewritten by Next into its own facade module, so a second `import()` of the same
 * file elsewhere would produce a duplicate chunk of the same code.
 */
export function lazyOnFirstUse<M, P extends object>(
  load: () => Promise<M>,
  pick: (mod: M) => ComponentType<P>,
  loading?: () => ReactElement | null,
): ComponentType<P> {
  // `next/dynamic` requires an object literal here (its compile-time transform reads it).
  const Loadable = dynamic(() => load().then(pick), { ssr: false, loading });
  function LazyOnFirstUse(props: P) {
    // Decided once per instance: swapping the boundary for the component after mount would remount it.
    const [Ready] = useState<ComponentType<P> | null>(() => {
      const mod = loadedModules.get(load) as M | undefined;
      return mod ? pick(mod) : null;
    });
    const [, setLoaded] = useState(false);
    useEffect(() => {
      if (Ready) return;
      let live = true;
      load().then(
        (mod) => {
          loadedModules.set(load, mod);
          // As a transition, so the re-render runs in a later task: when the module was already loaded (a
          // prefetch, a sibling from the same chunk) this promise settles inside the click's own microtasks,
          // where a plain state update would be flushed synchronously — before `React.lazy` has recorded the
          // resolved module — and the boundary would suspend again into the throttled retry.
          if (live) startTransition(() => setLoaded(true));
        },
        () => undefined,
      );
      return () => {
        live = false;
      };
    }, [Ready]);
    return Ready ? <Ready {...props} /> : <Loadable {...props} />;
  }
  LazyOnFirstUse.displayName = "LazyOnFirstUse";
  return LazyOnFirstUse;
}
