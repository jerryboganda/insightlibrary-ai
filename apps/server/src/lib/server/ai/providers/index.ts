/**
 * Public surface of the multi-provider LLM layer. Import from here, never from
 * a vendor SDK or an individual adapter file.
 */
export * from './types';
export { getRouter } from './router';
export type { RouteContext, CallOptions, JsonCallOptions } from './router';
export {
	PROVIDERS,
	VENDOR_KEYS,
	isVendorId,
	anyProviderConfigured,
	firstConfiguredProvider,
	defaultProviderForTask,
	modelFor,
	getEnv,
	type ConfigurableProvider,
	type ProviderMeta,
	type VendorId,
	type VendorMeta
} from './config';
export { getOrgAiRouting, getOrgAiRoutingCached, invalidateOrgAiRouting, type OrgAiRouting } from './org-routing';
export { encryptSecret, decryptSecret, encryptionAvailable, keyHint } from './crypto';
