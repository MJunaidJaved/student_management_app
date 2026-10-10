export type BookCategoryView = { id: string; name: string }
export type BookView = { id: string; accessionNo: string; isbn: string | null; title: string; author: string | null; categoryId: string | null; copiesTotal: number; shelfLocation: string | null }
export type BookListItem = BookView & { categoryName: string | null; issuedCount: number }

export type BorrowerType = 'student' | 'staff'
export type BookIssueView = {
  id: string
  bookId: string
  borrowerType: BorrowerType
  studentId: string | null
  staffId: string | null
  issueDate: string
  dueDate: string
  returnDate: string | null
  status: string
  renewalCount: number
}
export type BookIssueListItem = BookIssueView & { title: string; accessionNo: string }

export type LibraryFineView = { id: string; bookIssueId: string; amount: string; status: string; paymentId: string | null; waivedReason: string | null }
