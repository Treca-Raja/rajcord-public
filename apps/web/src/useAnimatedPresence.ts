import { useEffect, useState } from 'react';

export function useAnimatedPresence(open: boolean) {
  const [retained, setRetained] = useState(open);
  useEffect(() => {
    if (open) {
      setRetained(true);
      return;
    }
    const timer = setTimeout(
      () => setRetained(false),
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160,
    );
    return () => clearTimeout(timer);
  }, [open]);
  return open || retained;
}
