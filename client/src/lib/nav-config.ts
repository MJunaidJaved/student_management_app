import type { ComponentType } from 'react'
import {
  LayoutDashboard,
  GraduationCap,
  Users,
  UserCog,
  ClipboardList,
  CalendarCheck,
  CalendarClock,
  Repeat,
  Bell,
  Wallet,
  Landmark,
  FileSpreadsheet,
  Banknote,
  Boxes,
  BookOpen,
  Bus,
  ShieldCheck,
  Settings,
  History,
  BarChart3,
} from 'lucide-react'

export type NavItem = {
  label: string
  path: string
  icon: ComponentType<{ className?: string }>
  /** Shown if the user holds ANY of these permission codes. Empty = always shown to authenticated users. */
  permissions: string[]
}

export type NavGroup = {
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: '',
    items: [{ label: 'Dashboard', path: '/', icon: LayoutDashboard, permissions: [] }],
  },
  {
    label: 'People & Academic',
    items: [
      { label: 'Academic Setup', path: '/academic', icon: GraduationCap, permissions: ['academic.read'] },
      { label: 'Admissions', path: '/admissions', icon: ClipboardList, permissions: ['admissions.read'] },
      { label: 'Students', path: '/students', icon: Users, permissions: ['students.read'] },
      { label: 'Guardians', path: '/guardians', icon: Users, permissions: ['guardians.search', 'students.read'] },
      { label: 'Staff', path: '/staff', icon: UserCog, permissions: ['staff.read', 'staff.read_own'] },
    ],
  },
  {
    label: 'Daily Operations',
    items: [
      { label: 'Attendance', path: '/attendance', icon: CalendarCheck, permissions: ['attendance.read', 'attendance.mark'] },
      { label: 'Leave', path: '/leave', icon: CalendarClock, permissions: ['leave.read_own', 'leave.approve_staff', 'leave.approve_student'] },
      { label: 'Timetable', path: '/timetable', icon: CalendarClock, permissions: ['timetable.read'] },
      { label: 'Substitutions', path: '/substitutions', icon: Repeat, permissions: ['substitutions.read'] },
      { label: 'Notifications', path: '/notifications', icon: Bell, permissions: [] },
    ],
  },
  {
    label: 'Finance & Accounting',
    items: [
      { label: 'Fees', path: '/fees', icon: Wallet, permissions: ['fees.read', 'fees.read_own', 'fees.collect'] },
      { label: 'Accounting', path: '/accounting', icon: Landmark, permissions: ['accounting.read'] },
    ],
  },
  {
    label: 'Exams & Payroll',
    items: [
      { label: 'Exams', path: '/exams', icon: FileSpreadsheet, permissions: ['exams.read', 'exams.read_own'] },
      { label: 'Payroll', path: '/payroll', icon: Banknote, permissions: ['payroll.read', 'payroll.read_own'] },
    ],
  },
  {
    label: 'Support Systems',
    items: [
      { label: 'Inventory', path: '/inventory', icon: Boxes, permissions: ['inventory.read'] },
      { label: 'Library', path: '/library', icon: BookOpen, permissions: ['library.read', 'library.read_own'] },
      { label: 'Transport', path: '/transport', icon: Bus, permissions: ['transport.read', 'transport.read_own'] },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Reports', path: '/reports', icon: BarChart3, permissions: ['students.read', 'staff.read'] },
      { label: 'Roles & Users', path: '/roles', icon: ShieldCheck, permissions: ['roles.read', 'users.read'] },
      { label: 'Audit Logs', path: '/audit-logs', icon: History, permissions: ['audit.read'] },
      { label: 'Settings', path: '/settings', icon: Settings, permissions: ['settings.read'] },
    ],
  },
]
