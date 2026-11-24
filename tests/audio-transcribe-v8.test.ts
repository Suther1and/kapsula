import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askVaultWithAi, previewSmartTriageWithAi } from '@main/ai/enricher';
import { transformNoteText } from '@main/ai/text-studio';
import { ensureDemoSeeded } from '@main/db/demo-seed';
import { VaultRepository } from '@main/db/repository';
import { transcribeAudioFile } from '@main/pipeline/audio-pipeline';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import { defaultLocalOcrAdapter } from '@main/platform/platform-adapters';
import { VaultCrypto } from '@main/security/vault-crypto';

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];

const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=';

function makeTempEnv(opts?: {
  aiProvider?: 'local' | 'google_ai_studio' | 'openrouter';
  apiKey?: string | null;
  googleAiKey?: string | null;
  openRouterKey?: string | null;
  enableAutoOcr?: boolean;
  fetchFn?: typeof fetch;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-v8-audio-'));
  tempDirs.push(dir);
  const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
  openRepos.push(repo);
  const cryptoVault = new VaultCrypto(dir, null);
  const pipeline = new CapturePipeline({
    repo,
    cryptoVault,
    dataDir: dir,
    fetchFn: opts?.fetchFn,
    getConfig: () => ({
      activeMode: 'autopilot',
      activeFocusBoardId: null,
      aiProvider: opts?.aiProvider ?? 'google_ai_studio',
      apiKey: opts?.apiKey !== undefined ? opts.apiKey : 'AIzaTestAudioKey123',
      googleAiKey: opts?.googleAiKey,
      openRouterKey: opts?.openRouterKey,
      monthlyCapUsd: 2.0,
      enableAutoOcr: opts?.enableAutoOcr ?? false,
      enableUrlUnfurl: false,
    }),
  });
  return { dir, repo, cryptoVault, pipeline };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (openRepos.length > 0) {
    try {
      openRepos.pop()!.close();
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Kapsula v8 Voice AI Transcription, Inline Image Asset & AI Security', () => {
  it('strips Gemini 2.5 thinking blocks, sends thinkingBudget: 0 & maxOutputTokens: 4096', async () => {
    const seenPayloads: Array<Record<string, unknown>> = [];
    const mockFetch: typeof fetch = async (_url, init) => {
      if (init?.body) {
        seenPayloads.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'Let me think carefully about this audio...' },
                  {
                    text: JSON.stringify({
                      title: 'План на понедельник',
                      summary: 'Нужно согласовать бюджет и созвониться с клиентом.',
                      transcript:
                        'Привет, не забыть в понедельник согласовать бюджет проекта и созвониться с клиентом в два часа.',
                      keyPoints: ['Согласовать бюджет проекта', 'Созвон с клиентом в 14:00'],
                      actionItems: ['Согласовать бюджет проекта', 'Созвониться с клиентом в 14:00'],
                      tags: ['работа', 'план'],
                      suggestedSection: 'Работа',
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 120 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const res = await transcribeAudioFile({
      buffer: Buffer.from('RIFF....WAVEfmt '),
      mime: 'audio/wav',
      durationSec: 18,
      extractTasks: true,
      aiProvider: 'google_ai_studio',
      googleAiKey: 'AIzaGeminiKey999',
      fetchFn: mockFetch,
    });

    expect(res.ok).toBe(true);
    expect(res.result?.transcript).toContain('согласовать бюджет проекта');
    expect(res.result?.title).toBe('План на понедельник');
    expect(res.result?.actionItems).toEqual([
      'Согласовать бюджет проекта',
      'Созвониться с клиентом в 14:00',
    ]);

    const genCfg = seenPayloads[0]?.generationConfig as Record<string, unknown>;
    expect(genCfg?.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(genCfg?.maxOutputTokens).toBe(4096);
  });

  it('returns clear human Russian errors when local mode, missing API key, or HTTP 401/429', async () => {
    const buf = Buffer.from('RIFF....WAVEfmt ');

    const localRes = await transcribeAudioFile({
      buffer: buf,
      mime: 'audio/wav',
      aiProvider: 'local',
    });
    expect(localRes.ok).toBe(false);
    expect(localRes.error).toContain('Включи облачный ИИ');

    const noKeyRes = await transcribeAudioFile({
      buffer: buf,
      mime: 'audio/wav',
      aiProvider: 'google_ai_studio',
      googleAiKey: '',
    });
    expect(noKeyRes.ok).toBe(false);
    expect(noKeyRes.error).toContain('Добавь ключ ИИ');

    const authErr = await transcribeAudioFile({
      buffer: buf,
      mime: 'audio/wav',
      aiProvider: 'google_ai_studio',
      googleAiKey: 'bad-key',
      fetchFn: async () => new Response('Unauthorized', { status: 401 }),
    });
    expect(authErr.ok).toBe(false);
    expect(authErr.error).toContain('Ключ ИИ отклонён');

    const quotaErr = await transcribeAudioFile({
      buffer: buf,
      mime: 'audio/wav',
      aiProvider: 'google_ai_studio',
      googleAiKey: 'quota-key',
      fetchFn: async () => new Response('Rate limited', { status: 429 }),
    });
    expect(quotaErr.ok).toBe(false);
    expect(quotaErr.error).toContain('Превышен лимит запросов');
  });

  it('transcribes existing voice items, writes body + tasks, saves revision snapshot, replaces generic title, and hooks reprocessItem', async () => {
    let callCount = 0;
    const mockFetch: typeof fetch = async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'analyzing speech...' },
                  {
                    text: JSON.stringify({
                      title: 'Список покупок к ужину',
                      summary: 'Купить продукты и забронировать столик.',
                      transcript:
                        'Нужно купить свежие овощи, оливковое масло и забронировать столик на субботу.',
                      keyPoints: ['Свежие овощи и оливковое масло'],
                      actionItems: ['Купить свежие овощи и оливковое масло', 'Забронировать столик на субботу'],
                      tags: ['покупки', 'личное'],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    // Capture initially in local mode (produces untranscribed voice note with empty body + transcriptError)
    let currentProvider: 'local' | 'google_ai_studio' = 'local';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-v8-voice-item-'));
    tempDirs.push(dir);
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);
    const cryptoVault = new VaultCrypto(dir, null);
    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
      dataDir: dir,
      fetchFn: mockFetch,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: currentProvider,
        apiKey: currentProvider === 'google_ai_studio' ? 'AIzaLiveKey123' : null,
        monthlyCapUsd: 2.0,
        enableAutoOcr: false,
        enableUrlUnfurl: false,
      }),
    });

    const fakeWav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64, 1)]);
    const voiceItem = await pipeline.capture({
      audioBase64: fakeWav.toString('base64'),
      audioMime: 'audio/wav',
      audioDurationSec: 21,
      source: 'hud',
    });
    await pipeline.waitForIdle();

    const afterLocal = repo.getItemById(voiceItem.id)!;
    expect(afterLocal.body).toBe('');
    expect(afterLocal.title).toContain('Голосовая заметка');
    expect((afterLocal.mediaMeta as Record<string, unknown>)?.transcriptError).toContain('Включи облачный ИИ');

    // Now switch to cloud AI and explicitly transcribe with extractTasks: true
    currentProvider = 'google_ai_studio';
    const tr = await pipeline.transcribeExistingItem({
      itemId: voiceItem.id,
      extractTasks: true,
    });
    expect(tr.ok).toBe(true);
    expect(tr.transcript).toContain('купить свежие овощи');
    expect(tr.extractedTasks).toHaveLength(2);
    expect(tr.item?.title).toBe('Список покупок к ужину');
    expect(tr.item?.body).toContain('Нужно купить свежие овощи');
    expect(tr.item?.body).toContain('## Задачи\n- [ ] Купить свежие овощи');
    expect(tr.item?.aiStatus).toBe('enriched');
    expect((tr.item?.mediaMeta as Record<string, unknown>)?.transcriptError).toBeUndefined();

    // Re-running via reprocessItem delegates to transcribeExistingItem and saves a 'voice' revision snapshot
    const reprocessed = await pipeline.reprocessItem(voiceItem.id);
    expect(callCount).toBe(2);
    expect(reprocessed?.body).toContain('купить свежие овощи');
    const revisions = repo.listItemRevisions(voiceItem.id);
    expect(revisions.some((r) => r.source === 'voice')).toBe(true);
  });

  it('saves inline note images into media/ via saveNoteImageAsset without creating a vault item', async () => {
    const { pipeline, repo } = makeTempEnv({ aiProvider: 'local', apiKey: null });

    const saved = await pipeline.saveNoteImageAsset({
      base64: `data:image/png;base64,${SAMPLE_PNG_BASE64}`,
      fileName: 'diagram.png',
    });

    expect(saved.filename).toMatch(/\.png$/);
    expect(saved.mediaUrl).toBe(`kapsula-media://local/${saved.filename}`);
    expect(fs.existsSync(path.join(pipeline.getMediaDir(), saved.filename))).toBe(true);
    expect(repo.queryItems({ limit: 50 })).toHaveLength(0);
  });

  it('defers sync_dirty until background OCR finishes and converts bank card screenshot to encrypted secret', async () => {
    let releaseOcr!: () => void;
    const ocrGate = new Promise<void>((resolve) => {
      releaseOcr = resolve;
    });
    vi.spyOn(defaultLocalOcrAdapter, 'extractText').mockImplementation(async () => {
      await ocrGate;
      return {
        text: 'МИР Банк 2200 7007 1234 5676 09/29 CVV 741',
        lines: ['МИР Банк 2200 7007 1234 5676 09/29 CVV 741'],
      };
    });

    const { pipeline, repo } = makeTempEnv({
      aiProvider: 'local',
      apiKey: null,
      enableAutoOcr: true,
    });

    const initialItem = await pipeline.capture({
      imageBase64: SAMPLE_PNG_BASE64,
      source: 'vault_ui',
    });
    expect(initialItem.dna).toBe('shot');
    expect(
      repo.db.prepare("SELECT COUNT(*) AS c FROM sync_dirty WHERE entity_id = ?").get(initialItem.id)
    ).toEqual({ c: 0 });

    releaseOcr();
    await pipeline.waitForIdle();

    const item = repo.getItemById(initialItem.id);
    expect(item).not.toBeNull();
    expect(item!.dna).toBe('secret');
    expect(item!.imagePath).toBeNull();
    expect(item!.thumbPath).toBeNull();
    expect(item!.ocrText).toBe('');
    expect(item!.aiStatus).toBe('skipped_secret');
    expect(item!.secretMeta?.kind).toBe('bank_card');
    expect(fs.readdirSync(pipeline.getMediaDir())).toHaveLength(0);
  });

  it('redacts inline secrets in transformNoteText before cloud call and restores placeholders locally', async () => {
    const { repo } = makeTempEnv();
    let seenPrompt = '';
    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
      };
      seenPrompt = body.contents?.[0]?.parts?.[0]?.text ?? '';
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      titleSuggestion: 'Настройка сервиса',
                      formattedText: `## Настройка\n\n${seenPrompt}`,
                      extractedTasks: [],
                      summary: 'Заметка по настройке',
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 30 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const rawWithSecret =
      'Подключить сервис оплаты.\nКлюч: sk-or-v1-supersecrettokenvalue9876543210\nПароль: MyUltraSecretPass#99';

    const res = await transformNoteText({
      text: rawWithSecret,
      preset: 'structure',
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestStudio',
      repo,
      fetchFn: mockFetch,
    });

    expect(seenPrompt).not.toContain('sk-or-v1-supersecrettokenvalue9876543210');
    expect(seenPrompt).not.toContain('MyUltraSecretPass#99');
    expect(seenPrompt).toContain('[REDACTED_SECRET_0]');
    expect(res.usedCloud).toBe(true);
    expect(res.formattedText).toContain('sk-or-v1-supersecrettokenvalue9876543210');
    expect(res.formattedText).toContain('MyUltraSecretPass#99');

    // A 12-word seed phrase must NEVER even call cloud fetch (falls back 100% locally)
    let seedCloudCalled = false;
    const seedRes = await transformNoteText({
      text: 'apple banana cherry delta echo foxtrot golf hotel india juliet kilo lima',
      preset: 'polish',
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestStudio',
      repo,
      fetchFn: async () => {
        seedCloudCalled = true;
        throw new Error('Seed phrase must not reach cloud!');
      },
    });
    expect(seedCloudCalled).toBe(false);
    expect(seedRes.usedCloud).toBe(false);
  });

  it('excludes secrets from previewSmartTriageWithAi examples and omits bankCards metadata on non-finance askVaultWithAi queries', async () => {
    const { repo, cryptoVault } = makeTempEnv();
    const fin = repo.createOrbit({ name: 'Финансы', description: 'Бюджет', color: '#2EA06B', icon: 'Receipt' });
    const work = repo.createOrbit({ name: 'Работа', description: 'Проекты', color: '#3B82F6', icon: 'Briefcase' });

    // Create a secret card inside Финансы
    repo.createItem({
      dna: 'secret',
      orbit: fin.id,
      modeCaptured: 'ghost',
      title: 'Секретная карта Платинум •••• 7788',
      body: '',
      summary: 'Банковская карта',
      encryptedPayload: cryptoVault.encryptSecret({
        service: 'Секретная карта Платинум',
        login: '',
        secretValue: '4242 4242 4242 7788',
        cvv: '999',
        notes: '',
      }),
      secretMeta: {
        service: 'Секретная карта Платинум',
        loginHint: '•••• 7788',
        kind: 'bank_card',
        cardBrand: 'Visa',
        last4: '7788',
        hasCvv: true,
      },
      source: 'vault_ui',
      contentHash: 'secret-card-triage-1',
      aiStatus: 'skipped_secret',
    });

    // Regular item containing an inline token inside Работа (example item)
    repo.createItem({
      dna: 'note',
      orbit: work.id,
      modeCaptured: 'autopilot',
      title: 'Интеграция sk-or-v1-leakedexampletoken1234567890',
      body: 'Заметка по проекту',
      summary: 'Токен sk-or-v1-leakedexampletoken1234567890',
      source: 'vault_ui',
      contentHash: 'work-ex-1',
      aiStatus: 'enriched',
    });

    const unsorted = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Подготовить план квартала',
      body: 'Обсудить сроки запуска нового сайта с командой',
      source: 'vault_ui',
      contentHash: 'unsorted-1',
      aiStatus: 'local',
    });

    let triageSysPrompt = '';
    await previewSmartTriageWithAi({
      repo,
      items: [unsorted],
      orbits: [fin, work],
      boards: [],
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestTriage',
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          systemInstruction?: { parts?: Array<{ text?: string }> };
        };
        triageSysPrompt = body.systemInstruction?.parts?.[0]?.text ?? '';
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"suggestions":[],"newOrbits":[],"mergeGroups":[]}' }] } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    expect(triageSysPrompt).not.toContain('Секретная карта Платинум');
    expect(triageSysPrompt).not.toContain('7788');
    expect(triageSysPrompt).not.toContain('sk-or-v1-leakedexampletoken1234567890');

    // askVaultWithAi on a non-finance query MUST NOT send bankCards or bankCardCount
    let nonFinanceAskPrompt = '';
    await askVaultWithAi({
      repo,
      question: 'Какой план квартала?',
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestAsk',
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          contents?: Array<{ parts?: Array<{ text?: string }> }>;
        };
        nonFinanceAskPrompt = body.contents?.[0]?.parts?.[0]?.text ?? '';
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"answer":"План квартала найден.","cited_ids":[]}' }] } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    expect(nonFinanceAskPrompt).not.toContain('bankCards');
    expect(nonFinanceAskPrompt).not.toContain('bankCardCount');
    expect(nonFinanceAskPrompt).not.toContain('7788');

    // Finance query sends ONLY anonymous bankCardCount (still never bankCards array / last4!)
    let financeAskPrompt = '';
    await askVaultWithAi({
      repo,
      question: 'Сколько у меня банковских карт?',
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestAsk',
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          contents?: Array<{ parts?: Array<{ text?: string }> }>;
        };
        financeAskPrompt = body.contents?.[0]?.parts?.[0]?.text ?? '';
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"answer":"У тебя 1 карта.","cited_ids":[]}' }] } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    expect(financeAskPrompt).toContain('"bankCardCount":1');
    expect(financeAskPrompt).not.toContain('"bankCards"');
    expect(financeAskPrompt).not.toContain('7788');
  });

  it('seeds universal everyday productivity demo items without personal or dev-specific clutter', async () => {
    const { repo, cryptoVault, pipeline } = makeTempEnv({ aiProvider: 'local', apiKey: null });
    const count = await ensureDemoSeeded(repo, cryptoVault, pipeline, true);
    expect(count).toBe(6);

    const all = repo.queryItems({ includeArchived: true, includeSecrets: true, limit: 50 });
    const dump = all.map((i) => `${i.title}\n${i.body}\n${i.summary}`).join('\n');
    expect(dump).not.toMatch(/npm run build|npx tsc|Илья Соколов|Ozon|OpenRouter API|Из Telegram/i);
    expect(dump).toContain('Чек-лист поездки');
    expect(dump).toContain('Итоги встречи');
  });

  it('wires all 8 v8 integration IPC channels and prevents double-capture / duplicate AI in ai:dictate-to-text', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    vi.doMock('electron', () => ({
      app: { getPath: () => os.tmpdir(), isPackaged: false },
      clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
      ClipboardItem: class {},
      desktopCapturer: { getSources: vi.fn() },
      dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
      ipcMain: {
        handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => {
          handlers.set(ch, fn);
        }),
      },
      nativeImage: { createFromPath: vi.fn() },
      shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
      systemPreferences: { canPromptTouchID: vi.fn(() => false), promptTouchID: vi.fn() },
    }));

    let audioFetchCalls = 0;
    const mockFetch: typeof fetch = async (_url, init) => {
      const bodyStr = String(init?.body ?? '');
      if (bodyStr.includes('inlineData') || bodyStr.includes('input_audio')) {
        audioFetchCalls += 1;
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: 'Итоги звонка',
                      transcript: 'Нужно подготовить презентацию к пятнице.',
                      formattedText: 'Нужно подготовить презентацию к пятнице.',
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    vi.stubGlobal('fetch', mockFetch);

    try {
      const { dir, repo, cryptoVault, pipeline } = makeTempEnv({
        aiProvider: 'google_ai_studio',
        apiKey: 'AIzaTestDictateSingle',
        fetchFn: mockFetch,
      });
      const { registerIpcHandlers } = await import('@main/ipc');

      registerIpcHandlers({
        dataDir: dir,
        repo,
        cryptoVault,
        pipeline,
        windows: {
          vault: null,
          isOwnWebContents: () => true,
          isAllowedSurfaceUrl: () => true,
          broadcast: vi.fn(),
        } as unknown as Parameters<typeof registerIpcHandlers>[0]['windows'],
        clipper: {} as unknown as Parameters<typeof registerIpcHandlers>[0]['clipper'],
        getSettingsState: () =>
          ({
            theme: 'dark',
            activeMode: 'autopilot',
            activeFocusBoardId: null,
            aiProvider: 'google_ai_studio',
            monthlyCapUsd: 1.5,
            enableAutoOcr: false,
            enableUrlUnfurl: false,
            clipboardAutoWipeSeconds: 30,
            hasOpenRouterKey: false,
            hasGoogleAiKey: true,
            hasMasterPin: false,
            vaultUnlocked: true,
          }) as ReturnType<Parameters<typeof registerIpcHandlers>[0]['getSettingsState']>,
        getApiKeyForProvider: (p) => (p === 'google_ai_studio' ? 'AIzaTestDictateSingle' : null),
        setApiKeyForProvider: vi.fn(),
        setVaultUnlocked: vi.fn(),
      });

      const expectedV8Channels = [
        'media:save-note-image',
        'ai:transcribe-item',
        'integrations:import-eml',
        'integrations:import-markdown-folder',
        'integrations:import-notion-zip',
        'integrations:import-json-backup',
        'integrations:export-markdown-zip',
        'integrations:rotate-email-token',
      ];
      for (const ch of expectedV8Channels) {
        expect(handlers.has(ch), `Missing IPC handler: ${ch}`).toBe(true);
      }

      const fakeEvt = {
        sender: { id: 1, getURL: () => 'http://localhost:5173' },
        senderFrame: null,
      };
      const wavBuf = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x40\x1f\x00\x00\x80\x3e\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00', 'binary');
      const dictateHandler = handlers.get('ai:dictate-to-text')!;
      const result = (await dictateHandler(fakeEvt, {
        audioBase64: wavBuf.toString('base64'),
        mime: 'audio/wav',
        durationSec: 4,
        mode: 'smart',
        saveAsNewItem: true,
      })) as {
        audioPath?: string;
        transcript: string;
        savedItem?: { id: string; mediaPath: string | null; mediaMeta?: { transcript?: string } | null };
      };

      await pipeline.waitForIdle();

      // Audio file saved ONCE, cloud audio transcription invoked ONCE (no duplicate background processAudioIntelligence)
      const mediaFiles = fs.readdirSync(path.join(dir, 'media'));
      expect(mediaFiles).toHaveLength(1);
      expect(audioFetchCalls).toBe(1);
      expect(result.savedItem?.mediaPath).toBe(mediaFiles[0]);
      expect(result.audioPath).toBe(mediaFiles[0]);
      expect(result.savedItem?.mediaMeta?.transcript).toContain('презентацию');
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock('electron');
    }
  });
});
