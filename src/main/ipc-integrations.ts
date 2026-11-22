import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, Dialog, IpcMain, IpcMainInvokeEvent } from 'electron';
import type {
  ExportResult,
  ImportResult,
  SaveNoteImageResult,
  TranscribeItemResult,
  VaultItem,
} from '@shared/types';
import { translate } from '@shared/i18n';
import {
  exportMarkdownZip,
  importJsonBackup,
  importMarkdownFolder,
  importNotionZip,
} from './bridges/markdown-importer';
import type { VaultRepository } from './db/repository';
import type { CapturePipeline } from './pipeline/capture-pipeline';
import { parseEmlBuffer } from './pipeline/email-parser';
import type { SyncEngine } from './sync/sync-engine';

export interface V8IntegrationIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showSaveDialog'>;
  getMainWindow: () => BrowserWindow | null;
  repo: VaultRepository;
  pipeline: CapturePipeline;
  syncEngine?: SyncEngine | null;
  broadcastUpsert?: (item: VaultItem) => void;
  onOrbitsChanged?: () => void;
  onSettingsChanged?: () => void;
  documentsDir?: string;
  handleTrusted?: <TArgs extends unknown[], TResult>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult
  ) => void;
}

function resolveDefaultDocumentsDir(override?: string): string {
  if (override && fs.existsSync(override)) return override;
  const candidate = path.join(os.homedir(), 'Documents');
  if (fs.existsSync(candidate)) return candidate;
  return os.homedir();
}

export function registerV8IntegrationIpc(deps: V8IntegrationIpcDeps): void {
  const register = <TArgs extends unknown[], TResult>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult
  ) => {
    if (deps.handleTrusted) {
      deps.handleTrusted(channel, handler);
    } else {
      deps.ipcMain.handle(channel, (event, ...args) => handler(event, ...(args as TArgs)));
    }
  };

  const showOpenDialog = (options: Electron.OpenDialogOptions) => {
    const win = deps.getMainWindow();
    return win ? deps.dialog.showOpenDialog(win, options) : deps.dialog.showOpenDialog(options);
  };

  const showSaveDialog = (options: Electron.SaveDialogOptions) => {
    const win = deps.getMainWindow();
    return win ? deps.dialog.showSaveDialog(win, options) : deps.dialog.showSaveDialog(options);
  };

  const getLocale = () => deps.repo.getLocale();

  const triggerSyncHint = () => {
    if (deps.syncEngine) {
      void deps.syncEngine.syncNow().catch(() => {});
    }
  };

  // 1. Inline note image asset storage (no separate vault item created)
  register(
    'media:save-note-image',
    async (
      _e,
      input: { base64?: string; bytes?: Uint8Array; filePath?: string; mimeType?: string; fileName?: string }
    ): Promise<SaveNoteImageResult> => {
      const sanitized = { ...(input ?? {}) };
      delete sanitized.filePath;
      return deps.pipeline.saveNoteImageAsset(sanitized);
    }
  );

  // 2. Explicit voice note AI transcription & task extraction
  register(
    'ai:transcribe-item',
    async (
      _e,
      input: { itemId: string; wavBase64Fallback?: string; extractTasks?: boolean }
    ): Promise<TranscribeItemResult> => {
      const res = await deps.pipeline.transcribeExistingItem({
        itemId: String(input?.itemId ?? ''),
        wavBase64Fallback: input?.wavBase64Fallback,
        extractTasks: Boolean(input?.extractTasks),
      });
      if (res.item) {
        deps.broadcastUpsert?.(res.item);
      }
      return res;
    }
  );

  // 3. Offline `.eml` email import (file picker when paths omitted)
  register(
    'integrations:import-eml',
    async (_e, filePaths?: string[]): Promise<ImportResult> => {
      let targets = Array.isArray(filePaths)
        ? filePaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];

      if (targets.length === 0) {
        const locale = getLocale();
        const pick = await showOpenDialog({
          title: translate(locale, 'main.dialog.emlTitle'),
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: translate(locale, 'main.dialog.emlFilter'), extensions: ['eml'] }],
        });
        if (pick.canceled || pick.filePaths.length === 0) {
          return { importedCount: 0, skippedCount: 0, orbitsCreated: 0 };
        }
        targets = pick.filePaths;
      }

      let importedCount = 0;
      let skippedCount = 0;
      const errors: string[] = [];

      const locale = getLocale();
      for (const emlPath of targets) {
        try {
          if (!fs.existsSync(emlPath)) {
            errors.push(
              translate(locale, 'main.ipc.emlFileNotFound', { name: path.basename(emlPath) })
            );
            continue;
          }
          const buf = fs.readFileSync(emlPath);
          const sha = crypto.createHash('sha256').update(buf).digest('hex');
          const parsed = parseEmlBuffer(buf, locale);
          const externalId = parsed.messageId
            ? `eml:${parsed.messageId}`
            : `eml:sha:${sha.slice(0, 24)}`;

          if (deps.repo.findBySourceExternalId('email_import', externalId)) {
            skippedCount += 1;
            continue;
          }

          const item = await deps.pipeline.capture({
            filePath: emlPath,
            fileName: path.basename(emlPath),
            fileMime: 'message/rfc822',
            source: 'email_import',
            externalId,
          });
          deps.broadcastUpsert?.(item);
          importedCount += 1;
        } catch (err) {
          errors.push(
            `${path.basename(emlPath)}: ${
              err instanceof Error ? err.message : translate(locale, 'main.ipc.emlImportError')
            }`
          );
        }
      }

      if (importedCount > 0) {
        deps.onOrbitsChanged?.();
        triggerSyncHint();
      }

      return {
        importedCount,
        skippedCount,
        orbitsCreated: 0,
        errors: errors.length > 0 ? errors : undefined,
      };
    }
  );

  // 4. Obsidian / Markdown folder import
  register(
    'integrations:import-markdown-folder',
    async (_e, folderPath?: string): Promise<ImportResult> => {
      let targetDir = typeof folderPath === 'string' && folderPath.trim() ? folderPath.trim() : '';
      if (!targetDir) {
        const pick = await showOpenDialog({
          title: translate(getLocale(), 'main.dialog.mdTitle'),
          properties: ['openDirectory'],
        });
        if (pick.canceled || pick.filePaths.length === 0) {
          return { importedCount: 0, skippedCount: 0, orbitsCreated: 0 };
        }
        targetDir = pick.filePaths[0]!;
      }

      const res = await importMarkdownFolder(targetDir, {
        repo: deps.repo,
        pipeline: deps.pipeline,
        onOrbitsChanged: deps.onOrbitsChanged,
        broadcastUpsert: deps.broadcastUpsert,
      });
      if (res.importedCount > 0) {
        triggerSyncHint();
      }
      return res;
    }
  );

  // 5. Notion `.zip` export import
  register(
    'integrations:import-notion-zip',
    async (_e, zipPath?: string): Promise<ImportResult> => {
      let targetZip = typeof zipPath === 'string' && zipPath.trim() ? zipPath.trim() : '';
      if (!targetZip) {
        const locale = getLocale();
        const pick = await showOpenDialog({
          title: translate(locale, 'main.dialog.notionTitle'),
          properties: ['openFile'],
          filters: [{ name: translate(locale, 'main.dialog.notionFilter'), extensions: ['zip'] }],
        });
        if (pick.canceled || pick.filePaths.length === 0) {
          return { importedCount: 0, skippedCount: 0, orbitsCreated: 0 };
        }
        targetZip = pick.filePaths[0]!;
      }

      const res = await importNotionZip(targetZip, {
        repo: deps.repo,
        pipeline: deps.pipeline,
        onOrbitsChanged: deps.onOrbitsChanged,
        broadcastUpsert: deps.broadcastUpsert,
      });
      if (res.importedCount > 0) {
        triggerSyncHint();
      }
      return res;
    }
  );

  // 6. Kapsula JSON backup restore
  register(
    'integrations:import-json-backup',
    async (_e, filePath?: string): Promise<ImportResult> => {
      let targetFile = typeof filePath === 'string' && filePath.trim() ? filePath.trim() : '';
      if (!targetFile) {
        const locale = getLocale();
        const pick = await showOpenDialog({
          title: translate(locale, 'main.dialog.backupOpenTitle'),
          properties: ['openFile'],
          filters: [{ name: translate(locale, 'main.dialog.backupFilter'), extensions: ['json'] }],
        });
        if (pick.canceled || pick.filePaths.length === 0) {
          return { importedCount: 0, skippedCount: 0, orbitsCreated: 0 };
        }
        targetFile = pick.filePaths[0]!;
      }

      const res = await importJsonBackup(targetFile, {
        repo: deps.repo,
        pipeline: deps.pipeline,
        onOrbitsChanged: deps.onOrbitsChanged,
        broadcastUpsert: deps.broadcastUpsert,
      });
      if (res.importedCount > 0) {
        triggerSyncHint();
      }
      return res;
    }
  );

  // 7. Full Markdown + assets `.zip` export (excludes secrets & deleted items)
  register('integrations:export-markdown-zip', async (): Promise<ExportResult> => {
    const stamp = new Date().toISOString().slice(0, 10);
    const locale = getLocale();
    const pick = await showSaveDialog({
      title: translate(locale, 'main.dialog.exportZipTitle'),
      defaultPath: path.join(
        resolveDefaultDocumentsDir(deps.documentsDir),
        `kapsula-markdown-${stamp}.zip`
      ),
      filters: [{ name: translate(locale, 'main.dialog.exportZipFilter'), extensions: ['zip'] }],
    });
    if (pick.canceled || !pick.filePath) {
      return { ok: false };
    }

    return exportMarkdownZip(pick.filePath, {
      repo: deps.repo,
      pipeline: deps.pipeline,
    });
  });

  // 8. Cryptographic inbound email forwarding token rotation
  register(
    'integrations:rotate-email-token',
    async (): Promise<{ address: string; token: string }> => {
      const token = crypto.randomBytes(12).toString('base64url');
      const address = `in+${token}@mail.kapsula.app`;
      deps.repo.setSetting('email_inbound_token', token);
      deps.repo.setSetting('email_inbound_address', address);
      deps.onSettingsChanged?.();
      return { address, token };
    }
  );
}
