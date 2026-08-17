import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';

/**
 * A best-effort QR camera. It opens the back camera, decodes frames with jsQR,
 * and calls `onResult` with the first code it reads. Where there is no camera
 * or permission is refused - which includes some webviews - it reports
 * `onUnavailable` once and renders nothing, so the caller can fall back to the
 * typed-code path rather than showing a dead black box.
 *
 * Deliberately self-contained: it owns the <video>, the scan loop, and the
 * MediaStream, and tears all three down on unmount so the camera light does not
 * stay on after the sheet closes.
 */
export function QrScanner({
  onResult,
  onUnavailable,
}: {
  onResult: (text: string) => void;
  onUnavailable?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  // Latest onResult without restarting the camera when the callback identity
  // changes - the stream should open exactly once.
  const resultRef = useRef(onResult);
  resultRef.current = onResult;
  const unavailRef = useRef(onUnavailable);
  unavailRef.current = onUnavailable;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const scan = () => {
      const video = videoRef.current;
      if (done || !video || !ctx || video.readyState < 2) {
        raf = requestAnimationFrame(scan);
        return;
      }
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w && h) {
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const image = ctx.getImageData(0, 0, w, h);
        const found = jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' });
        if (found?.data) {
          done = true;
          resultRef.current(found.data);
          return;
        }
      }
      raf = requestAnimationFrame(scan);
    };

    const noCamera =
      typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia;
    if (noCamera) {
      unavailRef.current?.();
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((s) => {
        if (done) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = s;
        // iOS needs these to autoplay an inline camera without user tap.
        video.setAttribute('playsinline', 'true');
        video.muted = true;
        void video.play().catch(() => {});
        setReady(true);
        raf = requestAnimationFrame(scan);
      })
      .catch(() => unavailRef.current?.());

    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="qrScanner" data-ready={ready || undefined}>
      <video ref={videoRef} className="qrScanner__video" playsInline muted />
      <div className="qrScanner__frame" aria-hidden="true" />
    </div>
  );
}
