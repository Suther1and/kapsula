import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRepository } from '@main/db/repository';
import { reconcileTaskMeta } from '@shared/task-helpers';
import type { TaskBoardColumn, TaskBoardItemMeta } from '@shared/types';

const repos: VaultRepository[] = [];
const tempDirs: string[] = [];

function createTestRepo(): VaultRepository {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-tasks-v10-'));
  tempDirs.push(dir);
  const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
  repos.push(repo);
  return repo;
}

afterEach(() => {
  while (repos.length > 0) {
    try {
      repos.pop()!.close();
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('Wave 6: Tasks V10 Lifecycle & Standalone Task CRUD', () => {
  it('creates standalone tasks with notes, priority, dueAt, orbit & focusBoardId and lists them accurately', () => {
    const repo = createTestRepo();
    const orbit = repo.createOrbit({ name: 'Разработка', description: 'Задачи по проекту' });
    const board = repo.createFocusBoard('Спринт');
    const dueAt = Date.UTC(2026, 10, 30, 14, 30, 0);

    const created = repo.createStandaloneTask({
      text: 'Подготовить подробный план релиза приложения без лишних багов и просадок по производительности на всех экранах',
      orbit: orbit.id,
      focusBoardId: board.id,
      columnId: 'in_progress',
      priority: 'high',
      dueAt,
      notes: 'Проверить все тесты и иконку exe',
    });

    expect(created).toBeTruthy();
    expect(created!.modeCaptured).toBe('buffer');
    expect(created!.orbit).toBe(orbit.id);
    expect(created!.focusBoardId).toBe(board.id);
    expect(created!.remindAt).toBe(dueAt);
    expect(created!.mediaMeta?.isStandaloneTask).toBe(true);

    const listed = repo.listVaultTasks();
    const task = listed.find((t) => t.itemId === created!.id);
    expect(task).toBeTruthy();
    expect(task!.done).toBe(false);
    expect(task!.columnId).toBe('in_progress');
    expect(task!.priority).toBe('high');
    expect(task!.dueAt).toBe(dueAt);
    expect(task!.orbit).toBe(orbit.id);
    expect(task!.focusBoardId).toBe(board.id);
    expect(task!.notes).toBe('Проверить все тесты и иконку exe');
    expect(task!.isStandaloneTask).toBe(true);
  });

  it('updates task metadata (orbit, focusBoardId, notes, dueAt <-> remindAt) cleanly', () => {
    const repo = createTestRepo();
    const orbitA = repo.createOrbit({ name: 'Дом', description: '' });
    const orbitB = repo.createOrbit({ name: 'Работа', description: '' });
    const boardB = repo.createFocusBoard('Квартал');

    const created = repo.createStandaloneTask({
      text: 'Согласовать макет',
      orbit: orbitA.id,
      priority: 'low',
    });
    expect(created).toBeTruthy();

    const firstList = repo.listVaultTasks();
    const task = firstList.find((t) => t.itemId === created!.id)!;
    const dueNext = Date.UTC(2026, 11, 2, 11, 0, 0);

    const updatedItem = repo.updateTaskMeta({
      itemId: task.itemId,
      taskKey: task.taskKey!,
      orbit: orbitB.id,
      focusBoardId: boardB.id,
      priority: 'high',
      dueAt: dueNext,
      notes: 'Уточнить отступы в списке',
    });

    expect(updatedItem).toBeTruthy();
    expect(updatedItem!.orbit).toBe(orbitB.id);
    expect(updatedItem!.focusBoardId).toBe(boardB.id);
    expect(updatedItem!.remindAt).toBe(dueNext);

    const refreshed = repo.listVaultTasks().find((t) => t.itemId === created!.id)!;
    expect(refreshed.priority).toBe('high');
    expect(refreshed.notes).toBe('Уточнить отступы в списке');
    expect(refreshed.dueAt).toBe(dueNext);

    // Clearing dueAt should also clear synced standalone remindAt
    const clearedItem = repo.updateTaskMeta({
      itemId: task.itemId,
      taskKey: task.taskKey!,
      dueAt: null,
      notes: '',
    });
    expect(clearedItem!.remindAt).toBeNull();
    const afterClear = repo.listVaultTasks().find((t) => t.itemId === created!.id)!;
    expect(afterClear.dueAt).toBeNull();
    expect(afterClear.notes).toBeUndefined();
  });

  it('deletes >72-char standalone task item without leaving orphan notes while preserving multi-meta regular notes', () => {
    const repo = createTestRepo();
    const longStandaloneText =
      'Длинная самостоятельная задача длиннее семидесяти двух символов для проверки полной очистки карточки после удаления задачи из списка';
    const standalone = repo.createStandaloneTask({ text: longStandaloneText })!;
    const standaloneTask = repo.listVaultTasks().find((t) => t.itemId === standalone.id)!;

    const delRes = repo.deleteVaultTask({
      itemId: standalone.id,
      taskKey: standaloneTask.taskKey!,
    });
    expect(delRes?.deletedItemId).toBe(standalone.id);
    expect(repo.getItemById(standalone.id)).toBeNull();

    // Regular note with tags / custom title must be preserved after removing its only checklist task
    const regularNote = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Проектные заметки',
      body: '- [ ] Разовая задача из заметки',
      tags: ['проект'],
      source: 'vault_ui',
      contentHash: 'regular-note-hash',
    });
    const noteTask = repo.listVaultTasks().find((t) => t.itemId === regularNote.id)!;
    const noteDelRes = repo.deleteVaultTask({
      itemId: regularNote.id,
      taskKey: noteTask.taskKey!,
    });
    expect(noteDelRes?.deletedItemId).toBeUndefined();
    const keptItem = repo.getItemById(regularNote.id);
    expect(keptItem).toBeTruthy();
    expect(keptItem!.tags).toEqual(['проект']);
  });

  it('preserves task notes inside reconcileTaskMeta when task lines shift or rename', () => {
    const columns: TaskBoardColumn[] = [
      { id: 'inbox', title: 'Входящие', color: '#94A3B8', order: 0 },
      { id: 'done', title: 'Готово', color: '#2EA06B', order: 1, isDone: true },
    ];
    const existingMeta: Record<string, TaskBoardItemMeta> = {
      'md:0': {
        columnId: 'inbox',
        boardOrder: 1000,
        priority: 'medium',
        dueAt: null,
        notes: 'Важный комментарий к задаче',
      },
    };
    const reconciled = reconcileTaskMeta(
      [
        {
          taskKey: 'md:0',
          text: 'Подготовить план',
          done: false,
          textHash: 'abc123',
        },
      ],
      existingMeta,
      columns
    );
    expect(reconciled['md:0']?.notes).toBe('Важный комментарий к задаче');
    expect(reconciled['md:0']?.priority).toBe('medium');
  });

  it('clears/replaces stale AI shot summary on manual body edit in VaultRepository', () => {
    const repo = createTestRepo();
    const shot = repo.createItem({
      dna: 'shot',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Скриншот UI',
      summary: 'Старое AI-описание интерфейса',
      body: 'Исходный текст',
      source: 'vault_ui',
      contentHash: 'shot-hash-1',
    });

    const edited = repo.updateItem(shot.id, { body: 'Ручная правка пользователя' });
    expect(edited?.summary).toBe('Ручная правка пользователя');

    const cleared = repo.updateItem(shot.id, { body: '' });
    expect(cleared?.summary).toBe('');
  });
});
