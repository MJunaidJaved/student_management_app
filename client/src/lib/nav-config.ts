import type { ComponentType } from 'react'
import {
  Home,
  ClipboardList,
  Users,
  UserPlus,
  UserRound,
  Wallet,
  CalendarCheck,
  CalendarClock,
  FileSpreadsheet,
  GraduationCap,
  CalendarDays,
  Repeat,
  UserCog,
  Banknote,
  Landmark,
  Boxes,
  Bell,
  BarChart3,
  ShieldCheck,
  History,
  Settings,
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
  icon: ComponentType<{ className?: string }>
  items: NavItem[]
}

/** The home page: a single link above the collapsible sections. */
export const HOME_ITEM: NavItem = { label: 'Home', path: '/', icon: Home, permissions: [] }

/** Office-style sections; each opens to show its pages. */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Front Office',
    icon: ClipboardList,
    items: [{ label: 'Admission Enquiry', path: '/admissions', icon: ClipboardList, permissions: ['admissions.read'] }],
  },
  {
    label: 'Student Information',
    icon: Users,
    items: [
      { label: 'Student Details', path: '/students', icon: Users, permissions: ['students.read'] },
      { label: 'Add Student', path: '/students/new', icon: UserPlus, permissions: ['students.create'] },
      { label: 'Guardians', path: '/guardians', icon: UserRound, permissions: ['guardians.search', 'students.read'] },
    ],
  },
  {
    label: 'Fees Collection',
    icon: Wallet,
    items: [{ label: 'Collect Fees', path: '/fees', icon: Wallet, permissions: ['fees.read', 'fees.read_own', 'fees.collect'] }],
  },
  {
    label: 'Attendance',
    icon: CalendarCheck,
    items: [
      { label: 'Student Attendance', path: '/attendance', icon: CalendarCheck, permissions: ['attendance.read', 'attendance.mark'] },
      { label: 'Leave Requests', path: '/leave', icon: CalendarClock, permissions: ['leave.read_own', 'leave.approve_staff', 'leave.approve_student'] },
    ],
  },
  {
    label: 'Examinations',
    icon: FileSpreadsheet,
    items: [{ label: 'Exams', path: '/exams', icon: FileSpreadsheet, permissions: ['exams.read', 'exams.read_own'] }],
  },
  {
    label: 'Academics',
    icon: GraduationCap,
    items: [
      { label: 'Class Timetable', path: '/timetable', icon: CalendarDays, permissions: ['timetable.read'] },
      { label: 'Substitutions', path: '/substitutions', icon: Repeat, permissions: ['substitutions.read'] },
      { label: 'Classes & Subjects', path: '/academic', icon: GraduationCap, permissions: ['academic.read'] },
    ],
  },
  {
    label: 'Human Resource',
    icon: UserCog,
    items: [
      { label: 'Staff Directory', path: '/staff', icon: UserCog, permissions: ['staff.read', 'staff.read_own'] },
      { label: 'Payroll', path: '/payroll', icon: Banknote, permissions: ['payroll.read', 'payroll.read_own'] },
    ],
  },
  {
    label: 'Accounts',
    icon: Landmark,
    items: [{ label: 'Vouchers & Ledger', path: '/accounting', icon: Landmark, permissions: ['accounting.read'] }],
  },
  {
    label: 'Inventory',
    icon: Boxes,
    items: [{ label: 'Stock & Purchases', path: '/inventory', icon: Boxes, permissions: ['inventory.read'] }],
  },
  {
    label: 'Communicate',
    icon: Bell,
    items: [{ label: 'Notifications', path: '/notifications', icon: Bell, permissions: [] }],
  },
  {
    label: 'Reports',
    icon: BarChart3,
    items: [{ label: 'Reports', path: '/reports', icon: BarChart3, permissions: ['students.read', 'staff.read'] }],
  },
  {
    label: 'System Settings',
    icon: Settings,
    items: [
      { label: 'School Settings', path: '/settings', icon: Settings, permissions: ['settings.read'] },
      { label: 'Roles & Users', path: '/roles', icon: ShieldCheck, permissions: ['roles.read', 'users.read'] },
      { label: 'Audit Log', path: '/audit-logs', icon: History, permissions: ['audit.read'] },
    ],
  },
]

/** Shortcut tiles on the home page, in the order the office uses them most. */
export const SHORTCUTS: NavItem[] = [
  { label: 'Student Details', path: '/students', icon: Users, permissions: ['students.read'] },
  { label: 'Add Student', path: '/students/new', icon: UserPlus, permissions: ['students.create'] },
  { label: 'Collect Fees', path: '/fees', icon: Wallet, permissions: ['fees.collect', 'fees.read'] },
  { label: 'Student Attendance', path: '/attendance', icon: CalendarCheck, permissions: ['attendance.mark', 'attendance.read'] },
  { label: 'Leave Requests', path: '/leave', icon: CalendarClock, permissions: ['leave.approve_student', 'leave.approve_staff', 'leave.read_own'] },
  { label: 'Admission Enquiry', path: '/admissions', icon: ClipboardList, permissions: ['admissions.read'] },
  { label: 'Staff Directory', path: '/staff', icon: UserCog, permissions: ['staff.read'] },
  { label: 'Exam List', path: '/exams', icon: FileSpreadsheet, permissions: ['exams.read'] },
  { label: 'Class Timetable', path: '/timetable', icon: CalendarDays, permissions: ['timetable.read'] },
  { label: 'Substitutions', path: '/substitutions', icon: Repeat, permissions: ['substitutions.read'] },
  { label: 'Guardians', path: '/guardians', icon: UserRound, permissions: ['guardians.search', 'students.read'] },
  { label: 'Vouchers', path: '/accounting', icon: Landmark, permissions: ['accounting.read'] },
  { label: 'Payroll', path: '/payroll', icon: Banknote, permissions: ['payroll.read'] },
  { label: 'Stock', path: '/inventory', icon: Boxes, permissions: ['inventory.read'] },
  { label: 'Reports', path: '/reports', icon: BarChart3, permissions: ['students.read', 'staff.read'] },
  { label: 'Notifications', path: '/notifications', icon: Bell, permissions: [] },
]
