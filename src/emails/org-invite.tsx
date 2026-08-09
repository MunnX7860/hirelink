import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components'

/**
 * `org_invite` — Phase 4 workspace invitation (docs/05 §4.9, docs/09 §2).
 * Best-effort delivery: the join URL is always shown for manual sharing in the UI too.
 * Mobile-first, 520px max, system fonts, no remote images (docs/09 §3).
 */
export function OrgInviteEmail({
  orgName,
  inviterName,
  role,
  joinUrl,
}: {
  orgName: string
  inviterName: string
  role: string
  joinUrl: string
}) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{`${inviterName} invited you to ${orgName} on HireLink`}</Preview>
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
            You’re invited to {orgName} 👋
          </Heading>
          <Text
            style={{ color: '#0f172a', fontSize: '16px', lineHeight: '24px', margin: '0 0 12px' }}
          >
            {inviterName} invited you to join the <strong>{orgName}</strong> hiring workspace on
            HireLink as {role === 'admin' ? 'an admin' : 'a member'}.
          </Text>
          <Text
            style={{ color: '#0f172a', fontSize: '16px', lineHeight: '24px', margin: '0 0 20px' }}
          >
            Sign in with the Google account this email was sent to, then open this link within 7
            days:
          </Text>
          <Section style={{ textAlign: 'center', margin: '0 0 20px' }}>
            <Button
              href={joinUrl}
              style={{
                backgroundColor: '#4f46e5',
                borderRadius: '10px',
                color: '#ffffff',
                display: 'inline-block',
                fontSize: '16px',
                fontWeight: 600,
                padding: '12px 24px',
                textDecoration: 'none',
              }}
            >
              Accept invitation
            </Button>
          </Section>
          <Text
            style={{
              color: '#475569',
              fontSize: '13px',
              lineHeight: '20px',
              margin: '0 0 4px',
              wordBreak: 'break-all',
            }}
          >
            {joinUrl}
          </Text>
          <Section
            style={{ borderTop: '1px solid #e2e8f0', marginTop: '24px', paddingTop: '16px' }}
          >
            <Text style={{ color: '#475569', fontSize: '12px', lineHeight: '18px', margin: 0 }}>
              This link works once and expires in 7 days. If you weren’t expecting this, you can
              ignore it — nothing is joined until you accept.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
