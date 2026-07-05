/**
 * Public surface of the multi-provider LLM layer. Import from here, never from
 * a vendor SDK or an individual adapter file.
 */
export * from './types';
export { getRouter } from './router';
export type { RouteContext, CallOptions, JsonCallOptions } from './router';
export {
	PROVIDERS,
	anyProviderConfigured,
	firstConfiguredProvider,
	defaultProviderForTask,
	modelFor,
	type ConfigurableProvider,
	type ProviderMeta
} from './config';
export { encryptSecret, decryptSecret, encryptionAvailable, keyHint } from './crypto';
