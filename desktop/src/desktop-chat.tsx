import { AgentChat } from "@/app/_components/agent-chat";
import { useEffect, useRef, useState } from "react";
import { hashForNewChat, hashForSession, sessionIdFromHash } from "./session-hash";

export function DesktopChat({
  host,
  onLogout,
}: {
  readonly host: string;
  readonly onLogout: () => void;
}) {
  const [sessionId, setSessionId] = useState<string | undefined>(() => sessionIdFromHash());
  const ignoreOwnHashWrite = useRef(false);

  useEffect(() => {
    const onHashChange = () => {
      if (ignoreOwnHashWrite.current) {
        ignoreOwnHashWrite.current = false;
        return;
      }
      setSessionId(sessionIdFromHash());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <AgentChat
      host={host}
      key={sessionId ?? "new"}
      onLogout={onLogout}
      onNewChat={() => {
        ignoreOwnHashWrite.current = true;
        window.location.hash = hashForNewChat();
        setSessionId(undefined);
      }}
      onSessionPath={(nextSessionId) => {
        ignoreOwnHashWrite.current = true;
        window.location.hash = hashForSession(nextSessionId);
      }}
      sessionId={sessionId}
      sessionless={sessionId === undefined}
    />
  );
}
