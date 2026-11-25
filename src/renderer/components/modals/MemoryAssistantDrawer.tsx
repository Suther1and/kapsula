import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  ArrowsInSimple,
  ArrowsOutSimple,
  Code,
  Columns,
  CreditCard,
  FileText,
  GitMerge,
  GlobeSimple,
  ImageSquare,
  Microphone,
  NotePencil,
  SidebarSimple,
  Trash,
  X,
} from '@phosphor-icons/react';
import type { AskVaultCitation, ChatTurn } from '@shared/types';
import { cleanBrokenTextArtifacts } from '@shared/html-entities';
import { useI18n } from '@shared/i18n/react';
import { friendlyErrorMessage, getMediaUrl, stripLeadingTitle, stripMarkdownPreview } from '../../lib/format';
import { BorderTrail } from '../motion-primitives/border-trail';
import { TextShimmer } from '../motion-primitives/text-shimmer';
import { KapsulaEmblem } from '../ui/KapsulaEmblem';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SendIcon } from '../icons/send';
import { SparklesIcon } from '../icons/sparkles';
import { LiveIcon } from '../icons/LiveIcon';

type DrawerWidthMode = 'compact' | 'wide' | 'full';

interface MemoryAssistantDrawerProps {
  open: boolean;
  onClose: () => void;
  onOpenCitation: (itemId: string, opts?: { keepAssistantOpen?: boolean }) => void;
  onSynthesizeFound?: (itemIds: string[]) => void;
}

const STARTER_PROMPT_KEYS = [
  'assistant.sample1',
  'assistant.sample2',
  'assistant.sample3',
  'assistant.sample4',
] as const;

function renderInlineMarkdown(line: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > lastIdx) {
      tokens.push(line.slice(lastIdx, m.index));
    }
    const raw = m[0]!;
    if (raw.startsWith('**') && raw.endsWith('**')) {
      tokens.push(
        <strong key={k++} className="font-semibold text-[var(--k-ink-primary)]">
          {raw.slice(2, -2)}
        </strong>
      );
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push(
        <code
          key={k++}
          className="k-mono px-1.5 py-0.5 rounded bg-[var(--k-bg-surface-3)] text-[var(--k-accent)] text-[12px]"
        >
          {raw.slice(1, -1)}
        </code>
      );
    } else {
      const linkM = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(raw);
      if (linkM) {
        tokens.push(
          <button
            key={k++}
            type="button"
            onClick={() => void window.kapsula.openExternal(linkM[2]!)}
            className="text-[var(--k-accent)] underline underline-offset-2 cursor-pointer"
          >
            {linkM[1]}
          </button>
        );
      } else {
        tokens.push(raw);
      }
    }
    lastIdx = regex.lastIndex;
  }
  if (lastIdx < line.length) tokens.push(line.slice(lastIdx));
  return tokens;
}

const SafeAssistantMarkdown: React.FC<{ content: string }> = ({ content }) => {
  const lines = (content || '').split(/\r?\n/);
  return (
    <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed k-selectable">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} className="h-1" />;
        const headingMatch = /^(#{1,3})\s+(.+)$/.exec(trimmed);
        if (headingMatch) {
          return (
            <div key={i} className="font-semibold text-[13.5px] text-[var(--k-ink-primary)] pt-1">
              {renderInlineMarkdown(headingMatch[2]!)}
            </div>
          );
        }
        const listMatch = /^[-*•]\s+(.+)$/.exec(trimmed);
        if (listMatch) {
          return (
            <div key={i} className="flex items-start gap-2 pl-1">
              <span className="mt-2 w-1.5 h-1.5 rounded-full bg-[var(--k-accent)] shrink-0" />
              <span>{renderInlineMarkdown(listMatch[1]!)}</span>
            </div>
          );
        }
        return <div key={i}>{renderInlineMarkdown(line)}</div>;
      })}
    </div>
  );
};

export const MemoryAssistantDrawer: React.FC<MemoryAssistantDrawerProps> = ({
  open,
  onClose,
  onOpenCitation,
  onSynthesizeFound,
}) => {
  const { t, locale } = useI18n();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [widthMode, setWidthMode] = useState<DrawerWidthMode>('compact');
  const [customWidth, setCustomWidth] = useState<number>(374);
  const [isResizing, setIsResizing] = useState(false);
  const prefersReduced = useReducedMotion();
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 90);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && widthMode === 'full') {
        e.preventDefault();
        setWidthMode('compact');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, widthMode]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthMode === 'wide' ? Math.max(customWidth, 540) : customWidth;
    setIsResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(330, Math.min(720, startWidth + (startX - ev.clientX)));
      setCustomWidth(next);
    };
    const onUp = () => {
      setIsResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [turns, loading]);

  const ask = async (rawQuestion: string) => {
    const question = rawQuestion.trim();
    if (!question || loading) return;
    const nextHistory: ChatTurn[] = [...turns, { role: 'user', content: question }];
    setTurns(nextHistory);
    setInput('');
    setLoading(true);
    try {
      const res = await window.kapsula.askVault(question, turns);
      setTurns([
        ...nextHistory,
        {
          role: 'assistant',
          content: res.answer,
          citations: res.citations,
        },
      ]);
    } catch (err) {
      setTurns([
        ...nextHistory,
        {
          role: 'assistant',
          content: friendlyErrorMessage(err, t('assistant.errorAnswer'), locale),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const targetWidthPx =
    widthMode === 'wide' ? Math.max(540, customWidth) : Math.min(460, Math.max(340, customWidth));

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.aside
          key="assistant-docked-panel"
          data-testid="assistant-drawer"
          initial={
            prefersReduced
              ? { opacity: 0 }
              : widthMode === 'full'
                ? { opacity: 0, scale: 0.975, y: 6 }
                : { opacity: 0, x: 28 }
          }
          animate={
            prefersReduced
              ? { opacity: 1 }
              : {
                  opacity: 1,
                  x: 0,
                  y: 0,
                  scale: 1,
                  transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
                }
          }
          exit={
            prefersReduced
              ? { opacity: 0 }
              : widthMode === 'full'
                ? {
                    opacity: 0,
                    scale: 0.98,
                    y: 4,
                    transition: { duration: 0.13, ease: [0.22, 1, 0.36, 1] },
                  }
                : {
                    opacity: 0,
                    x: 24,
                    transition: { duration: 0.13, ease: [0.22, 1, 0.36, 1] },
                  }
          }
          style={
            widthMode === 'full'
              ? undefined
              : { width: `${targetWidthPx}px`, transformOrigin: 'right center' }
          }
          className={
            widthMode === 'full'
              ? 'fixed top-[46px] left-0 right-0 bottom-0 z-[45] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-primary)] border-t border-[var(--k-border-hairline)] flex flex-col overflow-hidden'
              : `fixed top-[46px] right-0 bottom-0 z-[45] border-l border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-primary)] shadow-[var(--k-shadow-drawer-left)] flex flex-col overflow-hidden ${
                  !isResizing && !prefersReduced
                    ? 'transition-[width] duration-[170ms] ease-[cubic-bezier(0.32,0.72,0,1)]'
                    : ''
                } ${isResizing ? 'select-none' : ''}`
          }
        >
          <div className="w-full h-full flex flex-col overflow-hidden">
            {widthMode !== 'full' ? (
              <div
                onMouseDown={startResize}
                className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-[var(--k-accent)]/40 transition-colors z-20"
                title={t('assistant.resizeTitle')}
              />
            ) : null}

            {/* Header */}
            <div className="flex items-center justify-between gap-2 px-3.5 py-3 border-b border-[var(--k-border-hairline)] shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <KapsulaEmblem size={20} />
                <div className="text-[13px] font-semibold leading-tight truncate">
                  {t('assistant.title')}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <SegmentedControl<DrawerWidthMode>
                  size="sm"
                  value={widthMode}
                  onChange={(next) => {
                    if (next === 'compact') setCustomWidth(374);
                    else if (next === 'wide') setCustomWidth(540);
                    setWidthMode(next);
                  }}
                  options={[
                    {
                      value: 'compact',
                      label: '',
                      ariaLabel: t('assistant.width.compact'),
                      title: t('assistant.width.compact'),
                      icon: <SidebarSimple className="w-3.5 h-3.5" />,
                    },
                    {
                      value: 'wide',
                      label: '',
                      ariaLabel: t('assistant.width.wide'),
                      title: t('assistant.width.wide'),
                      icon: <Columns className="w-3.5 h-3.5" />,
                    },
                    {
                      value: 'full',
                      label: '',
                      ariaLabel: widthMode === 'full' ? t('assistant.width.exitFull') : t('assistant.width.full'),
                      title: widthMode === 'full' ? t('assistant.width.exitFull') : t('assistant.width.full'),
                      icon:
                        widthMode === 'full' ? (
                          <ArrowsInSimple className="w-3.5 h-3.5" />
                        ) : (
                          <ArrowsOutSimple className="w-3.5 h-3.5" />
                        ),
                    },
                  ]}
                />

                {turns.length > 0 ? (
                  <button
                    type="button"
                    title={t('assistant.clearTitle')}
                    onClick={() => setTurns([])}
                    className="k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                  >
                    <Trash className="w-4 h-4" />
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={t('assistant.closeAria')}
                  onClick={onClose}
                  className="k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                >
                  <X weight="bold" className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Messages Area */}
            <div
              ref={listRef}
              className="flex-1 min-h-0 overflow-y-auto k-scroll-stable p-4 flex flex-col gap-3.5"
            >
              <div className={widthMode === 'full' ? 'max-w-[820px] w-full mx-auto flex flex-col gap-3.5' : 'flex flex-col gap-3.5'}>
                {turns.length === 0 ? (
                  <div className="flex flex-col gap-3 py-4">
                    <div className="rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4">
                      <div className="flex items-center gap-2 text-[13.5px] font-medium mb-1 text-[var(--k-ink-primary)]">
                        <LiveIcon icon={SparklesIcon} size={16} className="text-[var(--k-accent)]" />
                        <span>{t('assistant.emptyHeading')}</span>
                      </div>
                      <p className="m-0 text-[12.5px] text-[var(--k-ink-secondary)] leading-relaxed">
                        {t('assistant.emptyDesc')}
                      </p>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)] px-1">
                        {t('assistant.sampleHeading')}
                      </div>
                      {STARTER_PROMPT_KEYS.map((promptKey) => {
                        const q = t(promptKey);
                        return (
                          <button
                            key={promptKey}
                            type="button"
                            onClick={() => void ask(q)}
                            className="k-interactive flex items-center justify-between gap-2 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 py-2.5 text-left text-[12.5px] text-[var(--k-ink-primary)] hover:border-[var(--k-accent)]/50 hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                          >
                            <span>{q}</span>
                            <ArrowRight className="w-3.5 h-3.5 text-[var(--k-ink-muted)] shrink-0" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  turns.map((turn, idx) => (
                    <div
                      key={idx}
                      className={`flex flex-col gap-2 ${
                        turn.role === 'user' ? 'items-end' : 'items-start'
                      }`}
                    >
                      <div
                        className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 ${
                          turn.role === 'user'
                            ? 'bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] rounded-br-sm text-[13px] leading-relaxed whitespace-pre-wrap'
                            : 'bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[var(--k-ink-primary)] rounded-bl-sm'
                        }`}
                      >
                        {turn.role === 'user' ? (
                          turn.content
                        ) : (
                          <SafeAssistantMarkdown content={turn.content} />
                        )}
                      </div>

                      {turn.role === 'assistant' && turn.citations && turn.citations.length > 0 ? (
                        <div className="w-full max-w-[95%] flex flex-col gap-1.5">
                          <div className="grid grid-cols-1 gap-1.5">
                            {turn.citations.map((cit: AskVaultCitation) => {
                              const thumb = getMediaUrl(cit.thumbPath || cit.imagePath);
                              const citIcon =
                                cit.dna === 'secret' ? (
                                  <CreditCard weight="duotone" className="w-4 h-4 text-[var(--k-emerald)]" />
                                ) : cit.dna === 'link' ? (
                                  <GlobeSimple weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />
                                ) : cit.dna === 'voice' ? (
                                  <Microphone weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />
                                ) : cit.dna === 'snippet' ? (
                                  <Code weight="duotone" className="w-4 h-4 text-[var(--k-violet)]" />
                                ) : cit.dna === 'doc' ? (
                                  <FileText weight="duotone" className="w-4 h-4 text-[var(--k-amber)]" />
                                ) : cit.dna === 'shot' ? (
                                  <ImageSquare weight="duotone" className="w-4 h-4 text-[var(--k-info)]" />
                                ) : (
                                  <NotePencil weight="duotone" className="w-4 h-4 text-[var(--k-ink-secondary)]" />
                                );
                              const citCleanTitle = cleanBrokenTextArtifacts(cit.title || '', true);
                              const citCleanSummary = cleanBrokenTextArtifacts(cit.summary || '', true);
                              return (
                                <button
                                  key={cit.id}
                                  type="button"
                                  onClick={() =>
                                    onOpenCitation(cit.id, {
                                      keepAssistantOpen: widthMode !== 'full',
                                    })
                                  }
                                  className="k-interactive flex items-center gap-2.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-accent)]/55 p-2 text-left cursor-pointer"
                                >
                                  {thumb ? (
                                    <img
                                      src={thumb}
                                      alt=""
                                      className="w-9 h-9 rounded-lg object-cover shrink-0 border border-[var(--k-border-hairline)]"
                                    />
                                  ) : (
                                    <span className="w-9 h-9 rounded-lg bg-[var(--k-bg-surface-2)] flex items-center justify-center shrink-0">
                                      {citIcon}
                                    </span>
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[12px] font-medium text-[var(--k-ink-primary)] truncate">
                                      {citCleanTitle}
                                    </div>
                                    <div className="text-[10.5px] text-[var(--k-ink-muted)] truncate">
                                      {cit.domain ||
                                        stripLeadingTitle(
                                          stripMarkdownPreview(citCleanSummary),
                                          citCleanTitle
                                        ) ||
                                        t('assistant.openItem')}
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>

                          {turn.citations.length >= 2 && onSynthesizeFound ? (
                            <button
                              type="button"
                              onClick={() => onSynthesizeFound(turn.citations!.map((c) => c.id))}
                              className="k-interactive self-start inline-flex items-center gap-1.5 h-7 px-3 rounded-lg border border-[var(--k-accent)]/35 bg-[var(--k-accent-soft)] text-[11.5px] font-medium text-[var(--k-accent)] hover:bg-[var(--k-accent)] hover:text-[var(--k-ink-on-accent)] cursor-pointer"
                            >
                              <GitMerge className="w-3.5 h-3.5" />
                              <span>{t('assistant.synthesizeCited', { count: turn.citations.length })}</span>
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))
                )}

                {loading ? (
                  <div className="relative self-start rounded-2xl rounded-bl-sm bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] px-3.5 py-2.5 text-[12.5px] text-[var(--k-ink-secondary)] overflow-hidden">
                    {!prefersReduced ? (
                      <BorderTrail
                        size={96}
                        borderRadius={16}
                        thickness={20}
                        glow
                        surfaceBg="var(--k-bg-surface-2)"
                        transition={{ repeat: Infinity, duration: 2.3, ease: 'linear' }}
                        className="opacity-90"
                      />
                    ) : null}
                    <TextShimmer
                      as="span"
                      duration={1.15}
                      className="relative z-[1] [--base-color:var(--k-ink-secondary)] [--base-gradient-color:var(--k-ink-primary)] font-medium"
                    >
                      {t('assistant.thinking')}
                    </TextShimmer>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Bottom Prompt Input */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void ask(input);
              }}
              className="p-3.5 border-t border-[var(--k-border-hairline)] shrink-0"
            >
              <div
                className={`${widthMode === 'full' ? 'max-w-[820px] mx-auto' : ''} flex items-center gap-2 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 py-1.5 focus-within:border-[var(--k-border-focus)]`}
              >
                <input
                  ref={inputRef}
                  data-testid="assistant-input"
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={t('assistant.inputPlaceholder')}
                  className="flex-1 bg-transparent border-none outline-none text-[13px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
                />
                <button
                  type="submit"
                  data-testid="assistant-send-btn"
                  disabled={loading || !input.trim()}
                  aria-label={t('assistant.sendAria')}
                  className="k-interactive inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:opacity-100 disabled:cursor-default"
                >
                  <LiveIcon icon={SendIcon} size={15} />
                </button>
              </div>
            </form>
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
};
