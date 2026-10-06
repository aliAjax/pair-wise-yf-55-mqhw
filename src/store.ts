import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import {
  fingerprint, isWritable, lastWrittenVersion, newPlanItems, projectRecord,
  type JournalEntry, type MigrationBatch, type MigrationItem, type MigrationPlan
} from './migration/engine';

/**
 * 对可能是 Immer draft 的数据做深拷贝。state 全是可序列化的纯数据
 * （本来也要持久化到 localStorage），经 JSON 一层即可得到脱离代理的普通对象。
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type FieldType = 'text' | 'number' | 'select' | 'date';
export interface FormField { id: string; label: string; type: FieldType; required: boolean; options?: string[]; }
export interface LinkRule { id: string; fieldId: string; operator: 'equals' | 'notEmpty'; value: string; effect: 'show' | 'require'; targetId: string; }
export interface FormVersion { id: string; label: string; createdAt: string; fields: FormField[]; rules: LinkRule[]; }
export interface Snapshot { id: string; versionId: string; label: string; data: Record<string, string>; }

/** 容量：单批次最多写入多少条；满了后续快照排队等待下一批 */
export const MIGRATION_CAPACITY = 2;

interface SchemaState {
  versions: FormVersion[];
  rules: LinkRule[];
  activeVersionId: string;
  previewVersionId: string;
  snapshots: Snapshot[];
  plans: MigrationPlan[];
  batches: MigrationBatch[];
  /** 写入流水，跨批次、跨版本共享：snapshotId 幂等去重的账本 */
  journal: JournalEntry[];
}
type RootShape = { schema: SchemaState };

const initial: SchemaState = {
  activeVersionId: 'v1',
  previewVersionId: 'draft-v2',
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
      id: 'draft-v2', label: '费用申请 v2 · 草稿', createdAt: '2026-09-28',
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
    { id: 's2', versionId: 'v1', label: '市场活动费用', data: { name: '新品活动', department: '市场', amount: '58000' } },
    { id: 's3', versionId: 'v1', label: '研发设备采购', data: { name: '设备采购', department: '研发', amount: '86000' } },
    { id: 's4', versionId: 'v1', label: '缺金额的历史单', data: { name: '遗留单据', department: '市场' } }
  ],
  plans: [],
  batches: [],
  journal: []
};

let seq = 0;
const nextId = (prefix: string) => {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
};

/** 生成待迁批次：只挑「从未写入目标版本」的快照，按容量切批 */
function buildPlan(state: SchemaState, target: FormVersion): MigrationPlan {
  const pending = state.snapshots.filter((snapshot) => {
    const written = lastWrittenVersion(state.journal, snapshot.id);
    return written === undefined;
  });

  const batches: MigrationBatch[] = [];
  for (let offset = 0; offset < pending.length; offset += MIGRATION_CAPACITY) {
    const chunk = pending.slice(offset, offset + MIGRATION_CAPACITY);
    const items: MigrationItem[] = chunk.map((snapshot) => ({
      id: nextId('item'),
      ...newPlanItems(snapshot, target.fields, target.rules)
    }));
    batches.push({
      id: nextId('batch'),
      planId: '',
      targetVersionId: target.id,
      frozen: { fields: clone(target.fields).map((field) => ({ ...field })), rules: clone(target.rules).map((rule) => ({ ...rule })) },
      items,
      status: 'queued',
      checkpoint: 0,
      attempts: 0,
      createdAt: new Date().toISOString()
    });
  }

  const plan: MigrationPlan = {
    id: nextId('plan'),
    targetVersionId: target.id,
    batchSize: MIGRATION_CAPACITY,
    batchIds: batches.map((batch) => batch.id),
    createdAt: new Date().toISOString()
  };
  batches.forEach((batch) => { batch.planId = plan.id; });
  state.batches.push(...batches);
  state.plans.push(plan);
  return plan;
}

/**
 * 执行一个批次（可中断）。直接改写 draft。
 * - 从 checkpoint 续作，已写入项不再处理；
 * - 写入前查流水：同一 snapshotId 已存在记录则跳过（重试不重复写入）；
 * - 阻塞项（必填/联动缺口）让批次挂起等待补齐；
 * - crash=true 模拟中断：某一项写到一半失败，保留断点供恢复。
 */
function executeBatch(state: SchemaState, batch: MigrationBatch, crash: boolean): void {
  if (batch.status === 'void' || batch.status === 'done') return;
  batch.attempts += 1;
  batch.status = 'running';
  batch.lastError = undefined;

  // checkpoint 是断点：已连续写入的条数；阻塞、崩溃都停在当前项，恢复时从这里继续
  for (let i = batch.checkpoint; i < batch.items.length; i += 1) {
    const item = batch.items[i];
    if (item.status === 'written') { batch.checkpoint = i + 1; continue; }
    item.attempts += 1;

    const snapshot = state.snapshots.find((s) => s.id === item.snapshotId);
    if (!snapshot) {
      item.status = 'blocked';
      item.blockedReason = '快照已不存在';
      batch.status = 'blocked';
      batch.lastError = item.blockedReason;
      return;
    }

    // 指纹核对：中断重试期间快照若被换过内容，按冻结规则重新校验，不能当作同一条盲目重写
    if (fingerprint(snapshot.data) !== item.fingerprint) {
      item.issues = newPlanItems(snapshot, batch.frozen.fields, batch.frozen.rules).issues;
      item.fingerprint = fingerprint(snapshot.data);
    }

    if (!isWritable(item)) {
      item.status = 'blocked';
      item.blockedReason = item.issues.filter((issue) => issue.level === 'blocker').map((issue) => issue.message).join('；');
      batch.status = 'blocked';
      batch.lastError = item.blockedReason;
      return; // 断点停在 i：后续快照继续排队
    }

    // crash 模拟：在本次执行的第一项（即当前断点处）写到一半中断，断点与流水都不动
    if (crash && i === batch.checkpoint) {
      batch.status = 'failed';
      batch.lastError = '写入过程中断电/网络中断';
      return;
    }

    // 幂等写入：流水里已有该快照对该版本的写入记录则跳过（中断重试不重复写入）
    const already = state.journal.some(
      (entry) => entry.snapshotId === item.snapshotId && entry.targetVersionId === batch.targetVersionId
    );
    if (!already) {
      state.journal.push({
        seq: state.journal.length + 1,
        snapshotId: item.snapshotId,
        label: item.label,
        targetVersionId: batch.targetVersionId,
        record: projectRecord(snapshot.data, batch.frozen.fields),
        writtenAt: new Date().toISOString()
      });
      item.journalSeq = state.journal.length;
    }
    item.status = 'written';
    item.blockedReason = undefined;
    batch.checkpoint = i + 1;
  }

  batch.status = 'done';
  batch.finishedAt = new Date().toISOString();
}

/** 按冻结规则重新校验某个阻塞项（补齐快照内容后续作） */
function recheckItem(state: SchemaState, batchId: string, itemId: string) {
  const batch = state.batches.find((item) => item.id === batchId);
  const item = batch?.items.find((entry) => entry.id === itemId);
  const snapshot = batch && item ? state.snapshots.find((s) => s.id === item.snapshotId) : undefined;
  if (!batch || !item || !snapshot) return;
  item.issues = newPlanItems(snapshot, batch.frozen.fields, batch.frozen.rules).issues;
  item.fingerprint = fingerprint(snapshot.data);
  if (isWritable(item)) {
    item.status = 'pending';
    item.blockedReason = undefined;
    // 补齐后回到排队状态，由业务人员点击「从断点续作」恢复；全部项均已写入则收尾
    batch.status = batch.checkpoint >= batch.items.length || batch.items.every((entry) => entry.status === 'written')
      ? 'done'
      : 'queued';
    batch.lastError = undefined;
    if (batch.status === 'done' && !batch.finishedAt) batch.finishedAt = new Date().toISOString();
  } else {
    item.blockedReason = item.issues.filter((issue) => issue.level === 'blocker').map((issue) => issue.message).join('；');
  }
}

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
    /** 编辑字段标签/必填（用于演示规则改动后，旧批次仍按冻结依赖解释） */
    updateField(state, action: PayloadAction<{ id: string; label?: string; required?: boolean }>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      const field = version?.fields.find((item) => item.id === action.payload.id);
      if (!field) return;
      if (action.payload.label !== undefined) field.label = action.payload.label;
      if (action.payload.required !== undefined) field.required = action.payload.required;
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      const rule = { ...action.payload, id: `rule-${Date.now()}` };
      if (version) version.rules.push(rule); else state.rules.push(rule);
    },
    /**
     * 发布新版本：
     * 1) 冻结当前草稿为正式版本；
     * 2) 未执行的批次作废重算（排队/阻塞/失败/运行中），已完成批次与流水不动；
     * 3) 按新版本重新生成待迁批次，只包含尚未写入任何版本的快照；
     * 4) 开新一版草稿，继续编排。
     */
    publishVersion(state) {
      const source = state.versions.find((item) => item.id === state.previewVersionId);
      if (!source) return;
      const n = state.versions.filter((item) => /^v\d+$/.test(item.id)).length + 1;
      const id = `v${n}`;
      const published: FormVersion = {
        ...clone(source),
        id,
        label: `费用申请 ${id}`,
        createdAt: new Date().toISOString().slice(0, 10)
      };
      state.versions.push(published);
      state.activeVersionId = id;

      // 作废所有「尚未完成」的在途批次（排队/运行/阻塞/失败），已完成批次与流水不动
      for (const plan of state.plans) {
        if (plan.supersededAt) continue;
        const live = state.batches.filter((batch) => batch.planId === plan.id && batch.status !== 'done' && batch.status !== 'void');
        if (live.length > 0) {
          plan.supersededAt = new Date().toISOString();
          live.forEach((batch) => {
            batch.status = 'void';
            batch.voidReason = `新版本 ${id} 发布，未执行批次作废重算`;
          });
        }
      }
      // 已完成结果的流水保持不变：仍按写入时的版本解释。
      // 为新版本重算待迁批次（只含尚未写入任何版本的快照），队列从头排起。
      const plan = buildPlan(state, published);
      plan.sourceVersionId = state.versions
        .filter((version) => /^v\d+$/.test(version.id) && version.id !== id)
        .at(-1)?.id;

      // 旧草稿冻结为正式版本；开新一版草稿继续编排（历史版本不可再编辑）
      const draftId = `draft-v${n + 1}`;
      const draft: FormVersion = {
        ...clone(published),
        id: draftId,
        label: `费用申请 v${n + 1} · 草稿`,
        createdAt: new Date().toISOString().slice(0, 10)
      };
      state.versions = state.versions.filter((item) => !item.id.startsWith('draft-'));
      state.versions.push(draft);
      state.previewVersionId = draftId;
    },
    /** 手动为当前活跃版本生成待迁批次（发布时已自动生成，供重置后演示） */
    generateBatches(state) {
      const target = state.versions.find((item) => item.id === state.activeVersionId);
      if (target) buildPlan(state, target);
    },
    runBatch(state, action: PayloadAction<{ batchId: string; crash?: boolean }>) {
      const batch = state.batches.find((item) => item.id === action.payload.batchId);
      if (batch) executeBatch(state, batch, Boolean(action.payload.crash));
    },
    resumeBatch(state, action: PayloadAction<string>) {
      const batch = state.batches.find((item) => item.id === action.payload);
      if (batch) executeBatch(state, batch, false);
    },
    revalidateItem(state, action: PayloadAction<{ batchId: string; itemId: string }>) {
      recheckItem(state, action.payload.batchId, action.payload.itemId);
    },
    /** 业务人员补齐阻塞快照的字段值 */
    patchSnapshot(state, action: PayloadAction<{ snapshotId: string; patch: Record<string, string> }>) {
      const snapshot = state.snapshots.find((item) => item.id === action.payload.snapshotId);
      if (!snapshot) return;
      snapshot.data = { ...snapshot.data, ...action.payload.patch };
      // 补齐后自动让引用该快照的在途阻塞/失败批次按其冻结规则重新校验
      state.batches
        .filter((batch) => batch.status === 'blocked' || batch.status === 'failed' || batch.status === 'queued')
        .forEach((batch) => {
          const blocked = batch.items.find((entry) => entry.snapshotId === snapshot.id && entry.status === 'blocked');
          if (blocked) recheckItem(state, batch.id, blocked.id);
        });
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
export const {
  addField, addRule, generateBatches, patchSnapshot, publishVersion, reorderFields,
  replaceState, revalidateItem, runBatch, resumeBatch, selectPreview, updateField
} = slice.actions;
/** 兼容旧版本持久化数据：补齐迁移账字段，避免升级后白屏 */
function normalizePersisted(raw: unknown): SchemaState {
  const parsed = raw as Partial<SchemaState> | null;
  if (!parsed || !Array.isArray(parsed.versions)) return initial;
  return {
    ...initial,
    ...parsed,
    versions: parsed.versions as FormVersion[],
    rules: parsed.rules ?? [],
    snapshots: parsed.snapshots ?? initial.snapshots,
    plans: parsed.plans ?? [],
    batches: parsed.batches ?? [],
    journal: parsed.journal ?? []
  };
}

export const store = configureStore({ reducer: { schema: slice.reducer, [schemaApi.reducerPath]: schemaApi.reducer }, middleware: (getDefault) => getDefault().concat(schemaApi.middleware) });
if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf55-schema-state');
  if (saved) store.dispatch(replaceState(normalizePersisted(JSON.parse(saved))));
  store.subscribe(() => localStorage.setItem('yf55-schema-state', JSON.stringify((store.getState() as RootShape).schema)));
}
export type RootState = RootShape;
