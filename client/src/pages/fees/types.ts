// Mirrors server/src/modules/fees/fees.service.ts's view types.

export type FeeCategoryView = { id: string; name: string; frequency: string; incomeHeadId: string | null; isActive: boolean }
export type FeeStructureView = { id: string; academicYearId: string; classId: string; feeCategoryId: string; amount: string; dueDay: number | null }
export type DiscountView = { id: string; name: string; type: string; value: string }

export type FeeInvoiceView = {
  id: string
  invoiceNo: string
  enrollmentId: string
  billingPeriod: string
  issueDate: string
  dueDate: string
  subtotal: string
  discountTotal: string
  fineTotal: string
  total: string
  paidTotal: string
  outstanding: string
  status: string
}

export type FeeInvoiceItemView = {
  id: string
  feeCategoryId: string
  feeCategoryName: string
  description: string | null
  amount: string
  discountAmount: string
}

export type InvoicePayment = { paymentId: string; receiptNo: string; paidAt: string; amount: string; status: string }

export type InvoiceDetail = FeeInvoiceView & { items: FeeInvoiceItemView[]; payments: InvoicePayment[] }

export type PaymentView = {
  id: string
  receiptNo: string
  guardianId: string | null
  amount: string
  method: string
  referenceNo: string | null
  bankAccountId: string | null
  paidAt: string
  receivedBy: string
  status: string
  reversedBy: string | null
  reversedAt: string | null
  reversalReason: string | null
}
