import { describe, expect, it } from "vitest";
import { acquireCameraStream, bindCameraStream, blobToPngFile, cameraPhotoFileName } from "../lib/camera-capture";
import {
  isDesktopMediaPermission,
  shouldAllowDesktopPermissionCheck,
} from "../lib/desktop-media-permission";

describe("cameraPhotoFileName", () => {
  it("usa un nombre PNG estable a partir de la fecha", () => {
    expect(cameraPhotoFileName(new Date("2026-09-18T01:02:03.004Z"))).toBe(
      "camara-2026-09-18_01-02-03-004.png",
    );
  });
});

describe("blobToPngFile", () => {
  it("arma un File image/png listo para adjuntar", async () => {
    const file = await blobToPngFile(new Blob(["png"], { type: "image/png" }), new Date("2026-09-18T01:02:03.004Z"));
    expect(file.type).toBe("image/png");
    expect(file.name).toBe("camara-2026-09-18_01-02-03-004.png");
  });
});

describe("bindCameraStream", () => {
  it("asigna el stream y espera un frame con tamaño", async () => {
    const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
    const video = {
      srcObject: null as MediaStream | null,
      muted: false,
      playsInline: false,
      videoWidth: 1280,
      videoHeight: 720,
      readyState: 1,
      play: async () => undefined,
      addEventListener: () => undefined,
    };

    await bindCameraStream(video as unknown as HTMLVideoElement, stream);

    expect(video.srcObject).toBe(stream);
    expect(video.muted).toBe(true);
  });

  it("falla si la cámara no entrega imagen", async () => {
    const video = {
      srcObject: null,
      muted: false,
      playsInline: false,
      videoWidth: 0,
      videoHeight: 0,
      readyState: 1,
      play: async () => undefined,
      addEventListener: () => undefined,
    };

    await expect(
      bindCameraStream(
        video as unknown as HTMLVideoElement,
        { getVideoTracks: () => [] } as unknown as MediaStream,
      ),
    ).rejects.toThrow("La cámara no envió imagen");
  });
});

describe("isDesktopMediaPermission", () => {
  it("permite cámara y media de Chromium", () => {
    expect(isDesktopMediaPermission("media")).toBe(true);
    expect(isDesktopMediaPermission("camera")).toBe(true);
  });

  it("rechaza el resto de permisos", () => {
    expect(isDesktopMediaPermission("geolocation")).toBe(false);
    expect(isDesktopMediaPermission("notifications")).toBe(false);
  });
});

describe("shouldAllowDesktopPermissionCheck", () => {
  it("permite cualquier check del renderer local", () => {
    expect(shouldAllowDesktopPermissionCheck("fullscreen", "http://localhost:5173")).toBe(true);
    expect(shouldAllowDesktopPermissionCheck("media", "http://127.0.0.1:3000")).toBe(true);
  });

  it("permite media aunque el origin no sea el esperado", () => {
    expect(shouldAllowDesktopPermissionCheck("camera", "https://example.com")).toBe(true);
  });

  it("rechaza permisos no media de otro origin", () => {
    expect(shouldAllowDesktopPermissionCheck("geolocation", "https://example.com")).toBe(false);
  });
});

describe("acquireCameraStream", () => {
  it("pide acceso y después abre getUserMedia", async () => {
    const order: string[] = [];
    const stream = { id: "cam" } as unknown as MediaStream;
    const result = await acquireCameraStream({
      requestAccess: async () => {
        order.push("access");
      },
      getUserMedia: async () => {
        order.push("media");
        return stream;
      },
    });
    expect(order).toEqual(["access", "media"]);
    expect(result).toBe(stream);
  });
});
