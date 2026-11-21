import React from 'react';
import { FileText, FolderOpen } from '@phosphor-icons/react';
import type { VaultItem } from '@shared/types';
import { useI18n } from '@shared/i18n/react';
import { formatFileSize } from '../../lib/format';

interface DocumentCardProps {
  item: VaultItem;
  compactList?: boolean;
}

export const DocumentCard: React.FC<DocumentCardProps> = ({ item, compactList = false }) => {
  const { t, locale } = useI18n();
  const fileName = item.mediaMeta?.fileName || item.title || t('dna.document');
  const extMatch = /\.([a-z0-9]+)$/i.exec(fileName);
  const ext = (extMatch?.[1] || 'FILE').toUpperCase().slice(0, 5);
  const metaLabel = [
    formatFileSize(item.mediaMeta?.fileSize, locale),
    item.mediaMeta?.pageCount ? t('common.pagesShort', { count: item.mediaMeta.pageCount }) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  if (compactList) {
    return (
      <div className="flex items-center justify-between gap-3 min-w-0 flex-1">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="k-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[var(--k-accent-soft)] text-[var(--k-accent)] shrink-0">
            {ext}
          </span>
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold truncate">{item.title || fileName}</div>
            {metaLabel ? <div className="text-[11.5px] text-[var(--k-ink-muted)]">{metaLabel}</div> : null}
          </div>
        </div>
        {item.mediaPath ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void window.kapsula.openMediaFile(item.mediaPath!);
            }}
            className="k-interactive h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] font-medium cursor-pointer shrink-0"
          >
            {t('common.open')}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2.5">
        <div className="w-9 h-10 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] flex flex-col items-center justify-center shrink-0">
          <FileText weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />
          <span className="k-mono text-[8.5px] font-bold text-[var(--k-ink-muted)] leading-none mt-0.5">
            {ext}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-[var(--k-ink-primary)] leading-snug line-clamp-2">
            {item.title || fileName}
          </div>
          {metaLabel ? (
            <div className="text-[11.5px] text-[var(--k-ink-muted)] mt-0.5">{metaLabel}</div>
          ) : null}
        </div>
      </div>

      {item.summary && item.summary !== item.title ? (
        <p className="m-0 text-[12px] text-[var(--k-ink-secondary)] line-clamp-2 leading-relaxed">
          {item.summary}
        </p>
      ) : null}

      {item.mediaPath ? (
        <div className="flex items-center justify-end gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void window.kapsula.revealMediaFile(item.mediaPath!);
            }}
            aria-label={t('cards.showInFolder')}
            className="k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void window.kapsula.openMediaFile(item.mediaPath!);
            }}
            className="k-interactive h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] font-medium text-[var(--k-ink-primary)] hover:border-[var(--k-accent)] cursor-pointer"
          >
            {t('cards.openFile')}
          </button>
        </div>
      ) : null}
    </div>
  );
};
