import type { z } from 'zod'

export {
  JOB_STATUSES,
  JobStatus,
  FormFieldRule,
  FormConfig,
  CreateJobInput,
  UpdateJobInput,
  canTransitionJob,
} from '@/features/jobs/schemas'
export type {
  JobStatusValue,
  FormFieldRuleValue,
  FormConfigValue,
  CreateJobInputValue,
  JobRow,
  PublicJob,
} from '@/features/jobs/schemas'

import type { UpdateJobInput } from '@/features/jobs/schemas'
export type UpdateJobInputType = z.infer<typeof UpdateJobInput>
