export type RoleView = {
  id: string
  name: string
  description: string | null
  isSystem: boolean
  userCount: number
  permissionCount: number
  createdAt: string
  updatedAt: string
}
export type RoleDetail = RoleView & { permissions: string[] }
export type PermissionCatalog = Record<string, { code: string; description: string | null }[]>
