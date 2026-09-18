"use client";

import { CameraIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  PromptInputButton,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import {
  acquireCameraStream,
  bindCameraStream,
  cameraErrorMessage,
  captureVideoFrameToPngFile,
} from "@/lib/camera-capture";

export function CameraCaptureButton() {
  const attachments = usePromptInputAttachments();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const close = () => {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    setStream(null);
    setError(undefined);
  };

  const open = async () => {
    setPending(true);
    setError(undefined);
    try {
      const next = await acquireCameraStream({
        requestAccess: () => window.facturasDesktop?.requestCameraAccess() ?? Promise.resolve(),
      });
      setStream(next);
    } catch (cause) {
      setError(cameraErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PromptInputButton
        aria-label="Tomar foto"
        disabled={pending}
        onClick={() => void open()}
        title="Tomar foto"
      >
        <CameraIcon className="size-4" />
      </PromptInputButton>
      {stream !== null || error !== undefined ? (
        <CameraOverlay
          error={error}
          onCancel={close}
          onCapture={(file) => {
            attachments.clear();
            attachments.add([file]);
            close();
          }}
          stream={stream}
        />
      ) : null}
    </>
  );
}

function CameraOverlay({
  stream,
  error,
  onCancel,
  onCapture,
}: {
  readonly stream: MediaStream | null;
  readonly error?: string;
  readonly onCancel: () => void;
  readonly onCapture: (file: File) => void;
}) {
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const [bindError, setBindError] = useState<string>();
  const [capturing, setCapturing] = useState(false);
  const [mounted, setMounted] = useState(false);
  const message = error ?? bindError;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (videoEl === null || stream === null) return;
    let cancelled = false;
    setReady(false);
    setBindError(undefined);
    void bindCameraStream(videoEl, stream).then(
      () => {
        if (!cancelled) setReady(true);
      },
      (cause: unknown) => {
        if (!cancelled) setBindError(cameraErrorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
      videoEl.srcObject = null;
    };
  }, [stream, videoEl]);

  const handleCapture = async () => {
    if (videoEl === null) return;
    setCapturing(true);
    try {
      const file = await captureVideoFrameToPngFile(videoEl);
      if (file === null) {
        setBindError("No se pudo capturar la foto. Probá de nuevo.");
        return;
      }
      onCapture(file);
    } finally {
      setCapturing(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl space-y-4 rounded-lg border bg-background p-6 shadow-lg">
        <div className="space-y-1">
          <h2 className="font-semibold text-lg">Fotografiar factura</h2>
          <p className="text-muted-foreground text-sm">
            Encuadrá el documento y capturá. Se adjunta como PNG.
          </p>
        </div>
        <div className="overflow-hidden rounded-lg bg-black">
          <video
            autoPlay
            className="aspect-video min-h-48 w-full bg-black object-contain"
            muted
            playsInline
            ref={setVideoEl}
          />
        </div>
        {message ? <p className="text-destructive text-sm">{message}</p> : null}
        {stream !== null && !ready && message === undefined ? (
          <p className="text-muted-foreground text-sm">Mostrando la cámara…</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} type="button" variant="outline">
            Cancelar
          </Button>
          <Button disabled={!ready || capturing} onClick={() => void handleCapture()} type="button">
            {capturing ? "Capturando…" : "Capturar"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
