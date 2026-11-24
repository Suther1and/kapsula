import type { VaultItem } from '@shared/types';

export async function hydrateFullVaultItem(item: VaultItem): Promise<VaultItem> {
  if (!item || item.id === '__draft__' || !item.isCardProjection) return item;
  try {
    const full = await window.kapsula.getVaultItem(item.id, {
      includeDeleted: Boolean(item.deletedAt),
    });
    return full ?? item;
  } catch {
    return item;
  }
}
