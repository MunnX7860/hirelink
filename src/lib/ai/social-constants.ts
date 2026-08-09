/**
 * Social-post enums — shared client/server (zod-free; the generator UI imports
 * these without dragging prompt templates into the browser bundle).
 * Canonical values: docs/10 §3.
 */
export const SOCIAL_TONES = ['friendly', 'professional', 'urgent'] as const
export type SocialTone = (typeof SOCIAL_TONES)[number]
export const SOCIAL_PLATFORMS = ['whatsapp', 'instagram', 'linkedin'] as const
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]
