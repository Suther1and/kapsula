import React from 'react';

interface SecretMorphFieldProps {
  revealed: boolean;
  maskedText: string;
  revealedText?: string | null;
  className?: string;
}

export const SecretMorphField: React.FC<SecretMorphFieldProps> = ({
  revealed,
  maskedText,
  revealedText,
  className = '',
}) => {
  const showReal = revealed && Boolean(revealedText);
  return (
    <span
      className={`k-mono relative inline-block shrink-0 min-w-[36px] align-middle whitespace-nowrap transition-[filter,opacity] duration-150 ease-[var(--k-ease-out)] ${
        showReal ? 'blur-0 opacity-100 select-text' : 'blur-[0.2px] opacity-90'
      } ${className}`}
    >
      {showReal ? revealedText : maskedText}
    </span>
  );
};
