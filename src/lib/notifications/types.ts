import 'server-only'

/**
 * Notification contracts — docs/03 §4, docs/08/09.
 * D4: delivery is best-effort; results are unions, no throws across the seam.
 */

export type DeliveryResult = { ok: true } | { ok: false; code: string; retryable: boolean }

export interface NewApplicationEvent {
  jobTitle: string
  applicantName: string
  email: string
  phone: string | null
  resumeUploaded: boolean
  applicationId: string
  /** Phase 4: journaled events anchor to the applicant so scoped timeline feeds include them. */
  applicantId?: string
}

export interface ApplicantConfirmation {
  to: string
  candidateFirstName: string
  jobTitle: string
  companyLabel: string
}

export interface ResumeFailedAlert {
  jobTitle: string
  applicantName: string
  ownerEmail: string
  companyLabel: string
  /** Phase 4: journaled events anchor to the applicant/application so scoped timeline feeds include them. */
  applicantId?: string
  applicationId?: string
}

export interface NotificationService {
  notifyOwnerNewApplication(e: NewApplicationEvent): Promise<DeliveryResult> // telegram
  sendApplicantConfirmation(e: ApplicantConfirmation): Promise<DeliveryResult> // email
  alertOwnerResumeFailed(e: ResumeFailedAlert): Promise<DeliveryResult> // telegram + email
}
