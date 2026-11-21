import React from 'react';
import {
  BookmarkSimple,
  BookOpen,
  Briefcase,
  Camera,
  ChatCircleText,
  Code,
  Compass,
  Cpu,
  Cube,
  FilmStrip,
  Folder,
  GameController,
  Globe,
  Heart,
  Lightbulb,
  Lightning,
  MusicNotes,
  Palette,
  Receipt,
  RocketLaunch,
  ShieldCheck,
  Sparkle,
  Sword,
  TerminalWindow,
} from '@phosphor-icons/react';

export type SectionIconProps = {
  name?: string | null;
  weight?: 'regular' | 'bold' | 'fill' | 'duotone';
  className?: string;
  color?: string;
};

const ICON_MAP: Record<string, React.ComponentType<{ weight?: 'regular' | 'bold' | 'fill' | 'duotone'; className?: string; style?: React.CSSProperties }>> = {
  folder: Folder,
  gamecontroller: GameController,
  game: GameController,
  code: Code,
  sparkle: Sparkle,
  palette: Palette,
  bookmarksimple: BookmarkSimple,
  bookmark: BookmarkSimple,
  filmstrip: FilmStrip,
  film: FilmStrip,
  lightbulb: Lightbulb,
  shieldcheck: ShieldCheck,
  shield: ShieldCheck,
  receipt: Receipt,
  terminalwindow: TerminalWindow,
  terminal: TerminalWindow,
  globe: Globe,
  musicnotes: MusicNotes,
  music: MusicNotes,
  camera: Camera,
  cpu: Cpu,
  rocketlaunch: RocketLaunch,
  rocket: RocketLaunch,
  sword: Sword,
  cube: Cube,
  compass: Compass,
  bookopen: BookOpen,
  book: BookOpen,
  chatcircletext: ChatCircleText,
  chat: ChatCircleText,
  briefcase: Briefcase,
  heart: Heart,
  lightning: Lightning,
};

import type { AppLocale } from '@shared/types';
import { translate } from '@shared/i18n';

export const SECTION_ICON_LABELS_RU: Record<string, string> = {
  Dot: translate('ru', 'icon.Dot'),
  Folder: translate('ru', 'icon.Folder'),
  GameController: translate('ru', 'icon.GameController'),
  Code: translate('ru', 'icon.Code'),
  Sparkle: translate('ru', 'icon.Sparkle'),
  Palette: translate('ru', 'icon.Palette'),
  BookmarkSimple: translate('ru', 'icon.BookmarkSimple'),
  FilmStrip: translate('ru', 'icon.FilmStrip'),
  Lightbulb: translate('ru', 'icon.Lightbulb'),
  ShieldCheck: translate('ru', 'icon.ShieldCheck'),
  Receipt: translate('ru', 'icon.Receipt'),
  TerminalWindow: translate('ru', 'icon.TerminalWindow'),
  Globe: translate('ru', 'icon.Globe'),
  MusicNotes: translate('ru', 'icon.MusicNotes'),
  Camera: translate('ru', 'icon.Camera'),
  Cpu: translate('ru', 'icon.Cpu'),
  RocketLaunch: translate('ru', 'icon.RocketLaunch'),
  Sword: translate('ru', 'icon.Sword'),
  Cube: translate('ru', 'icon.Cube'),
  Compass: translate('ru', 'icon.Compass'),
  BookOpen: translate('ru', 'icon.BookOpen'),
  ChatCircleText: translate('ru', 'icon.ChatCircleText'),
  Briefcase: translate('ru', 'icon.Briefcase'),
  Heart: translate('ru', 'icon.Heart'),
  Lightning: translate('ru', 'icon.Lightning'),
};

export const SECTION_ICON_LABELS_EN: Record<string, string> = {
  Dot: translate('en', 'icon.Dot'),
  Folder: translate('en', 'icon.Folder'),
  GameController: translate('en', 'icon.GameController'),
  Code: translate('en', 'icon.Code'),
  Sparkle: translate('en', 'icon.Sparkle'),
  Palette: translate('en', 'icon.Palette'),
  BookmarkSimple: translate('en', 'icon.BookmarkSimple'),
  FilmStrip: translate('en', 'icon.FilmStrip'),
  Lightbulb: translate('en', 'icon.Lightbulb'),
  ShieldCheck: translate('en', 'icon.ShieldCheck'),
  Receipt: translate('en', 'icon.Receipt'),
  TerminalWindow: translate('en', 'icon.TerminalWindow'),
  Globe: translate('en', 'icon.Globe'),
  MusicNotes: translate('en', 'icon.MusicNotes'),
  Camera: translate('en', 'icon.Camera'),
  Cpu: translate('en', 'icon.Cpu'),
  RocketLaunch: translate('en', 'icon.RocketLaunch'),
  Sword: translate('en', 'icon.Sword'),
  Cube: translate('en', 'icon.Cube'),
  Compass: translate('en', 'icon.Compass'),
  BookOpen: translate('en', 'icon.BookOpen'),
  ChatCircleText: translate('en', 'icon.ChatCircleText'),
  Briefcase: translate('en', 'icon.Briefcase'),
  Heart: translate('en', 'icon.Heart'),
  Lightning: translate('en', 'icon.Lightning'),
};

export function getSectionIconLabels(locale: AppLocale = 'ru'): Record<string, string> {
  return locale === 'en' ? SECTION_ICON_LABELS_EN : SECTION_ICON_LABELS_RU;
}

export const SectionIcon: React.FC<SectionIconProps> = ({
  name,
  weight = 'duotone',
  className = 'w-4 h-4',
  color,
}) => {
  const key = (name || 'Folder').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key === 'dot') {
    return (
      <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
        <circle cx="8" cy="8" r="4.5" fill={color || 'currentColor'} />
      </svg>
    );
  }
  const Comp = ICON_MAP[key] ?? Folder;
  return <Comp weight={weight} className={className} style={color ? { color } : undefined} />;
};
