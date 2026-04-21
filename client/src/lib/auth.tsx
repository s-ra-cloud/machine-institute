import { createContext, useContext, useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

interface AuthUser {
  id: string;
  email: string | null;
  displayName: string | null;
}

interface AuthState {
  authenticated: boolean;
  validated: boolean;
  user: AuthUser | null;
  isAdmin: boolean;
  isLoading: boolean;
  login: () => void;
  logout: () => Promise<void>;
}

const ADMIN_EMAIL = "sacharaoult@gmail.com";

const AuthContext = createContext<AuthState>({
  authenticated: false,
  validated: false,
  user: null,
  isAdmin: false,
  isLoading: true,
  login: () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{
    authenticated: boolean;
    validated?: boolean;
    user?: AuthUser;
  }>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me");
      return res.json();
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (!isLoading && data?.authenticated && data?.validated === false) {
      fetch("/api/auth/refresh", { method: "POST" })
        .then(r => r.ok ? r.json() : null)
        .then(result => {
          if (result?.validated) {
            queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
          }
        })
        .catch(() => {});
    }
  }, [isLoading, data?.authenticated, data?.validated, queryClient]);

  const login = useCallback(() => {
    window.location.href = "/api/auth/login";
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
  }, [queryClient]);

  const value: AuthState = {
    authenticated: data?.authenticated ?? false,
    validated: data?.validated ?? false,
    user: data?.user ?? null,
    isAdmin: data?.user?.email === ADMIN_EMAIL,
    isLoading,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
