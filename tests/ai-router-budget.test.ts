import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORBITS } from '@shared/constants';
import type { OrbitDef } from '@shared/types';

const BASE_ORBITS: OrbitDef[] = [
  { id: 'personal', name: 'Личное', description: 'Заметки и идеи', icon: 'Heart', color: '#E86A33', sortOrder: 1, isBuiltin: false },
  { id: 'work', name: 'Работа', description: 'Задачи и проекты', icon: 'Briefcase', color: '#3B82F6', sortOrder: 2, isBuiltin: false },
  { id: 'finance', name: 'Финансы', description: 'Чеки и карты', icon: 'Receipt', color: '#10B981', sortOrder: 3, isBuiltin: false },
  { id: 'learn', name: 'Обучение', description: 'Статьи и гайды', icon: 'BookOpen', color: '#8B5CF6', sortOrder: 4, isBuiltin: false },
];

const TEST_ORBITS: OrbitDef[] = [
  ...BASE_ORBITS,
  { id: 'design', name: 'Дизайн', description: 'UI и вдохновение', icon: 'Palette', color: '#EC4899', sortOrder: 5, isBuiltin: false },
];
import { classifyWithDecisionApi } from '@main/ai/decision-router';
import { askVaultWithAi, runAiPipeline } from '@main/ai/enricher';
import { VaultRepository } from '@main/db/repository';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import { isPrivateOrLocalHostname, unfurlUrl } from '@main/pipeline/unfurler';
import { VaultCrypto } from '@main/security/vault-crypto';

const tempDirs: string[] = [];
const repos: VaultRepository[] = [];

function createTestEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-ai-test-'));
  tempDirs.push(dir);
  const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
  repos.push(repo);
  const cryptoVault = new VaultCrypto(dir, null);
  return { dir, repo, cryptoVault };
}

afterEach(() => {
  while (repos.length > 0) repos.pop()!.close();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('AI Decision Router, SHA-256 Cache, Budget Cap & Secret Shield', () => {
  it('calls Gemini Flash-Lite & OpenRouter Chat Completions structured JSON router', async () => {
    let seenUrl = '';
    const geminiMockFetch = (async (url: string | URL) => {
      seenUrl = String(url);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      orbit: 'finance',
                      dna: 'note',
                      confidence: 0.92,
                      needs_enrichment: false,
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 25 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const gRes = await classifyWithDecisionApi({
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestKey123',
      text: 'Чек оплаты заказа',
      domain: null,
      hasImage: false,
      orbits: BASE_ORBITS,
      fallbackOrbit: 'personal',
      fallbackDna: 'note',
      fetchFn: geminiMockFetch,
    });
    expect(seenUrl).toContain('generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
    expect(gRes.orbit).toBe('finance');
    expect(gRes.needsEnrichment).toBe(false);

    const orMockFetch = (async (url: string | URL) => {
      seenUrl = String(url);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  orbit: 'work',
                  dna: 'snippet',
                  confidence: 0.91,
                  needs_enrichment: true,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.0001 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const oRes = await classifyWithDecisionApi({
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test123',
      text: 'const router = true;',
      domain: 'github.com',
      hasImage: false,
      orbits: BASE_ORBITS,
      fallbackOrbit: 'work',
      fallbackDna: 'snippet',
      fetchFn: orMockFetch,
    });
    expect(seenUrl).toContain('openrouter.ai/api/v1/chat/completions');
    expect(oRes.orbit).toBe('work');
    expect(oRes.dna).toBe('snippet');
    expect(oRes.needsEnrichment).toBe(true);
  });

  it('caches by SHA-256 contentHash and stops cloud requests when monthly cap is reached', async () => {
    const { repo } = createTestEnv();
    let callCount = 0;
    const mockFetch = (async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      orbit: 'learn',
                      dna: 'link',
                      confidence: 0.92,
                      needs_enrichment: false,
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 25 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const first = await runAiPipeline({
      repo,
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestKey123',
      capUsd: 1.5,
      contentHash: 'same-hash-001',
      rawText: 'https://react.dev гайд',
      domain: 'react.dev',
      hasImage: false,
      orbits: BASE_ORBITS,
      localBaseline: { orbit: 'work', dna: 'link', title: 'React Docs', summary: '', tags: ['react'] },
      fetchFn: mockFetch,
    });
    expect(callCount).toBe(1);
    expect(first.usedCloud).toBe(true);

    // Second run with same hash hits SHA-256 cache with 0 network calls
    const second = await runAiPipeline({
      repo,
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestKey123',
      capUsd: 1.5,
      contentHash: 'same-hash-001',
      rawText: 'https://react.dev гайд',
      domain: 'react.dev',
      hasImage: false,
      orbits: BASE_ORBITS,
      localBaseline: { orbit: 'work', dna: 'link', title: 'React Docs', summary: '', tags: ['react'] },
      fetchFn: mockFetch,
    });
    expect(callCount).toBe(1);
    expect(second.fromCache).toBe(true);

    // Exceed cap and check new contentHash is locally handled with budgetBlocked: true
    repo.logAiUsage('google_ai_studio', 'test', 0, 0, 1.55);
    const overCap = await runAiPipeline({
      repo,
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestKey123',
      capUsd: 1.5,
      contentHash: 'new-hash-002',
      rawText: 'Заметка сверх лимита',
      domain: null,
      hasImage: false,
      orbits: BASE_ORBITS,
      localBaseline: { orbit: 'personal', dna: 'note', title: 'Заметка', summary: '', tags: [] },
      fetchFn: mockFetch,
    });
    expect(callCount).toBe(1);
    expect(overCap.budgetBlocked).toBe(true);
    expect(overCap.usedCloud).toBe(false);
  });

  it('guarantees secrets are NEVER sent to cloud AI fetch calls', async () => {
    const { dir, repo, cryptoVault } = createTestEnv();
    let cloudCalled = false;
    const throwingFetch = (async () => {
      cloudCalled = true;
      throw new Error('Secrets must never reach cloud AI!');
    }) as typeof fetch;

    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
      dataDir: dir,
      fetchFn: throwingFetch,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: 'openrouter',
        apiKey: 'sk-or-v1-live',
        monthlyCapUsd: 1.5,
        enableAutoOcr: false,
        enableUrlUnfurl: false,
      }),
    });

    const item = await pipeline.capture({
      text: 'Сервис: AWS\nЛогин: ops@corp.com\nПароль: TopSecretPassword!99',
      source: 'vault_ui',
    });
    await pipeline.waitForIdle();

    expect(cloudCalled).toBe(false);
    expect(item.dna).toBe('secret');
    expect(item.aiStatus).toBe('skipped_secret');
    expect(item.hasEncryptedPayload).toBe(true);
  });

  it('escalates Tier 2 Flash-Lite on needsEnrichment/HTTP 500, locks hasImage=shot, and avoids poisoning cache on errors', async () => {
    const { repo } = createTestEnv();

    // 1. google_ai_studio: needs_enrichment: true triggers Tier 2 Flash-Lite, keeps dna === 'shot' & drops bogus orbit
    const gUrls: string[] = [];
    let gCall = 0;
    const geminiTier2Fetch = (async (url: string | URL) => {
      gCall++;
      const s = String(url);
      gUrls.push(s);
      if (gCall === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        orbit: 'design',
                        dna: 'note',
                        confidence: 0.85,
                        needs_enrichment: true,
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 25 },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      orbit: 'nonexistent_orbit',
                      dna: 'note',
                      title: 'Скриншот UI-компонента',
                      summary: 'Сохранена карточка интерфейса',
                      tags: ['ui', 'дизайн'],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 80 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const gOut = await runAiPipeline({
      repo,
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestTier2',
      capUsd: 1.5,
      contentHash: 'tier2-g-hash',
      rawText: 'Длинный скриншот с интерфейсом',
      domain: null,
      hasImage: true,
      orbits: TEST_ORBITS,
      localBaseline: { orbit: 'design', dna: 'shot', title: 'Скриншот', summary: '', tags: ['скрин'] },
      fetchFn: geminiTier2Fetch,
    });
    expect(gUrls.some((u) => u.includes('gemini-2.5-flash-lite:generateContent'))).toBe(true);
    expect(gOut.dna).toBe('shot');
    expect(gOut.orbit).toBe('design');
    expect(gOut.title).toBe('Скриншот UI-компонента');
    expect(gOut.usedCloud).toBe(true);
    expect(repo.getMonthBudgetSummary('google_ai_studio', 1.5, true).spentUsd).toBeGreaterThan(0);

    // 2. openrouter: first router call HTTP 500 -> fallbackToChat triggers Tier 2 Chat Completions
    const orUrls: string[] = [];
    let orCall = 0;
    const openrouterFallbackFetch = (async (url: string | URL) => {
      orCall++;
      const s = String(url);
      orUrls.push(s);
      if (orCall === 1) {
        return new Response('Upstream 500', { status: 500 });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  orbit: 'work',
                  dna: 'link',
                  title: 'Документация TypeScript',
                  summary: 'Гайд по типизации',
                  tags: ['typescript'],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 60, cost: 0.0002 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const orOut = await runAiPipeline({
      repo,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-tier2',
      capUsd: 1.5,
      contentHash: 'tier2-or-hash',
      rawText: 'https://typescriptlang.org/docs',
      domain: 'typescriptlang.org',
      hasImage: false,
      orbits: BASE_ORBITS,
      localBaseline: { orbit: 'personal', dna: 'link', title: 'TS Docs', summary: '', tags: [] },
      fetchFn: openrouterFallbackFetch,
    });
    expect(orUrls.some((u) => u.includes('openrouter.ai/api/v1/chat/completions'))).toBe(true);
    expect(orOut.orbit).toBe('work');
    expect(orOut.title).toBe('Документация TypeScript');
    expect(orOut.usedCloud).toBe(true);

    // 3. Transient error (both Tier 1 & Tier 2 fail with HTTP 500) must NOT poison ai_cache
    const failingFetch = (async () => new Response('Unavailable', { status: 500 })) as typeof fetch;
    const transient = await runAiPipeline({
      repo,
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestTier2',
      capUsd: 1.5,
      contentHash: 'transient-err-hash',
      rawText: 'Временно недоступный запрос',
      domain: null,
      hasImage: false,
      orbits: BASE_ORBITS,
      localBaseline: { orbit: 'personal', dna: 'note', title: 'Локальный фолбэк', summary: '', tags: [] },
      fetchFn: failingFetch,
    });
    expect(transient.usedCloud).toBe(false);

    let retriedCalls = 0;
    const recovered = await runAiPipeline({
      repo,
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestTier2',
      capUsd: 1.5,
      contentHash: 'transient-err-hash',
      rawText: 'Временно недоступный запрос',
      domain: null,
      hasImage: false,
      orbits: TEST_ORBITS,
      localBaseline: { orbit: 'personal', dna: 'note', title: 'Локальный фолбэк', summary: '', tags: [] },
      fetchFn: (async () => {
        retriedCalls++;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        orbit: 'learn',
                        dna: 'note',
                        confidence: 0.9,
                        needs_enrichment: false,
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 25 },
          }),
          { status: 200 }
        );
      }) as typeof fetch,
    });
    expect(retriedCalls).toBe(1);
    expect(recovered.usedCloud).toBe(true);
    expect(recovered.orbit).toBe('learn');
  });

  it('excludes secret items & redacts inline secrets in cloud askVaultWithAi with HTTP/cap fallback', async () => {
    const { repo, cryptoVault } = createTestEnv();
    repo.createItem({
      dna: 'secret',
      orbit: 'vault',
      modeCaptured: 'ghost',
      title: 'Production DB',
      body: '',
      summary: 'Encrypted',
      encryptedPayload: cryptoVault.encryptSecret({
        service: 'Production DB',
        login: 'root',
        secretValue: 'MEGA_DB_SECRET_999',
        notes: 'промокод облако',
      }),
      tags: ['сейф'],
      source: 'vault_ui',
      contentHash: 'sec-ask-1',
    });

    const promoNote = repo.createItem({
      dna: 'note',
      orbit: 'finance',
      modeCaptured: 'autopilot',
      title: 'Промокод облако KAPSULA-CLOUD',
      body: 'Используй промокод на облако KAPSULA-CLOUD. Пароль: InlineSecret#77',
      tags: ['промокод', 'облако'],
      source: 'vault_ui',
      contentHash: 'note-ask-1',
    });

    repo.createItem({
      dna: 'note',
      orbit: 'work',
      modeCaptured: 'autopilot',
      title: 'План релиза',
      body: 'Выкатить версию 1.0 в пятницу',
      tags: ['релиз'],
      source: 'vault_ui',
      contentHash: 'note-ask-2',
    });

    let sentUserPrompt = '';
    const askFetch = (async (_url: string | URL, init?: RequestInit) => {
      const reqBody = JSON.parse(String(init?.body ?? '{}')) as {
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
      };
      sentUserPrompt = reqBody.contents?.[0]?.parts?.[0]?.text ?? '';
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      answer: 'Промокод для облака — KAPSULA-CLOUD [#1].',
                      cited_ids: [promoNote.id],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const askRes = await askVaultWithAi({
      repo,
      question: 'Какой у меня промокод на облако?',
      provider: 'google_ai_studio',
      apiKey: 'AIzaAskKey',
      capUsd: 1.5,
      fetchFn: askFetch,
    });

    expect(sentUserPrompt).not.toContain('MEGA_DB_SECRET_999');
    expect(sentUserPrompt).not.toContain('Production DB');
    expect(sentUserPrompt).not.toContain('InlineSecret#77');
    expect(sentUserPrompt).toContain('KAPSULA-CLOUD');
    expect(askRes.answer).toContain('KAPSULA-CLOUD');
    expect(askRes.citations.some((c) => c.id === promoNote.id)).toBe(true);

    // HTTP 500 fallback
    const askFallback = await askVaultWithAi({
      repo,
      question: 'Какой у меня промокод на облако?',
      provider: 'google_ai_studio',
      apiKey: 'AIzaAskKey',
      capUsd: 1.5,
      fetchFn: (async () => new Response('Fail', { status: 500 })) as typeof fetch,
    });
    expect(askFallback.usedProvider).toBe('local');
    expect(askFallback.citations.some((c) => c.id === promoNote.id)).toBe(true);

    // Cap exceeded skips cloud
    repo.logAiUsage('google_ai_studio', 'cap-fill', 0, 0, 2.0);
    let capCloudCalled = false;
    const askOverCap = await askVaultWithAi({
      repo,
      question: 'Какой у меня промокод на облако?',
      provider: 'google_ai_studio',
      apiKey: 'AIzaAskKey',
      capUsd: 1.5,
      fetchFn: (async () => {
        capCloudCalled = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    expect(capCloudCalled).toBe(false);
    expect(askOverCap.usedProvider).toBe('local');
  });

  it('handles buffer reprocessing, orbitOverride preservation, and ghost+image encryption locally', async () => {
    const { dir, repo, cryptoVault } = createTestEnv();
    let ghostCloudCalled = false;
    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
      dataDir: dir,
      fetchFn: (async () => {
        ghostCloudCalled = true;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        orbit: 'learn',
                        dna: 'note',
                        confidence: 0.95,
                        needs_enrichment: false,
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 25 },
          }),
          { status: 200 }
        );
      }) as typeof fetch,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: 'google_ai_studio',
        apiKey: 'AIzaPipeKey',
        monthlyCapUsd: 1.5,
        enableAutoOcr: false,
        enableUrlUnfurl: false,
      }),
    });

    // 1. Buffer mode capture -> raw_buffer (unassigned '') -> reprocessBufferAll
    const bufItem = await pipeline.capture({
      text: 'Статья про паттерны React',
      mode: 'buffer',
      source: 'vault_ui',
    });
    expect(bufItem.aiStatus).toBe('raw_buffer');
    expect(bufItem.orbit).toBe('');

    const reprocessedCount = await pipeline.reprocessBufferAll();
    expect(reprocessedCount).toBe(1);
    expect(repo.getItemById(bufItem.id)?.aiStatus).not.toBe('raw_buffer');

    // 2. Explicit orbitOverride stays preserved after background reprocessItem
    const mediaOrbit = repo.createOrbit({ name: 'Медиа', description: 'UI вдохновение' });
    const customOrbItem = await pipeline.capture({
      text: 'Подборка UI вдохновения',
      mode: 'autopilot',
      orbitOverride: mediaOrbit.id,
      source: 'vault_ui',
    });
    await pipeline.waitForIdle();
    await pipeline.reprocessItem(customOrbItem.id);
    expect(repo.getItemById(customOrbItem.id)?.orbit).toBe(mediaOrbit.id);

    // 3. Ghost mode WITH an image encrypts locally, leaves no unencrypted media file, and skips cloud AI
    ghostCloudCalled = false;
    const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z0AAAAASUVORK5CYII=';
    const ghostItem = await pipeline.capture({
      text: 'Секрет с картинки рядом',
      imageBase64: png1x1,
      mode: 'ghost',
      source: 'capsule_drop',
    });
    await pipeline.waitForIdle();

    expect(ghostCloudCalled).toBe(false);
    expect(ghostItem.dna).toBe('secret');
    expect(ghostItem.hasEncryptedPayload).toBe(true);
    expect(ghostItem.imagePath).toBeNull();
    expect(ghostItem.aiStatus).toBe('skipped_secret');
    expect(fs.readdirSync(pipeline.getMediaDir())).toHaveLength(0);
  });

  it('blocks SSRF targets/redirects and parses apostrophes & protocol-relative og:image in unfurlUrl', async () => {
    expect(await unfurlUrl('http://[::1]:8080/admin')).toMatchObject({
      title: null,
      description: null,
      ogImageUrl: null,
    });
    expect(await unfurlUrl('http://127.0.0.2/health')).toMatchObject({
      title: null,
      description: null,
      ogImageUrl: null,
    });
    expect(await unfurlUrl('http://169.254.169.254/latest/meta-data')).toMatchObject({
      title: null,
      description: null,
      ogImageUrl: null,
    });
    expect(await unfurlUrl('file:///C:/Windows/win.ini')).toMatchObject({
      title: null,
      description: null,
      ogImageUrl: null,
    });

    const dnsLookupSpy = vi.spyOn(dns.promises, 'lookup').mockImplementation((async (
      hostname: string
    ) => {
      if (hostname === 'rebind.example') {
        return [{ address: '127.0.0.1', family: 4 }];
      }
      return [{ address: '93.184.216.34', family: 4 }];
    }) as unknown as typeof dns.promises.lookup);

    vi.stubGlobal('fetch', async (url: string | URL) => {
      const s = String(url);
      if (s === 'https://public.example/go') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1:47831/health' },
        });
      }
      if (s === 'https://public.example/guide') {
        const html = `
          <html><head>
            <meta property='og:title' content="O'Reilly Guide">
            <meta property="og:description" content='Great &amp; Fast'>
            <meta property="og:image" content="//cdn.example.com/og.png">
          </head></html>
        `;
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      throw new Error(`Unexpected fetch to ${s}`);
    });

    try {
      const blockedRebind = await unfurlUrl('https://rebind.example/secret');
      expect(blockedRebind).toMatchObject({ title: null, description: null, ogImageUrl: null });

      const blockedRedirect = await unfurlUrl('https://public.example/go');
      expect(blockedRedirect).toMatchObject({ title: null, description: null, ogImageUrl: null });

      const parsedMeta = await unfurlUrl('https://public.example/guide');
      expect(parsedMeta.title).toBe("O'Reilly Guide");
      expect(parsedMeta.description).toBe('Great & Fast');
      expect(parsedMeta.ogImageUrl).toBe('https://cdn.example.com/og.png');
    } finally {
      dnsLookupSpy.mockRestore();
      vi.unstubAllGlobals();
    }

    // Alternate IPv4/IPv6/CGNAT SSRF encodings must be rejected without calling fetch
    for (const blocked of [
      '127.1',
      '0177.0.0.1',
      '[0:0:0:0:0:ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '100.64.0.1',
    ]) {
      expect(isPrivateOrLocalHostname(blocked)).toBe(true);
      expect(await unfurlUrl(`http://${blocked}/secret`)).toMatchObject({
        title: null,
        description: null,
        ogImageUrl: null,
      });
    }
    expect(isPrivateOrLocalHostname('93.184.216.34')).toBe(false);
  });

  it('sends Gemini API key in x-goog-api-key header rather than URL query string', async () => {
    const { repo } = createTestEnv();
    const capturedCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    let callIdx = 0;

    const mockFetch = (async (url: string | URL, init?: RequestInit) => {
      callIdx++;
      const s = String(url);
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedCalls.push({ url: s, headers: rawHeaders });
      if (callIdx === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        orbit: 'work',
                        dna: 'note',
                        confidence: 0.9,
                        needs_enrichment: true,
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 25 },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      orbit: 'work',
                      dna: 'note',
                      title: 'Тестовая заметка',
                      summary: 'Краткая сводка',
                      tags: ['тест'],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    await runAiPipeline({
      repo,
      provider: 'google_ai_studio',
      apiKey: 'AIzaSecretHeaderTest999',
      capUsd: 2,
      contentHash: 'header-auth-check-1',
      rawText: 'Длинная заметка для проверки передачи ключа в заголовке',
      domain: null,
      hasImage: false,
      orbits: BASE_ORBITS,
      localBaseline: { orbit: 'work', dna: 'note', title: 'Заметка', summary: '', tags: [] },
      fetchFn: mockFetch,
    });

    expect(capturedCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of capturedCalls) {
      expect(call.url).not.toContain('?key=');
      expect(call.url).not.toContain('AIzaSecretHeaderTest999');
      expect(call.headers['x-goog-api-key']).toBe('AIzaSecretHeaderTest999');
    }
  });
});
