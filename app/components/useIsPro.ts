"use client";

import { useEffect, useState } from "react";

export function useIsPro(): { isPro: boolean; loading: boolean } {
  const [isPro, setIsPro] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/user/me")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setIsPro(!!d.isPro))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { isPro, loading };
}
