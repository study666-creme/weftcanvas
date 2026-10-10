import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";

export function useInViewport<T extends Element>(options: { rootMargin?: string; once?: boolean } = {}) {
  const [inViewport, setInViewport] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const ref = useCallback<RefCallback<T>>((element) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!element || typeof IntersectionObserver === "undefined") {
      setInViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setInViewport(entry.isIntersecting);
      if (entry.isIntersecting && optionsRef.current.once) observer.disconnect();
    }, { rootMargin: optionsRef.current.rootMargin });
    observerRef.current = observer;
    observer.observe(element);
  }, []);

  useEffect(() => () => {
    if (observerRef.current) observerRef.current.disconnect();
  }, []);

  return { ref, inViewport };
}
