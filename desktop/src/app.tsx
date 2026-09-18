import { TooltipProvider } from "@/components/ui/tooltip";
import { useCallback, useEffect, useState } from "react";
import type { DesktopState } from "./desktop-bridge";
import { DesktopChat } from "./desktop-chat";
import { LoginForm } from "./login";

export function App() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (window.facturasDesktop == null) {
      setError(
        "No se pudo conectar con el proceso de Electron. Cerrá la ventana y volvé a correr pnpm dev:desktop.",
      );
      return;
    }
    try {
      setError(undefined);
      setState(await window.facturasDesktop.getState());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo leer el estado de la app.");
    }
  }, []);

  const handleLogout = useCallback(async () => {
    if (window.facturasDesktop == null) {
      setError("No se pudo cerrar la sesión. Reiniciá la app.");
      return;
    }
    try {
      await window.facturasDesktop.logout();
      window.location.hash = "#/";
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cerrar la sesión.");
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error !== undefined && state === null) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-sm">
        <p className="max-w-md text-destructive">{error}</p>
      </main>
    );
  }

  if (state === null) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-muted-foreground text-sm">
        Cargando…
      </main>
    );
  }

  if (!state.loggedIn) {
    return (
      <TooltipProvider>
        <LoginForm initial={state} onLoggedIn={() => void refresh()} />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <DesktopChat host={state.proxyOrigin} onLogout={() => void handleLogout()} />
    </TooltipProvider>
  );
}
