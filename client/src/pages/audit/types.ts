export type AuditEntry = {
  id: string
  userId: string | null
  username: string | null
  action: string
  event: string | null
  tableName: string | null
  recordId: string | null
  ipAddress: string | null
  createdAt: string
}
export type AuditEntryDetail = AuditEntry & { oldValues: unknown; newValues: unknown }
