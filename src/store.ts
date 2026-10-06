import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type FieldType = 'text' | 'number' | 'select' | 'date';
export interface FormField { id: string; label: string; type: FieldType; required: boolean; options?: string[]; }
export interface LinkRule { id: string; fieldId: string; operator: 'equals' | 'notEmpty'; value: string; effect: 'show' | 'require'; targetId: string; }
export interface FormVersion { id: string; label: string; createdAt: string; fields: FormField[]; rules: LinkRule[]; }
export interface Snapshot { id: string; versionId: string; label: string; data: Record<string, string>; }

export type MigrationItemStatus = 'pending' | 'queued' | 'succeeded' | 'failed' | 'voided';
export type MigrationBatchStatus = 'open' | 'completed' | 'voided';

export interface MigrationItem {
  id: string;
  batchId: string;
  snapshotId: string;
  fromVersionId: string;
  toVersionId: string;
  status: MigrationItemStatus;
  /** 按当前版本规则校验出的必填/联动错误 */
  errors: string[];
  attempts: number;
  /** 模拟写入失败，用于演示断点续作 */
  failInjected: boolean;
  /** 断点位置：validate | write | done */
  checkpoint: string;
  migratedData?: Record<string, string>;
  migratedAt?: string;
  lastError?: string;
}

export interface MigrationBatch {
  id: string;
  versionId: string;
  index: number;
  capacity: number;
  status: MigrationBatchStatus;
  createdAt: string;
}

/** 迁移账分录：一经写入不可变，按完成时的版本解释 */
export interface LedgerEntry {
  id: string;
  itemId: string;
  batchId: string;
  snapshotId: string;
  fromVersionId: string;
  toVersionId: string;
  data: Record<string, string>;
  completedAt: string;
}

interface SchemaState {
  versions: FormVersion[];
  rules: LinkRule[];
  activeVersionId: string;
  previewVersionId: string;
  snapshots: Snapshot[];
  migrationBatches: MigrationBatch[];
  migrationItems: MigrationItem[];
  ledger: LedgerEntry[];
}
type RootShape = { schema: SchemaState };

export const BATCH_CAPACITY = 3;

/** 版本生效规则 = 版本自身规则 + 历史全局规则（去重） */
function effectiveRules(version: FormVersion, globalRules: LinkRule[]): LinkRule[] {
  const map = new Map<string, LinkRule>();
  for (const rule of version.rules) map.set(rule.id, rule);
  for (const rule of globalRules) map.set(rule.id, rule);
  return [...map.values()];
}

/** 按目标版本的当前规则校验旧快照：必填字段 + 联动必填 */
export function validateSnapshot(snapshot: Snapshot, version: FormVersion, globalRules: LinkRule[]): string[] {
  const errors: string[] = [];
  for (const field of version.fields) {
    if (field.required && !snapshot.data[field.id]) {
      errors.push(`缺少必填字段「${field.label}」`);
    }
  }
  for (const rule of effectiveRules(version, globalRules)) {
    if (rule.effect !== 'require') continue;
    const sourceValue = snapshot.data[rule.fieldId];
    const matched = rule.operator === 'notEmpty' ? Boolean(sourceValue) : sourceValue === rule.value;
    if (!matched || snapshot.data[rule.targetId]) continue;
    const source = version.fields.find((field) => field.id === rule.fieldId);
    const target = version.fields.find((field) => field.id === rule.targetId);
    const cond = rule.operator === 'equals' ? `等于「${rule.value}」` : '非空';
    errors.push(`联动未满足：${source?.label ?? rule.fieldId}${cond} 时必填「${target?.label ?? rule.targetId}」`);
  }
  return errors;
}

/** 发布时生成待迁批次：按容量分批，按当前规则校验，已完成的快照不再重算 */
function buildMigration(
  version: FormVersion,
  snapshots: Snapshot[],
  globalRules: LinkRule[],
  ledger: LedgerEntry[]
): { batches: MigrationBatch[]; items: MigrationItem[] } {
  const batches: MigrationBatch[] = [];
  const items: MigrationItem[] = [];
  const doneSnapshotIds = new Set(ledger.map((entry) => entry.snapshotId));
  const pendingSnapshots = snapshots.filter((snapshot) => !doneSnapshotIds.has(snapshot.id));
  const now = new Date().toISOString();

  for (let i = 0; i < pendingSnapshots.length; i += BATCH_CAPACITY) {
    const batchIndex = batches.length + 1;
    const batchId = `mb-${version.id}-${batchIndex}-${Date.now()}`;
    batches.push({ id: batchId, versionId: version.id, index: batchIndex, capacity: BATCH_CAPACITY, status: 'open', createdAt: now });
    pendingSnapshots.slice(i, i + BATCH_CAPACITY).forEach((snapshot, idx) => {
      items.push({
        id: `mi-${snapshot.id}-${version.id}-${Date.now()}-${idx}`,
        batchId,
        snapshotId: snapshot.id,
        fromVersionId: snapshot.versionId,
        toVersionId: version.id,
        status: batchIndex === 1 ? 'pending' : 'queued',
        errors: validateSnapshot(snapshot, version, globalRules),
        attempts: 0,
        failInjected: false,
        checkpoint: 'pending'
      });
    });
  }
  return { batches, items };
}

const initial: SchemaState = {
  activeVersionId: 'v2',
  previewVersionId: 'v2',
  versions: [
    {
      id: 'v1', label: '费用申请 v1', createdAt: '2026-08-12',
      fields: [
        { id: 'name', label: '申请名称', type: 'text', required: true },
        { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
        { id: 'amount', label: '申请金额', type: 'number', required: true }
      ], rules: []
    },
    {
      id: 'v2', label: '费用申请 v2', createdAt: '2026-09-28',
      fields: [
        { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
        { id: 'name', label: '申请名称', type: 'text', required: true },
        { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
        { id: 'amount', label: '申请金额', type: 'number', required: true },
        { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
      ],
      rules: [
        { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
        { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' }
      ]
    }
  ],
  rules: [],
  snapshots: [
    { id: 's1', versionId: 'v1', label: '八月培训预算', data: { name: '培训预算', department: '财务', amount: '12000' } },
    { id: 's2', versionId: 'v1', label: '市场活动费用', data: { name: '新品活动', department: '市场', amount: '58000' } }
  ],
  migrationBatches: [],
  migrationItems: [],
  ledger: []
};

// 初始版本 v2 已发布，为其生成待迁批次
const initialMigration = buildMigration(
  initial.versions.find((version) => version.id === 'v2')!,
  initial.snapshots,
  initial.rules,
  initial.ledger
);
initial.migrationBatches = initialMigration.batches;
initial.migrationItems = initialMigration.items;

const slice = createSlice({
  name: 'schema',
  initialState: initial,
  reducers: {
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const from = version.fields.findIndex((item) => item.id === action.payload.activeId);
      const to = version.fields.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = version.fields.splice(from, 1); version.fields.splice(to, 0, moved);
    },
    addField(state) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const id = `field-${Date.now()}`;
      version.fields.push({ id, label: '新字段', type: 'text', required: false });
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      // 规则写入当前预览版本，随发布版本一起冻结
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      version.rules.push({ ...action.payload, id: `rule-${Date.now()}` });
    },
    publishVersion(state) {
      const source = state.versions.find((item) => item.id === state.previewVersionId);
      if (!source) return;
      const id = `v${state.versions.length + 1}`;
      const now = new Date().toISOString();
      const clone: FormVersion = {
        ...source,
        fields: source.fields.map((field) => ({ ...field })),
        rules: source.rules.map((rule) => ({ ...rule }))
      };
      state.versions.push({ ...clone, id, label: `费用申请 ${id}`, createdAt: now.slice(0, 10) });
      state.activeVersionId = id; state.previewVersionId = id;

      // 新版本发布：尚未完成的待迁项与批次作废，已完成的迁移账保留原版本解释
      for (const item of state.migrationItems) {
        if (item.status !== 'succeeded') item.status = 'voided';
      }
      for (const batch of state.migrationBatches) {
        const items = state.migrationItems.filter((item) => item.batchId === batch.id);
        batch.status = items.length > 0 && items.every((item) => item.status === 'succeeded') ? 'completed' : 'voided';
      }

      const version = state.versions.find((item) => item.id === id)!;
      const migration = buildMigration(version, state.snapshots, state.rules, state.ledger);
      state.migrationBatches.push(...migration.batches);
      state.migrationItems.push(...migration.items);
    },
    /** 执行/重试一个批次：从断点续作，已成功的项不重复写入 */
    runMigration(state, action: PayloadAction<string>) {
      const batch = state.migrationBatches.find((item) => item.id === action.payload);
      if (!batch || batch.status === 'voided') return;
      const version = state.versions.find((item) => item.id === batch.versionId);
      if (!version) return;

      const batchItems = state.migrationItems
        .filter((item) => item.batchId === batch.id && item.status !== 'succeeded' && item.status !== 'voided')
        .sort((a, b) => a.id.localeCompare(b.id));

      for (const item of batchItems) {
        // 断点续作：只处理未完成项，成功项已跳过
        if (item.errors.length > 0) {
          // 校验失败（必填/联动不满足）：隔离该项，不阻断批次，待规则变更后重算
          item.status = 'failed';
          item.attempts += 1;
          item.checkpoint = 'validate';
          item.lastError = `校验未通过：${item.errors.join('；')}`;
          continue;
        }
        if (item.failInjected) {
          // 写入失败：事务中断，后续项等待，重试从此断点继续
          item.status = 'failed';
          item.attempts += 1;
          item.checkpoint = 'write';
          item.lastError = '模拟写入失败：事务中断，重试将从断点继续';
          break;
        }
        const snapshot = state.snapshots.find((snap) => snap.id === item.snapshotId);
        if (!snapshot) {
          item.status = 'failed';
          item.attempts += 1;
          item.lastError = '快照不存在';
          break;
        }
        item.status = 'succeeded';
        item.attempts += 1;
        item.checkpoint = 'done';
        item.migratedData = { ...snapshot.data };
        item.migratedAt = new Date().toISOString();
        // 幂等写入迁移账：同一待迁项只写一条分录
        if (!state.ledger.some((entry) => entry.itemId === item.id)) {
          state.ledger.push({
            id: `le-${item.id}`,
            itemId: item.id,
            batchId: batch.id,
            snapshotId: snapshot.id,
            fromVersionId: item.fromVersionId,
            toVersionId: item.toVersionId,
            data: { ...snapshot.data },
            completedAt: item.migratedAt
          });
        }
      }

      const all = state.migrationItems.filter((item) => item.batchId === batch.id);
      batch.status = all.length > 0 && all.every((item) => item.status === 'succeeded') ? 'completed' : 'open';

      // 批次完成后，下一批排队项提升为待执行
      if (batch.status === 'completed') {
        const next = state.migrationBatches
          .filter((item) => item.versionId === batch.versionId && item.status === 'open')
          .sort((a, b) => a.index - b.index)[0];
        if (next) {
          for (const item of state.migrationItems.filter((entry) => entry.batchId === next.id && entry.status === 'queued')) {
            item.status = 'pending';
          }
        }
      }
    },
    toggleFailInjection(state, action: PayloadAction<string>) {
      const item = state.migrationItems.find((entry) => entry.id === action.payload);
      if (item && item.status !== 'succeeded' && item.status !== 'voided') {
        item.failInjected = !item.failInjected;
      }
    },
    selectPreview(state, action: PayloadAction<string>) { state.previewVersionId = action.payload; },
    replaceState(_state, action: PayloadAction<SchemaState>) { return action.payload; }
  }
});

export const schemaApi = createApi({
  reducerPath: 'schemaApi', baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    schemaHistory: builder.query<FormVersion[], string>({
      queryFn: (versionId) => {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem('yf55-schema-state');
        const state = raw ? JSON.parse(raw) as SchemaState : initial;
        return { data: state.versions.filter((item) => item.id !== versionId).slice(-3) };
      }
    })
  })
});

export const { useSchemaHistoryQuery } = schemaApi;
export const { addField, addRule, publishVersion, reorderFields, replaceState, runMigration, toggleFailInjection, selectPreview } = slice.actions;
export const store = configureStore({ reducer: { schema: slice.reducer, [schemaApi.reducerPath]: schemaApi.reducer }, middleware: (getDefault) => getDefault().concat(schemaApi.middleware) });

function loadState(): SchemaState {
  if (typeof window === 'undefined') return initial;
  const saved = localStorage.getItem('yf55-schema-state');
  if (!saved) return initial;
  const parsed = JSON.parse(saved) as Partial<SchemaState>;
  const normalized: SchemaState = {
    ...initial,
    ...parsed,
    migrationBatches: parsed.migrationBatches ?? [],
    migrationItems: parsed.migrationItems ?? [],
    ledger: parsed.ledger ?? []
  };
  // 旧存档没有迁移账时，为当前版本补建批次
  if (normalized.migrationBatches.length === 0) {
    const active = normalized.versions.find((version) => version.id === normalized.activeVersionId)
      ?? normalized.versions[normalized.versions.length - 1];
    const migration = buildMigration(active, normalized.snapshots, normalized.rules, normalized.ledger);
    normalized.migrationBatches = migration.batches;
    normalized.migrationItems = migration.items;
  }
  return normalized;
}

if (typeof window !== 'undefined') {
  store.dispatch(replaceState(loadState()));
  store.subscribe(() => localStorage.setItem('yf55-schema-state', JSON.stringify((store.getState() as RootShape).schema)));
}
export type RootState = RootShape;
