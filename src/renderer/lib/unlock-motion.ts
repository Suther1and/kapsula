// On Windows, turning off OS window minimize/maximize animations ("Visual Effects")
// flips Chromium's `(prefers-reduced-motion: reduce)` media query to true and silently
// disables every in-app animation (Framer Motion, Animate UI, lucide-animated, NumberFlow).
// Running this module first ensures Kapsula's own micro-animations stay active unless
// explicitly disabled inside the app (`data-reduced-motion="true"`).
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const nativeMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query: string): MediaQueryList => {
    const mql = nativeMatchMedia(query);
    if (query.includes('prefers-reduced-motion') && query.includes('reduce')) {
      return new Proxy(mql, {
        get(target, prop, receiver) {
          if (prop === 'matches') {
            return document.documentElement.dataset.reducedMotion === 'true';
          }
          const val = Reflect.get(target, prop, receiver);
          return typeof val === 'function' ? val.bind(target) : val;
        },
      });
    }
    return mql;
  };
}
