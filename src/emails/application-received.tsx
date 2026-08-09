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

/**
 * `application_received` — docs/09 §2.1 (the Phase 1 transactional email).
 * Mobile-first, 520px max, system fonts, no remote images, plaintext auto-derived (09 §3).
 */
export function ApplicationReceivedEmail({
  candidateFirstName,
  jobTitle,
  companyLabel,
}: {
  candidateFirstName: string
  jobTitle: string
  companyLabel: string
}) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{`Application received — ${jobTitle}`}</Preview>
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
            We got your application ✅
          </Heading>
          <Text
            style={{ color: '#0f172a', fontSize: '16px', lineHeight: '24px', margin: '0 0 12px' }}
          >
            Hi {candidateFirstName},
          </Text>
          <Text
            style={{ color: '#0f172a', fontSize: '16px', lineHeight: '24px', margin: '0 0 12px' }}
          >
            Thanks for applying for <strong>{jobTitle}</strong>. {companyLabel} has received your
            application and will review it shortly.
          </Text>
          <Section
            style={{ borderTop: '1px solid #e2e8f0', marginTop: '24px', paddingTop: '16px' }}
          >
            <Text style={{ color: '#475569', fontSize: '12px', lineHeight: '18px', margin: 0 }}>
              You received this because you applied to “{jobTitle}” via {companyLabel}. This is a
              transactional message about your application.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
