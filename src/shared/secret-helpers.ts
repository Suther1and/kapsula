/**
 * Masks sensitive login identifiers / cardholder names before storing plaintext previews
 * outside encrypted secret payloads on Desktop and Mobile.
 */
export function maskLoginHint(login: string): string {
  const trimmed = login.trim();
  if (!trimmed) return '';
  const atIdx = trimmed.indexOf('@');
  if (atIdx > 1) {
    return `${trimmed[0]}***${trimmed.slice(atIdx)}`;
  }
  if (trimmed.length <= 3) return `${trimmed[0]}**`;
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-1)}`;
}
