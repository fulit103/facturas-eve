import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { DesktopState } from "./desktop-bridge";

export function LoginForm({
  initial,
  onLoggedIn,
}: {
  readonly initial: DesktopState;
  readonly onLoggedIn: () => void;
}) {
  const [host, setHost] = useState(initial.host);
  const [username, setUsername] = useState(initial.username);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await window.facturasDesktop?.login({ host, username, password });
      onLoggedIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar la sesión.");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground">
      <form className="w-full max-w-sm space-y-5" onSubmit={(event) => void handleSubmit(event)}>
        <div className="space-y-1">
          <h1 className="font-medium text-3xl tracking-tight">Facturas</h1>
          <p className="text-muted-foreground text-sm">
            Conectá al agente eve. En local podés dejar usuario y contraseña vacíos.
          </p>
        </div>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Host del agente</span>
          <input
            className="h-9 w-full rounded-md border border-input bg-background px-3"
            onChange={(event) => setHost(event.currentTarget.value)}
            required
            type="url"
            value={host}
          />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Usuario</span>
          <input
            autoComplete="username"
            className="h-9 w-full rounded-md border border-input bg-background px-3"
            onChange={(event) => setUsername(event.currentTarget.value)}
            value={username}
          />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Contraseña</span>
          <input
            autoComplete="current-password"
            className="h-9 w-full rounded-md border border-input bg-background px-3"
            onChange={(event) => setPassword(event.currentTarget.value)}
            type="password"
            value={password}
          />
        </label>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <Button className="w-full" disabled={pending} type="submit">
          {pending ? "Guardando…" : "Entrar"}
        </Button>
      </form>
    </main>
  );
}
