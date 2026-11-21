import React from 'react';
import { Code } from '@phosphor-icons/react';
import type { VaultItem } from '@shared/types';
import { extractFirstCodeBlock } from '../../lib/format';
import { CopySlotPill } from '../ui/CopySlotPill';

interface CodeSnippetCardProps {
  item: VaultItem;
  compactList?: boolean;
}

export const CodeSnippetCard: React.FC<CodeSnippetCardProps> = ({
  item,
  compactList = false,
}) => {
  const block = extractFirstCodeBlock(item.body);
  const codeText = block?.code || item.body.trim();
  const lang = block?.lang || 'code';

  if (compactList) {
    return (
      <div className="flex items-center justify-between gap-3 min-w-0 flex-1">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="k-mono text-[10.5px] uppercase px-1.5 py-0.5 rounded bg-[var(--k-accent-soft)] text-[var(--k-accent)]">
              {lang}
            </span>
            <span className="text-[13.5px] font-semibold truncate">{item.title || 'Фрагмент кода'}</span>
          </div>
          <div className="k-mono text-[11.5px] text-[var(--k-ink-muted)] truncate mt-0.5">
            {codeText.split('\n')[0]}
          </div>
        </div>
        <CopySlotPill
          label="Код"
          copiedLabel="Готово"
          widthPx={84}
          heightPx={28}
          onCopy={() => window.kapsula.copyText(codeText)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Code weight="bold" className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
          <span className="text-[13.5px] font-semibold text-[var(--k-ink-primary)] truncate">
            {item.title || 'Фрагмент кода'}
          </span>
        </div>
        <span className="k-mono text-[10.5px] uppercase px-1.5 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] shrink-0">
          {lang}
        </span>
      </div>

      <pre className="m-0 rounded-xl bg-[var(--k-code-bg)] border border-[var(--k-border-hairline)] p-3 overflow-hidden text-[12px] leading-relaxed k-mono text-[var(--k-ink-primary)] max-h-[155px]">
        <code className="block overflow-hidden text-ellipsis whitespace-pre">
          {codeText.split('\n').slice(0, 7).join('\n')}
        </code>
      </pre>

      <div className="flex justify-end">
        <CopySlotPill
          label="Копировать код"
          copiedLabel="Готово"
          widthPx={152}
          heightPx={28}
          onCopy={() => window.kapsula.copyText(codeText)}
        />
      </div>
    </div>
  );
};
