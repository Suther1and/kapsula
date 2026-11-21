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

export const SECTION_ICON_LABELS_RU: Record<string, string> = {
  Folder: 'Папка',
  GameController: 'Игры',
  Code: 'Код',
  Sparkle: 'Идеи',
  Palette: 'Дизайн',
  BookmarkSimple: 'Закладки',
  FilmStrip: 'Видео',
  Lightbulb: 'Заметки',
  ShieldCheck: 'Защита',
  Receipt: 'Финансы',
  TerminalWindow: 'Инструменты',
  Globe: 'Интернет',
  MusicNotes: 'Музыка',
  Camera: 'Фото',
  Cpu: 'Железо',
  RocketLaunch: 'Запуск',
  Sword: 'Экшен',
  Cube: '3D / Модели',
  Compass: 'Путешествия',
  BookOpen: 'Учёба',
  ChatCircleText: 'Контакты',
  Briefcase: 'Работа',
  Heart: 'Личное',
  Lightning: 'Быстрое',
};

export const SectionIcon: React.FC<SectionIconProps> = ({
  name,
  weight = 'duotone',
  className = 'w-4 h-4',
  color,
}) => {
  const key = (name || 'Folder').toLowerCase().replace(/[^a-z0-9]/g, '');
  const Comp = ICON_MAP[key] ?? Folder;
  return <Comp weight={weight} className={className} style={color ? { color } : undefined} />;
};
