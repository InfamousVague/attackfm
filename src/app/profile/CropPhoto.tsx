import { useCallback, useState } from 'react';
import Cropper from 'react-easy-crop';
import { Button, Modal, Slider, Text } from '@glacier/react';
import { ZoomIn, ZoomOut } from '@glacier/icons';
import { aspectOf, cropToBlob, type CropArea, type ImageKind } from './pickImage.ts';

/**
 * Where in the picture, and how close.
 *
 * A profile picture is a circle and a banner is a band, and until now a
 * photograph became either by having its middle taken and the rest silently
 * discarded - so a portrait of two people became a portrait of whoever stood
 * in the centre. This is the step that was missing: the picture arrives, and
 * you say which part of it is the picture.
 *
 * `react-easy-crop` does the hard half. It is worth naming what it brings that
 * a hand-rolled drag would not: pinch-to-zoom and drag on touch, the crop
 * window kept inside the image so you cannot pan off into empty space, and a
 * reported rectangle in the SOURCE image's own pixels - which is what lets the
 * output be cut from the full-resolution original rather than from whatever
 * was on screen. Its stylesheet does the geometry and ours does the look; the
 * dialog around it, and every control on it, is Glacier's.
 *
 * The dialog is a Glacier Modal, so it inherits the things a dialog has to get
 * right and which are invisible when they work: focus trapped inside, Escape
 * and overlay-press to dismiss, body scroll locked behind it, and focus handed
 * back to whatever opened it.
 */

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

export function CropPhoto({
  src,
  kind,
  busy,
  onCancel,
  onDone,
}: {
  /** An object URL for a freshly chosen file, or the URL of the picture
   *  already in use when this is a reposition. */
  src: string;
  kind: ImageKind;
  /** The upload is in flight: the dialog stays up and says so, because
   *  closing it would look like the picture had been discarded. */
  busy?: boolean;
  onCancel: () => void;
  onDone: (blob: Blob) => void;
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<CropArea | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cutting, setCutting] = useState(false);

  const onCropComplete = useCallback((_: unknown, pixels: CropArea) => {
    setArea(pixels);
  }, []);

  const confirm = async () => {
    if (!area) return;
    setCutting(true);
    setError(null);
    try {
      onDone(await cropToBlob(src, area, kind));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That picture could not be prepared.');
    } finally {
      setCutting(false);
    }
  };

  const working = cutting || busy === true;

  return (
    <Modal
      open
      onClose={() => {
        if (!working) onCancel();
      }}
      title={kind === 'avatar' ? 'Your picture' : 'Your banner'}
      description={
        kind === 'avatar'
          ? 'Drag to move, pinch or use the slider to zoom.'
          : 'Drag to choose the strip that shows across the top.'
      }
      size="md"
      footer={
        <div className="cropPhoto__actions">
          <Button variant="ghost" onClick={onCancel} disabled={working}>
            Cancel
          </Button>
          <Button variant="solid" onClick={() => void confirm()} disabled={!area || working}>
            {working ? 'Saving…' : 'Use this'}
          </Button>
        </div>
      }
    >
      <div className="cropPhoto">
        <div className="cropPhoto__stage" data-kind={kind}>
          <Cropper
            image={src}
            crop={crop}
            zoom={zoom}
            aspect={aspectOf(kind)}
            cropShape={kind === 'avatar' ? 'round' : 'rect'}
            showGrid={kind === 'banner'}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            restrictPosition
            objectFit="contain"
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
            // Anonymous, so repositioning a picture already on the registry
            // draws into an untainted canvas. See loadImage in pickImage.ts.
            mediaProps={{ crossOrigin: 'anonymous' }}
            // The library's own stylesheet is left ON. It is entirely
            // class-scoped (.reactEasyCrop_*, no tag selectors) and it carries
            // the LAYOUT - the container's centring, the contain-fit
            // positioning, the crop window's translate. Turning it off, which
            // this did at first, does not just lose the round shape on a
            // face: it loses the geometry that makes the thing work at all.
            // The classes below are overrides layered on top of it.
            classes={{
              containerClassName: 'cropPhoto__container',
              mediaClassName: 'cropPhoto__media',
              cropAreaClassName: 'cropPhoto__area',
            }}
          />
        </div>

        <div className="cropPhoto__zoom">
          <ZoomOut size={16} aria-hidden />
          <Slider
            value={zoom}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            aria-label="Zoom"
            onValueChange={setZoom}
          />
          <ZoomIn size={16} aria-hidden />
        </div>

        {error && (
          <Text size="sm" tone="danger">
            {error}
          </Text>
        )}
      </div>
    </Modal>
  );
}
