import type { FormField, FormVersion, LinkRule, Snapshot } from '../store';

/** 迁移账领域模型 */

export type IssueLevel = 'blocker' | 'info';
export interface MigrationIssue {
  code: 'REQUIRED_MISSING' | 'LINKAGE_REQUIRE' | 'FIELD_DROPPED';
  level: IssueLevel;
  message: string;
}

export type ItemStatus = 'pending' | 'written' | 'blocked';
export interface MigrationItem {
  id: string;
  snapshotId: string;
  label: string;
  status: ItemStatus;
  /** 快照内容指纹，用于核对重试的仍是同一条数据 */
  fingerprint: string;
  /** 计划阶段按当时规则得出的缺口（供业务人员排队前查看） */
  issues: MigrationIssue[];
  attempts: number;
  /** 阻塞原因（必填缺失 / 联动不满足），补齐后可恢复 */
  blockedReason?: string;
  /** 写入流水号，对应 migrationJournal 中的序号 */
  journalSeq?: number;
}

export type BatchStatus =
  | 'queued'   // 尚未执行（新版本再发布会作废重算）
  | 'running'  // 已领取容量，正在写入
  | 'blocked'  // 遇到阻塞项，已让出容量、排队等待补齐
  | 'failed'   // 执行中断，可从 checkpoint 断点恢复
  | 'done'     // 全部写入完成
  | 'void';    // 被新版本发布作废
export interface MigrationBatch {
  id: string;
  planId: string;
  targetVersionId: string;
  /** 批次冻结目标版本的字段与规则副本：
   * 规则再怎么改，已生成的批次仍按发布时的依赖解释 */
  frozen: { fields: FormField[]; rules: LinkRule[] };
  items: MigrationItem[];
  status: BatchStatus;
  /** 断点：下一条待写入项的下标；0 = 从头，items.length = 全部完成 */
  checkpoint: number;
  attempts: number;
  lastError?: string;
  createdAt: string;
  finishedAt?: string;
  voidReason?: string;
}

export interface MigrationPlan {
  id: string;
  targetVersionId: string;
  sourceVersionId?: string;
  batchSize: number;
  batchIds: string[];
  createdAt: string;
  supersededAt?: string;
}

export interface JournalEntry {
  seq: number;
  snapshotId: string;
  label: string;
  targetVersionId: string;
  /** 按目标版本投影后的结果记录（旧版本字段不再出现在其中） */
  record: Record<string, string>;
  writtenAt: string;
}

/**
 * 按指定版本的字段与规则校验一条快照。
 * 必填：目标版本 required 字段必须有值。
 * 联动：equals/notEmpty 触发 require 时，目标字段必须有值（阻塞）；
 *       show 不满足只作信息提示，不阻塞迁移。
 */
export function validateSnapshot(
  data: Record<string, string>,
  fields: FormField[],
  rules: LinkRule[]
): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const fieldMap = new Map(fields.map((field) => [field.id, field]));

  for (const field of fields) {
    if (field.required && !String(data[field.id] ?? '').trim()) {
      issues.push({ code: 'REQUIRED_MISSING', level: 'blocker', message: `缺少必填字段「${field.label}」` });
    }
  }

  const ruleHits = (rule: LinkRule) =>
    rule.operator === 'equals'
      ? data[rule.fieldId] === rule.value
      : String(data[rule.fieldId] ?? '').trim().length > 0;

  for (const rule of rules) {
    if (!fieldMap.has(rule.targetId) || !fieldMap.has(rule.fieldId)) continue;
    if (!ruleHits(rule)) continue;
    const target = fieldMap.get(rule.targetId)!;
    if (rule.effect === 'require' && !String(data[rule.targetId] ?? '').trim()) {
      issues.push({
        code: 'LINKAGE_REQUIRE', level: 'blocker',
        message: `联动要求：「${target.label}」在当前条件下必填`
      });
    } else if (rule.effect === 'show') {
      issues.push({
        code: 'FIELD_DROPPED', level: 'info',
        message: `联动显示「${target.label}」，快照未提供，按空值迁移`
      });
    }
  }
  return issues;
}

/** 只保留目标版本仍然存在的字段，得到新版本下的记录 */
export function projectRecord(data: Record<string, string>, fields: FormField[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const field of fields) record[field.id] = data[field.id] ?? '';
  return record;
}

/** 快照内容指纹（简易 FNV-1a），重试时核对是不是同一条数据 */
export function fingerprint(data: Record<string, string>): string {
  const json = JSON.stringify(
    Object.keys(data).sort().reduce<Record<string, string>>((acc, key) => {
      acc[key] = data[key];
      return acc;
    }, {})
  );
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function newPlanItems(
  snapshot: Snapshot,
  fields: FormField[],
  rules: LinkRule[]
): Omit<MigrationItem, 'id'> {
  return {
    snapshotId: snapshot.id,
    label: snapshot.label,
    status: 'pending',
    fingerprint: fingerprint(snapshot.data),
    issues: validateSnapshot(snapshot.data, fields, rules),
    attempts: 0
  };
}

/** 一条快照在目标版本下是否可直接写入（无阻塞级问题） */
export function isWritable(item: MigrationItem): boolean {
  return !item.issues.some((issue) => issue.level === 'blocker');
}

/** 阻塞级缺口对应的字段 id（必填缺失 + 联动 require 不满足），供业务人员补齐 */
export function missingFieldIds(data: Record<string, string>, fields: FormField[], rules: LinkRule[]): string[] {
  const ids = new Set<string>();
  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  for (const field of fields) {
    if (field.required && !String(data[field.id] ?? '').trim()) ids.add(field.id);
  }
  const hits = (rule: LinkRule) =>
    rule.operator === 'equals'
      ? data[rule.fieldId] === rule.value
      : String(data[rule.fieldId] ?? '').trim().length > 0;
  for (const rule of rules) {
    if (rule.effect === 'require' && fieldMap.has(rule.targetId) && hits(rule) && !String(data[rule.targetId] ?? '').trim()) {
      ids.add(rule.targetId);
    }
  }
  return [...ids];
}

/** 规则签名：用于比较批次冻结规则与草稿上的现行规则是否一致 */
export function rulesSignature(rules: LinkRule[]): string {
  return rules
    .map((rule) => `${rule.fieldId}|${rule.operator}|${rule.value}|${rule.effect}|${rule.targetId}`)
    .sort()
    .join(';');
}

/** 找到该快照最近一次成功写入所对应的版本（按流水倒序） */
export function lastWrittenVersion(journal: JournalEntry[], snapshotId: string): string | undefined {
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    if (journal[i].snapshotId === snapshotId) return journal[i].targetVersionId;
  }
  return undefined;
}

export function batchProgress(batch: MigrationBatch): { written: number; total: number } {
  return { written: batch.checkpoint, total: batch.items.length };
}

export function versionLabel(versions: FormVersion[], id: string): string {
  return versions.find((version) => version.id === id)?.label ?? id;
}
