import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components'

/** `owner_resume_failed` — docs/09 §2: Drive upload failed after retries; application itself succeeded. */
export function OwnerResumeFailedEmail({
  jobTitle,
  applicantName,
  settingsUrl,
}: {
  jobTitle: string
  applicantName: string
  settingsUrl: string
}) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{`Resume upload failed — ${jobTitle}`}</Preview>
      <Body
        style={{
          backgroundColor: '#f8fafc',
          fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          margin: 0,
          padding: '24px 12px',
        }}
      >
        <Container
          style={{
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            maxWidth: '520px',
            margin: '0 auto',
            padding: '24px',
          }}
        >
          <Heading as="h1" style={{ color: '#0f172a', fontSize: '20px', margin: '0 0 16px' }}>
            Resume upload failed ⚠
          </Heading>
          <Text
            style={{ color: '#0f172a', fontSize: '16px', lineHeight: '24px', margin: '0 0 12px' }}
          >
            <strong>{applicantName}</strong> applied for <strong>{jobTitle}</strong>. The
            application was saved, but the resume could not be stored in Google Drive.
          </Text>
          <Text
            style={{ color: '#0f172a', fontSize: '16px', lineHeight: '24px', margin: '0 0 12px' }}
          >
            Check your Google Drive connection:{' '}
            <a href={settingsUrl} style={{ color: '#6366f1' }}>
              {settingsUrl}
            </a>
          </Text>
          <Section
            style={{ borderTop: '1px solid #e2e8f0', marginTop: '24px', paddingTop: '16px' }}
          >
            <Text style={{ color: '#475569', fontSize: '12px', lineHeight: '18px', margin: 0 }}>
              HireLink notification. You can ask the applicant to resubmit their resume through the
              same hiring link.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
