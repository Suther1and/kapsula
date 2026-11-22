// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { SecretStudioSheet } from '@renderer/components/studio/SecretStudioSheet';
import { NewSecretModal } from '@renderer/components/modals/NewSecretModal';
import {
  installJsdomPolyfills,
  installMockKapsulaApi,
  makeOrbit,
  makeSecretItem,
  renderWithI18n,
} from './helpers/ui-test-harness';

describe('Wave 0 UI Safety: SecretStudioSheet & NewSecretModal', () => {
  beforeAll(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('SecretStudioSheet', () => {
    it('reveals unlocked secret, edits notes, and submits populated secretValue', async () => {
      const secret = makeSecretItem({
        id: 'sec-1',
        title: 'GitHub',
        secretMeta: {
          kind: 'password',
          service: 'GitHub',
          loginHint: 'd***@kapsula.app',
          hasLogin: true,
          hasTotp: false,
        },
      });
      const updatedSecret = makeSecretItem({ id: 'sec-1', title: 'GitHub Updated' });

      const { api } = installMockKapsulaApi({
        revealSecret: vi.fn(async () => ({
          service: 'GitHub',
          login: 'dev@kapsula.app',
          secretValue: 'ghp_existing_secret_1234',
          notes: 'Старая заметка',
        })),
        saveStructuredSecret: vi.fn(async () => updatedSecret),
      });

      const onUpdated = vi.fn();
      renderWithI18n(
        <SecretStudioSheet
          item={secret}
          orbits={[makeOrbit()]}
          vaultLocked={false}
          wipeSeconds={30}
          onUnlockRequest={vi.fn()}
          onUpdated={onUpdated}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(api.revealSecret).toHaveBeenCalledWith('sec-1');
        expect(screen.getByText('dev@kapsula.app')).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId('secret-edit-mode-btn'));
      const notesInput = await screen.findByTestId('secret-edit-notes-input');
      fireEvent.change(notesInput, { target: { value: 'Обновлённый комментарий' } });

      fireEvent.submit(screen.getByTestId('secret-edit-mode'));

      await waitFor(() => {
        expect(api.saveStructuredSecret).toHaveBeenCalledTimes(1);
      });
      expect(api.saveStructuredSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sec-1',
          secretValue: 'ghp_existing_secret_1234',
          notes: 'Обновлённый комментарий',
        })
      );
      expect(onUpdated).toHaveBeenCalledWith(updatedSecret);
    });

    it('blocks revealSecret when vaultLocked=true and triggers onUnlockRequest', () => {
      const secret = makeSecretItem({ id: 'sec-locked' });
      const { api } = installMockKapsulaApi();
      const onUnlockRequest = vi.fn();

      renderWithI18n(
        <SecretStudioSheet
          item={secret}
          orbits={[makeOrbit()]}
          vaultLocked={true}
          wipeSeconds={30}
          onUnlockRequest={onUnlockRequest}
          onUpdated={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(api.revealSecret).not.toHaveBeenCalled();
      const unlockBtn = screen.getByRole('button', { name: 'Ввести мастер-код' });
      fireEvent.click(unlockBtn);
      expect(onUnlockRequest).toHaveBeenCalledTimes(1);
    });

    it(
      '[Wave 2: BUG-02] keeps Save disabled (or blocks edit mode) when revealSecret rejects so blank secretValue cannot overwrite stored secret',
      async () => {
        const secret = makeSecretItem({ id: 'sec-fail' });
        const { api } = installMockKapsulaApi({
          revealSecret: vi.fn(async () => {
            throw new Error('Vault locked or corrupt ciphertext');
          }),
        });

        renderWithI18n(
          <SecretStudioSheet
            item={secret}
            orbits={[makeOrbit()]}
            vaultLocked={false}
            wipeSeconds={30}
            onUnlockRequest={vi.fn()}
            onUpdated={vi.fn()}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );

        await waitFor(() => {
          expect(api.revealSecret).toHaveBeenCalledWith('sec-fail');
          expect(screen.queryByText(/Расшифровываем/i)).toBeNull();
        });

        const editBtn = screen.queryByTestId('secret-edit-mode-btn') as HTMLButtonElement | null;
        if (editBtn && !editBtn.disabled) {
          fireEvent.click(editBtn);
        }

        // Allow AnimatePresence mode="wait" (150ms) to finish swapping view -> edit form if edit mode opened
        await new Promise((r) => setTimeout(r, 220));

        const editForm = screen.queryByTestId('secret-edit-mode');
        if (editForm) {
          await waitFor(() => {
            expect(screen.queryByText('Расшифровываем поля…')).toBeNull();
          });
          const saveBtn = screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement;
          fireEvent.submit(editForm);
          await new Promise((r) => setTimeout(r, 20));
          expect(saveBtn.disabled).toBe(true);
          expect(api.saveStructuredSecret).not.toHaveBeenCalled();
        }
        expect(api.saveStructuredSecret).not.toHaveBeenCalled();
      }
    );

    it(
      '[Wave 2: BUG-02] keeps Save disabled when revealSecret resolves null',
      async () => {
        const secret = makeSecretItem({ id: 'sec-null' });
        const { api } = installMockKapsulaApi({
          revealSecret: vi.fn(async () => null),
        });

        renderWithI18n(
          <SecretStudioSheet
            item={secret}
            orbits={[makeOrbit()]}
            vaultLocked={false}
            wipeSeconds={30}
            onUnlockRequest={vi.fn()}
            onUpdated={vi.fn()}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );

        await waitFor(() => {
          expect(api.revealSecret).toHaveBeenCalledWith('sec-null');
          expect(screen.queryByText(/Расшифровываем/i)).toBeNull();
        });

        const editBtn = screen.queryByTestId('secret-edit-mode-btn') as HTMLButtonElement | null;
        if (editBtn && !editBtn.disabled) {
          fireEvent.click(editBtn);
        }

        await new Promise((r) => setTimeout(r, 220));

        const editForm = screen.queryByTestId('secret-edit-mode');
        if (editForm) {
          await waitFor(() => {
            expect(screen.queryByText('Расшифровываем поля…')).toBeNull();
          });
          const saveBtn = screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement;
          fireEvent.submit(editForm);
          await new Promise((r) => setTimeout(r, 20));
          expect(saveBtn.disabled).toBe(true);
          expect(api.saveStructuredSecret).not.toHaveBeenCalled();
        }
        expect(api.saveStructuredSecret).not.toHaveBeenCalled();
      }
    );
  });

  describe('NewSecretModal', () => {
    it('creates a password secret and resets fields after successful save', async () => {
      const createdItem = makeSecretItem({ id: 'sec-created', title: 'Linear' });
      const { api } = installMockKapsulaApi({
        saveStructuredSecret: vi.fn(async () => createdItem),
      });
      const onCreated = vi.fn();
      const onOpenChange = vi.fn();

      renderWithI18n(
        <NewSecretModal
          open={true}
          initialKind="password"
          onOpenChange={onOpenChange}
          onCreated={onCreated}
        />
      );

      fireEvent.change(screen.getByTestId('secret-title-input'), { target: { value: 'Linear' } });
      fireEvent.change(screen.getByTestId('secret-login-input'), {
        target: { value: 'alice@kapsula.app' },
      });
      fireEvent.change(screen.getByTestId('secret-value-input'), {
        target: { value: 'correct-horse-battery-staple' },
      });

      fireEvent.submit(screen.getByTestId('new-secret-form'));

      await waitFor(() => {
        expect(api.saveStructuredSecret).toHaveBeenCalledTimes(1);
      });
      expect(api.saveStructuredSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'password',
          title: 'Linear',
          login: 'alice@kapsula.app',
          secretValue: 'correct-horse-battery-staple',
        })
      );
      expect(onCreated).toHaveBeenCalledWith(createdItem);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('rejects short bank card PAN and blank password without calling IPC', async () => {
      const { api } = installMockKapsulaApi();
      const onOpenChange = vi.fn();

      const { rerender } = renderWithI18n(
        <NewSecretModal
          open={true}
          initialKind="bank_card"
          onOpenChange={onOpenChange}
          onCreated={vi.fn()}
        />
      );

      fireEvent.change(screen.getByTestId('secret-pan-input'), { target: { value: '42421234' } });
      fireEvent.submit(screen.getByTestId('new-secret-form'));
      expect(api.saveStructuredSecret).not.toHaveBeenCalled();

      rerender(
        <NewSecretModal
          open={false}
          initialKind="password"
          onOpenChange={onOpenChange}
          onCreated={vi.fn()}
        />
      );
      rerender(
        <NewSecretModal
          open={true}
          initialKind="password"
          onOpenChange={onOpenChange}
          onCreated={vi.fn()}
        />
      );

      fireEvent.submit(screen.getByTestId('new-secret-form'));
      expect(api.saveStructuredSecret).not.toHaveBeenCalled();
    });

    it(
      '[Wave 2: BUG-10] scrubs sensitive PAN, CVV, and secretValue from state when modal is closed and reopened',
      async () => {
        installMockKapsulaApi();

        const { rerender } = renderWithI18n(
          <NewSecretModal
            open={true}
            initialKind="bank_card"
            onOpenChange={vi.fn()}
            onCreated={vi.fn()}
          />
        );

        const panInput = screen.getByTestId('secret-pan-input') as HTMLInputElement;
        const cvvInput = screen.getByTestId('secret-cvv-input') as HTMLInputElement;
        fireEvent.change(panInput, { target: { value: '2200700712345676' } });
        fireEvent.change(cvvInput, { target: { value: '987' } });
        expect(panInput.value).toContain('2200');
        expect(cvvInput.value).toBe('987');

        // Close modal without saving
        rerender(
          <NewSecretModal
            open={false}
            initialKind="bank_card"
            onOpenChange={vi.fn()}
            onCreated={vi.fn()}
          />
        );

        // Reopen modal
        rerender(
          <NewSecretModal
            open={true}
            initialKind="bank_card"
            onOpenChange={vi.fn()}
            onCreated={vi.fn()}
          />
        );

        const reopenedPan = screen.getByTestId('secret-pan-input') as HTMLInputElement;
        const reopenedCvv = screen.getByTestId('secret-cvv-input') as HTMLInputElement;
        expect(reopenedPan.value).toBe('');
        expect(reopenedCvv.value).toBe('');
      }
    );

    it(
      '[Wave 2: BUG-10] does not force generic title "Банковская карта" when bank card title is left blank',
      async () => {
        const { api } = installMockKapsulaApi();

        renderWithI18n(
          <NewSecretModal
            open={true}
            initialKind="bank_card"
            onOpenChange={vi.fn()}
            onCreated={vi.fn()}
          />
        );

        fireEvent.change(screen.getByTestId('secret-pan-input'), {
          target: { value: '4276123456789012' },
        });
        fireEvent.submit(screen.getByTestId('new-secret-form'));

        await waitFor(() => {
          expect(api.saveStructuredSecret).toHaveBeenCalledTimes(1);
        });

        const payload = (api.saveStructuredSecret as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
        expect(payload.title || '').not.toBe('Банковская карта');
      }
    );
  });
});
