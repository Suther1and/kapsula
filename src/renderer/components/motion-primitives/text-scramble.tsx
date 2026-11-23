import { type JSX, useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion, type MotionProps } from 'motion/react';

export type TextScrambleProps = {
  children: string;
  duration?: number;
  speed?: number;
  characterSet?: string;
  as?: React.ElementType;
  className?: string;
  trigger?: boolean;
  onScrambleComplete?: () => void;
} & MotionProps;

const defaultChars =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function TextScramble({
  children,
  duration = 0.8,
  speed = 0.04,
  characterSet = defaultChars,
  className,
  as: Component = 'p',
  trigger = true,
  onScrambleComplete,
  ...props
}: TextScrambleProps) {
  const prefersReduced = useReducedMotion();
  const MotionComponent = useMemo(
    () => motion.create(Component as keyof JSX.IntrinsicElements),
    [Component]
  );
  const [displayText, setDisplayText] = useState(children);
  const text = children;

  useEffect(() => {
    if (!trigger || prefersReduced) {
      setDisplayText(text);
      return;
    }

    const steps = Math.max(1, Math.round(duration / speed));
    let step = 0;

    const interval = window.setInterval(() => {
      let scrambled = '';
      const progress = step / steps;

      for (let i = 0; i < text.length; i++) {
        if (text[i] === ' ') {
          scrambled += ' ';
          continue;
        }

        if (progress * text.length > i) {
          scrambled += text[i];
        } else {
          scrambled +=
            characterSet[Math.floor(Math.random() * characterSet.length)] ?? '';
        }
      }

      setDisplayText(scrambled);
      step++;

      if (step > steps) {
        window.clearInterval(interval);
        setDisplayText(text);
        onScrambleComplete?.();
      }
    }, speed * 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [trigger, text, duration, speed, characterSet, prefersReduced, onScrambleComplete]);

  return (
    <MotionComponent className={className} {...props}>
      {displayText}
    </MotionComponent>
  );
}
