import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultRepository } from '@main/db/repository';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import { VaultCrypto } from '@main/security/vault-crypto';

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-v2-test-'));
  tempDirs.push(dir);
  return dir;
}

function openRepo(dbPath: string): VaultRepository {
  const repo = new VaultRepository(dbPath);
  openRepos.push(repo);
  return repo;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (openRepos.length > 0) {
    try {
      openRepos.pop()!.close();
    } catch {
      // ignore already closed
    }
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Kapsula 2.0 Core Flows', () => {
  it('preserves open section (orbitOverride) even after background enrichment', async () => {
    const dir = makeTempDir();
    const repo = openRepo(path.join(dir, 'vault.db'));
    const cryptoVault = new VaultCrypto(dir, null);
    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
      dataDir: dir,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: 'local',
        apiKey: null,
        monthlyCapUsd: 1.5,
        enableAutoOcr: false,
        enableUrlUnfurl: false,
      }),
    });

    const workOrbit = repo.createOrbit({ name: 'Работа', description: 'Проекты и задачи' });

    // Note stays strictly inside explicitly chosen section
    const noteItem = await pipeline.capture({
      title: 'Список покупок',
      text: '- [ ] Купить кофе\n- [ ] Сделать презентацию',
      orbitOverride: workOrbit.id,
      source: 'vault_ui',
    });
    expect(noteItem.orbit).toBe(workOrbit.id);

    // Bank card text captured without orbitOverride stays cleanly inside Сейф without spawning sidebar orbits
    const cardItem = await pipeline.capture({
      text: 'МИР 2202 2006 1234 5676 09/29 CVV 384',
      source: 'vault_ui',
    });
    expect(cardItem.dna).toBe('secret');
    expect(cardItem.orbit).toBe('');
    expect(repo.listOrbits().some((o) => o.name === 'Финансы')).toBe(false);
    expect(cardItem.secretMeta?.kind).toBe('bank_card');
    expect(cardItem.secretMeta?.last4).toBe('5676');

    await pipeline.waitForIdle();

    const fetchedNote = repo.getItemById(noteItem.id);
    expect(fetchedNote?.orbit).toBe(workOrbit.id);
  });

  it('supports soft-delete snapshot, restoreRawRow with FTS5 recovery, pin & archive filters', () => {
    const dir = makeTempDir();
    const repo = openRepo(path.join(dir, 'vault.db'));

    const created = repo.createItem({
      dna: 'note',
      orbit: 'work',
      modeCaptured: 'autopilot',
      title: 'Архитектура релиза',
      body: 'УникальноеСловоДляВосстановления в тексте',
      tags: ['релиз'],
      source: 'vault_ui',
      contentHash: 'hash-restore-1',
    });

    repo.updateItem(created.id, { isPinned: true, isArchived: true });
    expect(repo.queryItems({ isPinned: true })).toHaveLength(0); // archived hidden by default
    expect(repo.queryItems({ archivedOnly: true })).toHaveLength(1);

    repo.updateItem(created.id, { isArchived: false });
    expect(repo.queryItems({ isPinned: true })).toHaveLength(1);

    const rawSnap = repo.getRawRowById(created.id);
    expect(rawSnap).not.toBeNull();

    expect(repo.deleteItem(created.id)).toBe(true);
    expect(repo.getItemById(created.id)).toBeNull();
    expect(repo.queryItems({ search: 'УникальноеСловоДляВосстановления' })).toHaveLength(0);

    repo.restoreRawRow(rawSnap!);
    const restored = repo.getItemById(created.id);
    expect(restored?.title).toBe('Архитектура релиза');
    expect(repo.queryItems({ search: 'УникальноеСловоДляВосстановления' })).toHaveLength(1);

    repo.close();
  });
});
