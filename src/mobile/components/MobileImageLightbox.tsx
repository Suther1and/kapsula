import React, { useEffect, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { MagnifyingGlassMinus, MagnifyingGlassPlus, X } from '@phosphor-icons/react';
import { pushBackHandler } from '../lib/back-stack';
import { useMobileI18n } from '../lib/mobile-i18n';

interface MobileImageLightboxProps {
  src: string | null;
  caption?: string;
  onClose: () => void;
}

/**
 * Fullscreen mobile photo viewer with double-tap & button zoom (1x -> 2.4x) and Back button support.
 */
export const MobileImageLightbox: React.FC<MobileImageLightboxProps> = ({
  src,
  caption,
  onClose,
}) => {
  const { t } = useMobileI18n();
  const [scale, setScale] = useState(1);

  useEffect(() => {
    setScale(1);
    if (!src) return;
    return pushBackHandler(onClose);
  }, [src, onClose]);

  const toggleZoom = () => {
    setScale((s) => (s > 1.2 ? 1 : 2.2));
  };

  return (
    <Dialog.Root
      open={Boolean(src)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/92 backdrop-blur-md transition-opacity duration-150" />
        <Dialog.Popup
          data-testid="mobile-image-lightbox"
          className="fixed inset-0 z-[71] flex flex-col outline-none"
        >
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-black/50 text-white shrink-0">
            <Dialog.Title className="text-[14px] font-medium truncate flex-1">
              {caption || t('lightbox.defaultCaption')}
            </Dialog.Title>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setScale((s) => Math.max(1, Number((s - 0.6).toFixed(1))))}
                aria-label={t('lightbox.zoomOut')}
                className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-xl bg-white/12 text-white"
              >
                <MagnifyingGlassMinus className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setScale((s) => Math.min(3, Number((s + 0.6).toFixed(1))))}
                aria-label={t('lightbox.zoomIn')}
                className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-xl bg-white/12 text-white"
              >
                <MagnifyingGlassPlus className="w-4 h-4" />
              </button>
              <Dialog.Close
                aria-label={t('lightbox.close')}
                className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-xl bg-white/15 text-white"
              >
                <X className="w-4 h-4" />
              </Dialog.Close>
            </div>
          </div>

          <div
            onClick={onClose}
            className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4"
          >
            {src ? (
              <img
                src={src}
                alt={caption || t('common.photo')}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleZoom();
                }}
                style={{
                  transform: `scale(${scale})`,
                  transformOrigin: 'center center',
                  transition: 'transform 180ms var(--k-ease-out)',
                }}
                className="max-w-full max-h-full object-contain rounded-xl select-none cursor-zoom-in"
              />
            ) : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
