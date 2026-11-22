export type ContentDna = 'link' | 'secret' | 'shot' | 'snippet' | 'note' | 'voice' | 'doc';

export type ItemSubKind = 'contact' | 'post' | 'checklist' | 'video_ref' | null;

export type CaptureMode = 'autopilot' | 'buffer' | 'ghost' | 'focus';

export type AiProvider = 'local' | 'google_ai_studio' | 'openrouter';

export type SortOrderOption = 'created_desc' | 'updated_desc' | 'title_asc' | 'media_first';

export type ViewLayoutMode = 'grid' | 'list' | 'board';

export type ItemSource =
  | 'capsule_drop'
  | 'hud'
  | 'clipboard_snatch'
  | 'vault_ui'
  | 'telegram_saved'
  | 'telegram_bot'
  | 'browser_ext'
  | 'archive_import'
  | 'email_import'
  | 'markdown_import'
  | 'demo';

export type AiStatus = 'local' | 'pending' | 'enriched' | 'skipped_secret' | 'raw_buffer';

export interface ExtractedAction {
  type: 'url' | 'code' | 'phone' | 'email' | 'command' | 'date';
  label: string;
  value: string;
  description?: string;
}

export type SecretKind = 'password' | 'bank_card' | 'api_key' | 'seed' | 'note';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpCodeSnapshot {
  code: string;
  remainingSec: number;
  period: number;
}

export interface SecretMeta {
  service: string;
  loginHint: string;
  kind: SecretKind;
  cardBrand?: string;
  last4?: string;
  hasCvv?: boolean;
  expiry?: string;
  hasLogin?: boolean;
  hasTotp?: boolean;
  totpDigits?: 6 | 8;
  totpPeriod?: number;
}

export interface SecretCopyResult {
  ok: boolean;
  wipeSeconds: number;
  locked?: boolean;
}

export interface SecretPayload {
  service: string;
  login: string;
  secretValue: string;
  notes: string;
  cardHolder?: string;
  expiry?: string;
  cvv?: string;
  totpSecret?: string;
  totpIssuer?: string;
  totpAccount?: string;
  totpAlgorithm?: TotpAlgorithm;
  totpDigits?: 6 | 8;
  totpPeriod?: number;
}

export type TaskPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface TaskBoardColumn {
  id: string;
  title: string;
  color: string;
  order: number;
  isDone?: boolean;
  icon?: string;
}

export interface TaskBoardItemMeta {
  columnId: string;
  prevColumnId?: string;
  boardOrder: number;
  customOrder?: boolean;
  priority?: TaskPriority;
  dueAt?: number | null;
  textHash?: string;
}

export interface MediaMeta {
  transcript?: string;
  keyPoints?: string[];
  actionItems?: string[];
  checkedActionIndices?: number[];
  waveformPeaks?: number[];
  fileName?: string;
  fileSize?: number;
  pageCount?: number;
  forwardAuthor?: string;
  publishedAt?: string;
  galleryPaths?: string[];
  videoUrl?: string;
  ogIsLightBanner?: boolean;
  contactPhone?: string;
  contactHandle?: string;
  contactEmail?: string;
  contactRole?: string;
  inNotesHub?: boolean;
  taskMeta?: Record<string, TaskBoardItemMeta>;
}

export interface CanvasAnnotation {
  id: string;
  xPct: number;
  yPct: number;
  text: string;
  color?: string;
}

export interface StructuredSecretInput {
  id?: string;
  kind: SecretMeta['kind'];
  title?: string;
  service: string;
  login?: string;
  secretValue: string;
  notes?: string;
  cardHolder?: string;
  expiry?: string;
  cvv?: string;
  totpUriOrSecret?: string;
  totpAlgorithm?: TotpAlgorithm;
  totpDigits?: 6 | 8;
  totpPeriod?: number;
  orbit?: string;
  focusBoardId?: string | null;
  tags?: string[];
}

export interface VaultItem {
  id: string;
  dna: ContentDna;
  subKind: ItemSubKind;
  orbit: string;
  modeCaptured: CaptureMode;
  focusBoardId: string | null;
  title: string;
  body: string;
  summary: string;
  url: string | null;
  domain: string | null;
  platform: string | null;
  imagePath: string | null;
  thumbPath: string | null;
  mediaPath: string | null;
  mediaType: string | null;
  mediaDurationSec: number | null;
  mediaMeta: MediaMeta | null;
  ogImageUrl: string | null;
  ocrText: string;
  extractedActions: ExtractedAction[];
  colorPalette: string[];
  hasEncryptedPayload: boolean;
  secretMeta: SecretMeta | null;
  tags: string[];
  source: ItemSource;
  externalId: string | null;
  contentHash: string;
  aiStatus: AiStatus;
  aiConfidence: number | null;
  isPinned: boolean;
  isArchived: boolean;
  isDemo: boolean;
  remindAt: number | null;
  remindedAt: number | null;
  createdAt: number;
  updatedAt: number;
  contentUpdatedAt: number;
  deletedAt: number | null;
  purgedAt?: number | null;
  canvasX: number | null;
  canvasY: number | null;
  canvasW: number | null;
  canvasH: number | null;
  canvasFrame: string | null;
  annotations: CanvasAnnotation[];
  linksOut: string[];
  syncVersion?: number;
}

export interface OrbitDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  sortOrder: number;
  isBuiltin: boolean;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number | null;
  itemCount?: number;
}

export interface OrbitUpdateInput {
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  sortOrder?: number;
}

export interface FocusBoard {
  id: string;
  name: string;
  description?: string;
  icon: string;
  color: string;
  sortOrder?: number;
  isActive: boolean;
  createdAt: number;
  updatedAt?: number;
  deletedAt?: number | null;
  itemCount?: number;
}

export interface FocusBoardUpdateInput {
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  sortOrder?: number;
}

export interface BudgetSummary {
  monthKey: string;
  spentUsd: number;
  capUsd: number;
  callsCount: number;
  cacheHitsCount: number;
  provider: AiProvider;
  hasCloudKey: boolean;
  limitReached: boolean;
}

export interface ShortcutRegistrationStatus {
  hudRegistered: boolean;
  snatchRegistered: boolean;
  effectiveHudShortcut: string;
  effectiveSnatchShortcut: string;
  error?: string | null;
}

export type ThemeMode = 'dark' | 'light';

export type AppLocale = 'ru' | 'en';

export type AccentPresetId = 'terracotta' | 'cobalt' | 'emerald' | 'violet' | 'amber' | 'rose';

export type BackgroundPresetId =
  | 'obsidian'
  | 'midnight'
  | 'espresso'
  | 'pine'
  | 'graphite'
  | 'oled'
  | 'porcelain'
  | 'paper'
  | 'ice'
  | 'sage'
  | 'sand'
  | 'custom';

export interface AppearanceConfig {
  accentMode: 'preset' | 'custom';
  accentPreset: AccentPresetId;
  accentHex: string;
  bgPreset: BackgroundPresetId;
  bgHue: number;
  bgTint: number;
  bgLightness: number;
  density: 'comfortable' | 'compact';
}

export interface SettingsState {
  theme: ThemeMode;
  locale?: AppLocale;
  activeMode: CaptureMode;
  activeFocusBoardId: string | null;
  aiProvider: AiProvider;
  monthlyCapUsd: number;
  enableAutoOcr: boolean;
  enableUrlUnfurl: boolean;
  clipboardAutoWipeSeconds: number;
  hasOpenRouterKey: boolean;
  hasGoogleAiKey: boolean;
  hasMasterPin: boolean;
  vaultUnlocked: boolean;
  clipperPort: number;
  clipperToken: string;
  viewLayout: ViewLayoutMode;
  launchAtLogin: boolean;
  soundTickEnabled: boolean;
  hudShortcut: string;
  snatchShortcut: string;
  shortcutStatus?: ShortcutRegistrationStatus;
  googleCalendarConnected?: boolean;
  googleCalendarEmail?: string | null;
  googleCalendarClientId?: string;
  googleCalendarIcalUrl?: string;
  googleCalendarLastSyncAt?: number | null;
  vaultAutoLockMinutes?: number;
  lockVaultOnMinimize?: boolean;
  lockVaultOnHudClose?: boolean;
  enableScreenProtection?: boolean;
  biometricUnlockAvailable?: boolean;
  biometricUnlockEnabled?: boolean;
  pinLockoutRemainingSec?: number;
  appearance?: AppearanceConfig;
  taskBoardColumns?: TaskBoardColumn[];
  showBoardColumnIcons?: boolean;
  onboarded?: boolean;
  emailInboundAddress?: string;
  emailInboundToken?: string;
  emailInboundWebhookUrl?: string;
  planTier?: 'free' | 'pro';
}

export interface CaptureInput {
  text?: string;
  url?: string;
  title?: string;
  imageBase64?: string;
  imageBytes?: Uint8Array;
  imageFilePath?: string;
  audioBase64?: string;
  audioBytes?: Uint8Array;
  audioMime?: string;
  audioDurationSec?: number;
  skipAudioAi?: boolean;
  videoPath?: string;
  videoBase64?: string;
  videoBytes?: Uint8Array;
  videoMime?: string;
  videoDurationSec?: number;
  filePath?: string;
  fileBase64?: string;
  fileBytes?: Uint8Array;
  fileName?: string;
  fileMime?: string;
  subKind?: ItemSubKind;
  mediaMeta?: MediaMeta;
  remindAt?: number | null;
  skipAutoCalendar?: boolean;
  calendarEventOverride?: Partial<CalendarEventInput>;
  mode?: CaptureMode;
  orbitOverride?: string;
  focusBoardId?: string | null;
  source?: ItemSource;
  externalId?: string | null;
  forceSecret?: boolean;
  secretOverride?: Partial<SecretPayload>;
  tags?: string[];
  platform?: string | null;
  createdAt?: number;
  isDemo?: boolean;
}

export interface VaultQuery {
  search?: string;
  orbit?: string | null;
  dna?: ContentDna | null;
  focusBoardId?: string | null;
  tag?: string | null;
  isPinned?: boolean;
  remindersDueOnly?: boolean;
  unassignedOnly?: boolean;
  archivedOnly?: boolean;
  includeArchived?: boolean;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  includePurged?: boolean;
  includeSecrets?: boolean;
  sortBy?: SortOrderOption;
  createdBefore?: number;
  limit?: number;
  offset?: number;
}

export interface AskVaultCitation {
  id: string;
  title: string;
  dna: ContentDna;
  orbit: string;
  summary?: string;
  domain?: string | null;
  url?: string | null;
  thumbPath?: string | null;
  imagePath?: string | null;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  citations?: AskVaultCitation[];
}

export interface AskVaultResult {
  answer: string;
  citations: AskVaultCitation[];
  usedProvider: AiProvider;
  costUsd: number;
}

export interface VaultInventorySummary {
  totalItems: number;
  unassignedCount: number;
  byDna: Record<ContentDna, number>;
  byOrbit: Array<{ id: string; name: string; count: number }>;
  vaultLocked?: boolean;
  bankCardCount: number;
  bankCards: Array<{ id: string; title: string; brand?: string; last4?: string; orbit: string }>;
  passwordCount: number;
  apiKeyCount: number;
  secretServices: Array<{ id: string; title: string; kind: SecretMeta['kind']; orbit: string }>;
  dueReminderCount: number;
  dueReminders?: Array<{ id: string; title: string; dna: ContentDna; orbit: string; remindAt: number }>;
}

export interface ArchiveImportResult {
  format: 'instagram_json' | 'telegram_json' | 'telegram_html' | 'unknown';
  imported: number;
  skippedDuplicates: number;
  errors: number;
}

export type TextTransformPreset = 'structure' | 'tasks' | 'polish' | 'summary';

export interface TextTransformInput {
  itemId?: string;
  text: string;
  preset?: TextTransformPreset;
  presets?: TextTransformPreset[];
}

export type TextTransformFallbackReason =
  | 'no_ai_key'
  | 'budget_limit'
  | 'secret_detected'
  | 'cloud_error';

export interface TextTransformResult {
  titleSuggestion?: string;
  formattedText: string;
  extractedTasks: string[];
  summary?: string;
  usedCloud: boolean;
  changed?: boolean;
  preRevisionId?: string | null;
  fallbackReason?: TextTransformFallbackReason | null;
}

export type ItemRevisionSource =
  | 'manual'
  | 'auto'
  | 'beautify'
  | 'dictate'
  | 'voice'
  | 'restore'
  | 'sync_conflict';

export interface ItemRevision {
  id: string;
  itemId: string;
  title: string | null;
  content: string;
  source: ItemRevisionSource;
  contentHash?: string | null;
  deviceName?: string | null;
  createdAt: number;
  updatedAt?: number;
  deletedAt?: number | null;
  syncVersion?: number;
}

export interface VoiceDictationInput {
  audioBase64: string;
  mime: string;
  durationSec?: number;
  mode?: 'smart' | 'raw';
  itemId?: string;
  peaks?: number[];
  saveAsNewItem?: boolean;
  orbitOverride?: string;
  focusBoardId?: string | null;
}

export interface VoiceDictationResult {
  transcript: string;
  formattedText: string;
  titleSuggestion?: string;
  keyPoints: string[];
  actionItems: string[];
  durationSec: number;
  usedCloud: boolean;
  audioPath?: string;
  audioMime?: string;
  savedItem?: VaultItem;
}

export interface VaultTaskEntry {
  id: string;
  itemId: string;
  itemTitle: string;
  sourceType: 'markdown' | 'voice_action';
  taskIndex: number;
  text: string;
  done: boolean;
  orbit: string | null;
  remindAt: number | null;
  updatedAt: number;
  taskKey?: string;
  columnId?: string;
  boardOrder?: number;
  customOrder?: boolean;
  priority?: TaskPriority;
  dueAt?: number | null;
}

export type SynthesizeMode = 'spec' | 'tasks' | 'table';

export interface SynthesizeNotesInput {
  itemIds: string[];
  mode: SynthesizeMode;
  instruction?: string;
  orbit?: string;
  focusBoardId?: string | null;
  archiveSources?: boolean;
}

export interface SynthesizeNotesResult {
  title: string;
  body: string;
  summary: string;
  tags: string[];
  orbit: string;
  usedCloud: boolean;
  preservedDetailsCount: number;
}

export interface TriageSuggestion {
  itemId: string;
  itemTitle: string;
  currentOrbit: string;
  targetOrbit: string | null;
  targetOrbitName: string | null;
  targetBoardId: string | null;
  targetBoardName: string | null;
  suggestedTags: string[];
  archive: boolean;
  reason: string;
  confidence: number;
}

export interface TriageNewOrbitProposal {
  name: string;
  description: string;
  color: string;
  icon: string;
  itemIds: string[];
}

export interface TriageMergeProposal {
  title: string;
  itemIds: string[];
  reason: string;
}

export interface TriagePreviewResult {
  configured: boolean;
  usedCloud: boolean;
  message?: string;
  remainingCount?: number;
  suggestions: TriageSuggestion[];
  newOrbits: TriageNewOrbitProposal[];
  mergeGroups: TriageMergeProposal[];
}

export interface TriageApplyInput {
  moves: Array<{
    itemId: string;
    orbit?: string;
    focusBoardId?: string | null;
    tags?: string[];
    archive?: boolean;
  }>;
  createOrbits: TriageNewOrbitProposal[];
}

export type SecretCopyField = 'secretValue' | 'login' | 'cvv' | 'expiry' | 'notes' | 'totp';

export type CalendarEventKind = 'event' | 'task' | 'reminder';

export type CalendarRecurrence = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface CalendarChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface ParsedRussianEvent {
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  hasEndTime: boolean;
  durationMin: number;
  location: string;
  notes: string;
  label: string;
  isEventIntent: boolean;
}

export interface CalendarEvent {
  id: string;
  title: string;
  notes: string;
  location: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  hasEndTime: boolean;
  color: string;
  kind: CalendarEventKind;
  recurrence?: CalendarRecurrence;
  isDone: boolean;
  linkedItemId: string | null;
  checklist: CalendarChecklistItem[];
  attachments: string[];
  externalSource: string | null;
  externalId: string | null;
  etag: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncVersion?: number;
}

export interface CalendarEventInput {
  id?: string;
  title: string;
  notes?: string;
  location?: string;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  hasEndTime?: boolean;
  color?: string;
  kind?: CalendarEventKind;
  recurrence?: CalendarRecurrence;
  isDone?: boolean;
  linkedItemId?: string | null;
  checklist?: CalendarChecklistItem[];
  attachments?: string[];
  externalSource?: string | null;
  externalId?: string | null;
  etag?: string | null;
}

export interface CalendarSyncStatus {
  connected: boolean;
  email: string | null;
  clientId: string;
  icalUrl: string;
  lastSyncAt: number | null;
  error: string | null;
  hasCredentials: boolean;
  builtInOAuthAvailable?: boolean;
  authMode?: 'proxy' | 'custom' | 'ical' | null;
}

export interface CloudAiQuotaStatus {
  available: boolean;
  signedIn: boolean;
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number;
  requestCount: number;
  blocked: boolean;
  globalExhausted: boolean;
  usingPersonalKey: boolean;
  personalProvider?: 'google_ai_studio' | 'openrouter' | null;
  providers?: { google: boolean; openrouter: boolean };
  month?: string;
  error?: string | null;
}

export type UpdaterStatusKind =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

export interface AppUpdaterState {
  status: UpdaterStatusKind;
  currentVersion: string;
  latestVersion?: string | null;
  releaseNotes?: string | null;
  downloadUrl?: string | null;
  percent?: number | null;
  error?: string | null;
  mode: 'auto' | 'manual-download';
  checkedAt?: number | null;
  dismissedVersion?: string | null;
}

export interface SaveNoteImageResult {
  filename: string;
  mediaUrl: string;
  thumbFilename?: string;
}

export interface TranscribeItemResult {
  ok: boolean;
  item?: VaultItem;
  transcript?: string;
  extractedTasks?: string[];
  error?: string;
}

export interface ImportResult {
  importedCount: number;
  skippedCount: number;
  orbitsCreated: number;
  errors?: string[];
}

export interface ExportResult {
  ok: boolean;
  filePath?: string;
  count?: number;
  error?: string;
}

export interface ParsedEmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  data?: Uint8Array;
}

export interface ParsedEmailSummary {
  subject: string;
  from: string;
  fromName?: string;
  fromAddress?: string;
  to?: string;
  date?: number | null;
  messageId?: string | null;
  bodyText: string;
  bodyMarkdown: string;
  attachments: ParsedEmailAttachment[];
}
