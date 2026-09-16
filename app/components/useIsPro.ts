"use client";

import { useEffect, useState } from "react";

export function useIsPro(): { isPro: boolean; isAdmin: boolean; loading: boolean } {
  const [isPro, setIsPro] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    function handleProStatus(event: Event) {
      if ((event as CustomEvent<boolean>).detail) setIsPro(true);
    }
    window.addEventListener("neuralboard:pro-status", handleProStatus);
    fetch("/api/user/me")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setIsPro(!!d.isPro);
        setIsAdmin(!!d.isAdmin);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => window.removeEventListener("neuralboard:pro-status", handleProStatus);
  }, []);

  return { isPro, isAdmin, loading };
}
