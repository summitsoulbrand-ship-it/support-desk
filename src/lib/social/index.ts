/**
 * Social Comments Module
 * Facebook + Instagram comment management
 */

// Types
export * from './types';

// Meta API Client
export { MetaClient, createMetaClient, META_REQUIRED_SCOPES } from './meta-client';

// Automation Rules Engine
export {
  evaluateRule,
  processCommentRules,
  testRule,
} from './rules-engine';

// Sync Functions
export {
  syncSocialAccount,
  syncAllSocialAccounts,
  syncFacebookPage,
  syncInstagramAccount,
  processWebhookEvent,
} from './sync';
