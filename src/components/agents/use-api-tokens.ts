"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiErrorText, type ApiTokenDto } from "@/lib/api";

export interface ApiTokens {
  /** null until the first response; a failed refresh keeps the last good list. */
  tokens: ApiTokenDto[] | null;
  error: string | null;
  reload: () => Promise<void>;
  /** Change one row in place: an optimistic switch, or a rename the server confirmed. */
  patch: (id: string, changes: Partial<ApiTokenDto>) => void;
}

/** The signed-in user's API keys. Only the newest response is applied, and nothing lands after unmount. `initial` seeds the list (server-rendered). */
export function useApiTokens(active = true, initial: ApiTokenDto[] | null = null): ApiTokens {
  const [tokens, setTokens] = useState<ApiTokenDto[] | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const newest = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const request = ++newest.current;
    try {
      const res = await api.tokens.list();
      if (!mounted.current || request !== newest.current) return;
      setTokens(res.tokens);
      setError(null);
    } catch (e) {
      if (!mounted.current || request !== newest.current) return;
      setError(apiErrorText(e, "Could not load your keys."));
    }
  }, []);

  useEffect(() => {
    if (active) void reload();
  }, [active, reload]);

  const patch = useCallback((id: string, changes: Partial<ApiTokenDto>) => {
    setTokens((list) => list?.map((key) => (key.id === id ? { ...key, ...changes } : key)) ?? list);
  }, []);

  return { tokens, error, reload, patch };
}
