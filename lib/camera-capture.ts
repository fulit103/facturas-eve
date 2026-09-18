export function cameraPhotoFileName(now = new Date()): string {
  const timestamp = now
    .toISOString()
    .replaceAll(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  return `camara-${timestamp}.png`;
}

export async function blobToPngFile(blob: Blob, now = new Date()): Promise<File> {
  return new File([blob], cameraPhotoFileName(now), {
    lastModified: now.getTime(),
    type: "image/png",
  });
}

export async function acquireCameraStream(options: {
  readonly requestAccess?: () => Promise<unknown>;
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
} = {}): Promise<MediaStream> {
  await options.requestAccess?.();
  const getUserMedia =
    options.getUserMedia ??
    (typeof navigator !== "undefined" ? navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices) : undefined);
  if (getUserMedia === undefined) {
    throw new Error("Este entorno no puede usar la cámara.");
  }
  return getUserMedia({ audio: false, video: true });
}

export async function bindCameraStream(
  video: HTMLVideoElement,
  stream: MediaStream,
): Promise<void> {
  for (const track of stream.getVideoTracks?.() ?? []) {
    track.enabled = true;
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;

  const waitForMetadata =
    video.readyState >= 1
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const onLoaded = () => resolve();
          const onError = () => reject(new Error("No se pudo mostrar la cámara."));
          video.addEventListener("loadedmetadata", onLoaded, { once: true });
          video.addEventListener("error", onError, { once: true });
        });

  await waitForMetadata;
  await video.play();
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    throw new Error("La cámara no envió imagen.");
  }
}

export async function captureVideoFrameToPngFile(video: HTMLVideoElement): Promise<File | null> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!blob) return null;
  return blobToPngFile(blob);
}

export function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "No hay permiso para usar la cámara.";
    }
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
      return "No encontré una cámara en este equipo.";
    }
    if (error.name === "NotReadableError") {
      return "La cámara está ocupada por otra app.";
    }
    if (error.name === "AbortError") {
      return "Se canceló el acceso a la cámara.";
    }
  }
  return error instanceof Error ? error.message : "No se pudo abrir la cámara.";
}
