import React, { useEffect, useState } from 'react';
import { useMobileMediaCache } from '../lib/media-cache-context';

interface MobileMediaImageProps {
  localName?: string | null;
  fallbackUrl?: string | null;
  ensureMediaUrl: (localName?: string | null) => Promise<string | null>;
  alt: string;
  className?: string;
  wrapperClassName?: string;
  onImageClick?: (resolvedSrc: string) => void;
  children?: React.ReactNode;
}

/**
 * Lazy-loaded media image backed by IndexedDB LRU cache with graceful onError fallback
 * and optional fullscreen lightbox click handler.
 */
export const MobileMediaImage: React.FC<MobileMediaImageProps> = ({
  localName,
  fallbackUrl,
  ensureMediaUrl,
  alt,
  className = '',
  wrapperClassName = '',
  onImageClick,
  children,
}) => {
  const { retainMediaUrl, releaseMediaUrl } = useMobileMediaCache();
  const [src, setSrc] = useState<string | null>(
    localName && /^(?:https?:|data:|blob:)/i.test(localName)
      ? localName
      : !localName && fallbackUrl
        ? fallbackUrl
        : null
  );
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
    if (!localName) {
      setSrc(fallbackUrl || null);
      return;
    }
    if (/^(?:https?:|data:|blob:)/i.test(localName)) {
      setSrc(localName);
      return;
    }
    let cancelled = false;
    retainMediaUrl(localName);
    void ensureMediaUrl(localName).then((resolved) => {
      if (!cancelled) {
        setSrc(resolved || fallbackUrl || null);
      }
    });
    return () => {
      cancelled = true;
      releaseMediaUrl(localName);
    };
  }, [localName, fallbackUrl, ensureMediaUrl, retainMediaUrl, releaseMediaUrl]);

  if (!src || broken) return null;

  return (
    <div className={wrapperClassName}>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onError={() => setBroken(true)}
        onClick={
          onImageClick
            ? (e) => {
                e.stopPropagation();
                onImageClick(src);
              }
            : undefined
        }
        className={`${className} ${onImageClick ? 'cursor-zoom-in' : ''}`}
      />
      {children}
    </div>
  );
};
