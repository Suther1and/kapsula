export const DRAFT_NOTE_ID = '__kapsula_new_draft__';

export interface NoteDraftBuffer {
  title: string;
  body: string;
  rev: number;
}

export interface MaterializeDraftInput {
  title: string;
  body: string;
  orbit: string;
  focusBoardId: string | null;
  isPinned: boolean;
  tags: string[];
  remindAt: number | null;
}

export type QuickCaptureTab = 'text' | 'voice' | 'photo' | 'file';
