import QRCode from 'qrcode';

/**
 * The two things a groove's share card needs that are not React: the hub's
 * address as people say it, and the room's link as a scannable tile. Both are
 * wanted by the deck's invite card as well as by the sheet next door, so they
 * live where either can reach them without pulling a sheet in behind.
 */

/** The address as people say it - the host, no scheme. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

/**
 * The room's link as a QR, drawn the same wherever it goes - the share card
 * and the groove deck's invite card: dark modules on a white tile, because a
 * scanner wants that contrast whatever the theme, and one quiet module of
 * margin. `width` is the tile's pixel size.
 */
export function jamQrDataUrl(link: string, width: number): Promise<string> {
  return QRCode.toDataURL(link, { margin: 1, width, color: { dark: '#101014', light: '#ffffff' } });
}
