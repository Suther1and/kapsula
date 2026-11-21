import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Eyedropper, MapPin, PencilSimple, Trash, X } from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { CanvasAnnotation, VaultItem } from '@shared/types';
import { getMediaUrl } from '../../lib/format';
import { CopySlotPill } from '../ui/CopySlotPill';

interface ShotLightboxProps {
  item: VaultItem | null;
  onClose: () => void;
  onEditInStudio?: (item: VaultItem) => void;
  onSaveAnnotations?: (itemId: string, annotations: CanvasAnnotation[]) => Promise<void> | void;
}

declare global {
  interface Window {
    EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> };
  }
}

function extractCanvasSwatches(imgEl: HTMLImageElement): string[] {
  try {
    const canvas = document.createElement('canvas');
    const w = 36;
    const h = 36;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    ctx.drawImage(imgEl, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] ?? 0;
      if (a < 180) continue;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const qr = Math.round(r / 32) * 32;
      const qg = Math.round(g / 32) * 32;
      const qb = Math.round(b / 32) * 32;
      const key = `${qr},${qg},${qb}`;
      const prev = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const weight = 1 + Math.floor(sat / 40);
      prev.count += weight;
      prev.r += r * weight;
      prev.g += g * weight;
      prev.b += b * weight;
      buckets.set(key, prev);
    }
    return [...buckets.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
      .map((c) => {
        const toHex = (n: number) =>
          Math.min(255, Math.round(n / c.count))
            .toString(16)
            .padStart(2, '0');
        return `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`.toUpperCase();
      });
  } catch {
    return [];
  }
}

export const ShotLightbox: React.FC<ShotLightboxProps> = ({
  item,
  onClose,
  onEditInStudio,
  onSaveAnnotations,
}) => {
  const prefersReduced = useReducedMotion();
  const [swatches, setSwatches] = useState<string[]>([]);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [draftPin, setDraftPin] = useState<{ xPct: number; yPct: number; text: string } | null>(null);

  useEffect(() => {
    setSwatches(item?.colorPalette ?? []);
    setAnnotateMode(false);
    setDraftPin(null);
  }, [item]);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (draftPin) setDraftPin(null);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, draftPin, onClose]);

  const localImagePath = item ? item.imagePath || item.thumbPath || null : null;
  const src = item
    ? getMediaUrl(localImagePath) || (item.ogImageUrl ? item.ogImageUrl : null)
    : null;
  const annotations = item?.annotations ?? [];

  const handleEyeDropper = async () => {
    if (!window.EyeDropper) {
      toast.info('Кликни по любому цветовому образцу сверху — цвет скопируется сразу');
      return;
    }
    try {
      const picker = new window.EyeDropper();
      const res = await picker.open();
      if (res?.sRGBHex) {
        const hex = res.sRGBHex.toUpperCase();
        await window.kapsula.copyText(hex);
        setSwatches((prev) => [hex, ...prev.filter((p) => p !== hex)].slice(0, 7));
        toast.success(`Цвет ${hex} скопирован`);
      }
    } catch {
      // User cancelled EyeDropper
    }
  };

  const commitDraftPin = async () => {
    if (!item || !draftPin || !draftPin.text.trim()) {
      setDraftPin(null);
      return;
    }
    const next: CanvasAnnotation[] = [
      ...annotations,
      {
        id: crypto.randomUUID(),
        xPct: draftPin.xPct,
        yPct: draftPin.yPct,
        text: draftPin.text.trim().slice(0, 180),
      },
    ];
    await onSaveAnnotations?.(item.id, next);
    setDraftPin(null);
    setAnnotateMode(false);
  };

  const lightboxTree = (
    <AnimatePresence>
      {item ? (
        <motion.div
          role="dialog"
          aria-modal="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={onClose}
          className="fixed inset-0 z-[9999] flex flex-col bg-black/88 backdrop-blur-md"
        >
          {/* Top-Pinned Lightbox Header Bar */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-3 px-6 pt-5 pb-3 shrink-0 text-[#f4f3ee]"
          >
            <div className="min-w-0">
              <div className="text-[15px] font-semibold truncate">{item.title || 'Изображение'}</div>
              {item.summary && item.summary !== item.title ? (
                <div className="text-[12px] text-[#aba9a0] truncate max-w-[520px]">
                  {item.summary}
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {/* Dominant HEX Swatches + Eyedropper */}
              {swatches.length > 0 ? (
                <div className="flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1">
                  {swatches.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      title={`Скопировать ${hex}`}
                      onClick={() => {
                        void window.kapsula.copyText(hex);
                        toast.success(`Цвет ${hex} скопирован`);
                      }}
                      className="k-interactive flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-white/15 cursor-pointer"
                    >
                      <span
                        className="w-3.5 h-3.5 rounded-full border border-white/30 shrink-0"
                        style={{ backgroundColor: hex }}
                      />
                      <span className="k-mono text-[10.5px] text-white/90">{hex}</span>
                    </button>
                  ))}
                  {window.EyeDropper ? (
                    <button
                      type="button"
                      onClick={() => void handleEyeDropper()}
                      title="Пипетка цвета"
                      className="k-interactive w-6 h-6 rounded-md hover:bg-white/15 inline-flex items-center justify-center cursor-pointer"
                    >
                      <Eyedropper className="w-3.5 h-3.5" />
                    </button>
                  ) : null}
                </div>
              ) : null}

              {onSaveAnnotations ? (
                <button
                  type="button"
                  onClick={() => setAnnotateMode((v) => !v)}
                  className={`k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-[12px] font-medium cursor-pointer ${
                    annotateMode
                      ? 'bg-[var(--k-accent)] border-[var(--k-accent)] text-white'
                      : 'bg-white/10 border-white/15 text-white hover:bg-white/20'
                  }`}
                >
                  <MapPin className="w-3.5 h-3.5" />
                  <span>{annotateMode ? 'Кликни по картинке…' : 'Пометить точку'}</span>
                </button>
              ) : null}

              {localImagePath ? (
                <CopySlotPill
                  label="Копировать фото"
                  copiedLabel="Скопировано"
                  widthPx={156}
                  heightPx={32}
                  tone="secret"
                  onCopy={() => window.kapsula.copyImage(localImagePath)}
                />
              ) : item.url ? (
                <CopySlotPill
                  label="Копировать ссылку"
                  copiedLabel="Скопировано"
                  widthPx={164}
                  heightPx={32}
                  tone="secret"
                  onCopy={() => window.kapsula.copyText(item.url!)}
                />
              ) : null}

              {onEditInStudio ? (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onEditInStudio(item);
                  }}
                  className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                >
                  <PencilSimple className="w-3.5 h-3.5" />
                  <span>Открыть заметку</span>
                </button>
              ) : null}

              <button
                type="button"
                aria-label="Закрыть просмотр"
                onClick={onClose}
                className="k-interactive inline-flex items-center justify-center w-8 h-8 rounded-lg bg-white/10 text-white hover:bg-white/20 cursor-pointer"
              >
                <X weight="bold" className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Centered Image Stage */}
          <div className="flex-1 min-h-0 w-full flex items-center justify-center px-6 pb-6">
          {src ? (
            <motion.div
              initial={prefersReduced ? { opacity: 0 } : { transform: 'scale(0.96)', opacity: 0 }}
              animate={prefersReduced ? { opacity: 1 } : { transform: 'scale(1)', opacity: 1 }}
              exit={prefersReduced ? { opacity: 0 } : { transform: 'scale(0.97)', opacity: 0 }}
              transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
              onClick={(e) => {
                e.stopPropagation();
                if (!annotateMode) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const xPct = Math.round(((e.clientX - rect.left) / Math.max(1, rect.width)) * 1000) / 10;
                const yPct = Math.round(((e.clientY - rect.top) / Math.max(1, rect.height)) * 1000) / 10;
                setDraftPin({ xPct, yPct, text: '' });
              }}
              className={`relative max-w-full ${annotateMode ? 'cursor-crosshair' : ''}`}
            >
              <img
                src={src}
                alt={item.title}
                onLoad={(e) => {
                  const extracted = extractCanvasSwatches(e.currentTarget);
                  if (extracted.length > 0 && swatches.length === 0) {
                    setSwatches(extracted);
                  }
                }}
                className="max-h-[calc(100vh-150px)] max-w-full rounded-2xl border border-white/15 object-contain shadow-2xl block"
              />

              {/* Saved Callout Pins */}
              {annotations.map((ann, idx) => (
                <div
                  key={ann.id}
                  style={{ left: `${ann.xPct}%`, top: `${ann.yPct}%` }}
                  onClick={(e) => e.stopPropagation()}
                  className="group/pin absolute -translate-x-1/2 -translate-y-1/2 z-10"
                >
                  <div className="w-6 h-6 rounded-full bg-[var(--k-accent)] text-white text-[11px] font-bold flex items-center justify-center shadow-lg ring-2 ring-white">
                    {idx + 1}
                  </div>
                  <div className="hidden group-hover/pin:flex items-center gap-2 absolute left-7 top-0 min-w-[160px] max-w-[260px] rounded-xl bg-[#16161c]/95 border border-white/18 px-2.5 py-1.5 text-[12px] text-[#f4f4f6] shadow-xl">
                    <span className="flex-1">{ann.text}</span>
                    {onSaveAnnotations ? (
                      <button
                        type="button"
                        onClick={() =>
                          void onSaveAnnotations(
                            item.id,
                            annotations.filter((a) => a.id !== ann.id)
                          )
                        }
                        className="text-white/60 hover:text-[var(--k-danger)] cursor-pointer shrink-0"
                      >
                        <Trash className="w-3.5 h-3.5" />
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}

              {/* Active Draft Pin Popover */}
              {draftPin ? (
                <div
                  style={{ left: `${draftPin.xPct}%`, top: `${draftPin.yPct}%` }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute -translate-x-1/2 translate-y-2 z-20 w-60 rounded-xl border border-white/18 bg-[#16161c]/95 text-[#f4f4f6] p-2.5 shadow-2xl flex flex-col gap-2"
                >
                  <input
                    autoFocus
                    value={draftPin.text}
                    onChange={(e) => setDraftPin({ ...draftPin, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitDraftPin();
                    }}
                    placeholder="Комментарий к точке…"
                    className="h-8 rounded-lg border border-white/15 bg-white/10 px-2.5 text-[12px] text-[#f4f4f6] placeholder:text-white/45 outline-none"
                  />
                  <div className="flex justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => setDraftPin(null)}
                      className="px-2 py-1 text-[11px] text-white/70 hover:text-white cursor-pointer"
                    >
                      Отмена
                    </button>
                    <button
                      type="button"
                      onClick={() => void commitDraftPin()}
                      className="px-2.5 py-1 rounded-md bg-[var(--k-accent)] text-[11px] font-medium text-white cursor-pointer"
                    >
                      Сохранить
                    </button>
                  </div>
                </div>
              ) : null}
            </motion.div>
          ) : null}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  if (typeof document === 'undefined') return lightboxTree;
  return createPortal(lightboxTree, document.body);
};
