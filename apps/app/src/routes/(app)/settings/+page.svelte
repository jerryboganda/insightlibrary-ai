<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Key,
		Shield,
		Settings2,
		Bell,
		MonitorSmartphone,
		Check,
		Trash2,
		ExternalLink,
		LogOut,
		AlertTriangle
	} from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import type { Component } from 'svelte';
	import { cn } from '$lib/utils';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { api } from '$lib/api';
	import { authClient } from '$lib/auth-client';
	import { Skeleton } from '$lib/components/ui';
	import type { AiKeyInput, ProviderId } from '@insightlibrary/schemas';

	let activeTab = $state('My AI Keys');

	const tabs: { icon: Component; label: string }[] = [
		{ icon: Key, label: 'My AI Keys' },
		{ icon: Shield, label: 'Sessions & Security' },
		{ icon: Bell, label: 'Notifications' },
		{ icon: Settings2, label: 'Workspace Settings' }
	];

	// ── My AI Keys (personal BYO keys, scope 'user') ───────────────────────────
	const queryClient = useQueryClient();
	const providers = createQuery({ queryKey: ['ai-providers'], queryFn: () => api.getAiProviders() });
	const invalidateProviders = () => queryClient.invalidateQueries({ queryKey: ['ai-providers'] });

	const chatProviders = $derived(($providers.data?.providers ?? []).filter((p) => p.kind !== 'vendor'));

	const saveKeyMut = createMutation({
		mutationFn: (v: AiKeyInput) => api.saveAiKey(v),
		onSuccess: invalidateProviders
	});
	const deleteKeyMut = createMutation({
		mutationFn: (p: ProviderId) => api.deleteAiKey(p, 'user'),
		onSuccess: invalidateProviders
	});

	let drafts = $state<Record<string, string>>({});
	function savePersonalKey(id: ProviderId) {
		const key = drafts[id]?.trim();
		if (!key) return;
		$saveKeyMut.mutate({ provider: id, apiKey: key, scope: 'user' });
		drafts[id] = '';
	}

	// ── Active sessions (better-auth core session management) ─────────────────
	type SessionRow = {
		id: string;
		token: string;
		createdAt: string | Date;
		expiresAt: string | Date;
		ipAddress?: string | null;
		userAgent?: string | null;
	};
	let sessions = $state<SessionRow[]>([]);
	let currentToken = $state<string | null>(null);
	let sessionsLoading = $state(true);
	let sessionsError = $state('');
	let sessionsBusy = $state(false);

	async function loadSessions() {
		sessionsLoading = true;
		sessionsError = '';
		try {
			const [list, current] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
			if (list.error) throw new Error(list.error.message ?? 'Failed to list sessions');
			sessions = (list.data ?? []) as SessionRow[];
			currentToken = current.data?.session?.token ?? null;
		} catch (e) {
			sessions = [];
			sessionsError = e instanceof Error ? e.message : 'Session management is unavailable on this server.';
		} finally {
			sessionsLoading = false;
		}
	}
	onMount(loadSessions);

	async function revokeSession(token: string) {
		sessionsBusy = true;
		try {
			await authClient.revokeSession({ token });
			await loadSessions();
		} finally {
			sessionsBusy = false;
		}
	}
	async function revokeOthers() {
		sessionsBusy = true;
		try {
			await authClient.revokeOtherSessions();
			await loadSessions();
		} finally {
			sessionsBusy = false;
		}
	}

	/** Human-ish device label from a raw user agent. */
	function deviceLabel(ua: string | null | undefined): string {
		if (!ua) return 'Unknown device';
		const browser = /Edg\//.test(ua)
			? 'Edge'
			: /Chrome\//.test(ua)
				? 'Chrome'
				: /Firefox\//.test(ua)
					? 'Firefox'
					: /Safari\//.test(ua)
						? 'Safari'
						: /Tauri|wry/i.test(ua)
							? 'Desktop app'
							: 'Browser';
		const os = /Windows/.test(ua)
			? 'Windows'
			: /Mac OS X|Macintosh/.test(ua)
				? 'macOS'
				: /Android/.test(ua)
					? 'Android'
					: /iPhone|iPad|iOS/.test(ua)
						? 'iOS'
						: /Linux/.test(ua)
							? 'Linux'
							: '';
		return os ? `${browser} · ${os}` : browser;
	}
	const fmtDate = (d: string | Date) => new Date(d).toLocaleString();

	// ── Workspace settings deep links (org-level config lives in Admin) ───────
	const adminLinks: { label: string; description: string; href: string }[] = [
		{ label: 'Users & Roles', description: 'Invite members, assign roles', href: '/admin/users' },
		{ label: 'API Keys & Integrations', description: 'Workspace API keys and webhooks', href: '/admin/settings/integrations' },
		{ label: 'AI Providers & Routing', description: 'Workspace AI keys, model routing', href: '/admin/settings/ai' },
		{ label: 'Governance & Review', description: 'Refinery thresholds, review policy', href: '/admin/settings/governance' },
		{ label: 'AI Usage / FinOps', description: 'Spend, metering, budget limits', href: '/admin/settings/finops' },
		{ label: 'Storage & Indices', description: 'Vector index, object storage', href: '/admin/settings/storage' },
		{ label: 'Billing', description: 'Plan and payment', href: '/admin/settings/billing' }
	];

	// ── Notification preferences (persisted via /api/preferences) ─────────────
	type NotifyPrefs = {
		processingComplete: boolean;
		reviewQueue: boolean;
		weeklyDigest: boolean;
		webhookFailures: boolean;
		emailEnabled: boolean;
	};
	const NOTIFY_DEFAULTS: NotifyPrefs = {
		processingComplete: true,
		reviewQueue: true,
		weeklyDigest: false,
		webhookFailures: true,
		emailEnabled: false
	};
	const notifyRows: { key: keyof NotifyPrefs; label: string; description: string }[] = [
		{
			key: 'processingComplete',
			label: 'Document processing complete',
			description: 'When a document finishes ingesting and is ready to use.'
		},
		{
			key: 'reviewQueue',
			label: 'Review queue items',
			description: 'When correlation surfaces a conflict that needs review.'
		},
		{
			key: 'weeklyDigest',
			label: 'Weekly digest',
			description: 'A weekly summary of library and knowledge activity.'
		},
		{
			key: 'webhookFailures',
			label: 'Webhook delivery failures',
			description: 'When an outbound webhook fails to deliver.'
		},
		{
			key: 'emailEnabled',
			label: 'Email notifications',
			description: 'Also send the above as email, where the server is configured for it.'
		}
	];
	let notify = $state<NotifyPrefs>({ ...NOTIFY_DEFAULTS });
	let notifyLoading = $state(true);
	let notifySaving = $state(false);
	let notifySaved = $state(false);
	let notifyError = $state('');

	async function loadNotifyPrefs() {
		notifyLoading = true;
		try {
			const prefs = await api.getPreferences();
			const stored = (prefs.notifications ?? {}) as Partial<NotifyPrefs>;
			notify = { ...NOTIFY_DEFAULTS, ...stored };
		} catch {
			notify = { ...NOTIFY_DEFAULTS };
		} finally {
			notifyLoading = false;
		}
	}
	onMount(loadNotifyPrefs);

	async function saveNotifyPrefs() {
		notifySaving = true;
		notifyError = '';
		notifySaved = false;
		try {
			await api.savePreferences({ notifications: { ...notify } });
			notifySaved = true;
		} catch (e) {
			notifyError = e instanceof Error ? e.message : 'Could not save preferences.';
		} finally {
			notifySaving = false;
		}
	}
</script>

<main class="w-full overflow-y-auto">
	<div class="mx-auto flex max-w-5xl flex-col gap-8 md:flex-row">
		<!-- Settings Nav -->
		<aside class="w-full shrink-0 space-y-1 md:w-64">
			<h2 class="mb-3 px-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
				My Settings
			</h2>
			{#each tabs as item (item.label)}
				{@const Icon = item.icon}
				<button
					onclick={() => (activeTab = item.label)}
					class={cn(
						'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
						activeTab === item.label
							? 'bg-indigo-500/10 text-indigo-300'
							: 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
					)}
				>
					<Icon class="h-4 w-4" />
					{item.label}
				</button>
			{/each}
		</aside>

		<!-- Settings Content -->
		<div class="flex-1 space-y-6">
			{#if activeTab === 'My AI Keys'}
				<div
					class="overflow-hidden rounded-xl border border-zinc-800 glass-panel"
					in:fly={{ y: 8, duration: 300 }}
				>
					<div class="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
						<h2 class="text-lg font-semibold text-zinc-200">Personal AI Keys</h2>
						<p class="text-sm text-zinc-500">
							Bring your own API key for the copilot. Personal keys take precedence over workspace
							keys for your requests, are encrypted at rest, and never reach the browser.
						</p>
					</div>
					{#if $providers.isLoading}
						<div class="space-y-3 p-6">
							{#each Array(4) as _, i (i)}
								<Skeleton class="h-16 rounded-lg" />
							{/each}
						</div>
					{:else if $providers.isError}
						<div class="flex items-center gap-2 p-6 text-sm text-rose-300">
							<AlertTriangle class="h-4 w-4" /> Could not load provider status.
						</div>
					{:else}
						<div class="divide-y divide-zinc-800/60">
							{#each chatProviders as p (p.id)}
								<div class="p-5">
									<div class="flex items-center justify-between">
										<div>
											<h3 class="text-sm font-semibold text-zinc-100">{p.label}</h3>
											<p class="mt-0.5 text-xs text-zinc-500">
												{#if p.keyStored}
													<span class="text-emerald-400">Key on file {p.hint}</span>
													<span class="text-zinc-600"> (personal or workspace)</span>
												{:else if p.envConfigured}
													<span class="text-sky-400">Provided by the server</span>
												{:else}
													Not configured
												{/if}
											</p>
										</div>
										{#if p.keyStored}
											<button
												onclick={() => $deleteKeyMut.mutate(p.id)}
												disabled={$deleteKeyMut.isPending}
												class="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-40"
												title="Removes your personal key for this provider"
											>
												<Trash2 class="h-3.5 w-3.5" /> Remove my key
											</button>
										{/if}
									</div>
									<div class="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
										<input
											type="password"
											placeholder="Paste personal API key…"
											bind:value={drafts[p.id]}
											class="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none"
										/>
										<button
											onclick={() => savePersonalKey(p.id)}
											disabled={!drafts[p.id]?.trim() || $saveKeyMut.isPending}
											class="flex items-center justify-center gap-1.5 rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
										>
											<Check class="h-4 w-4" /> Save
										</button>
									</div>
								</div>
							{/each}
						</div>
						{#if $saveKeyMut.isError || $deleteKeyMut.isError}
							<p class="px-6 pb-4 text-xs text-rose-400">
								{($saveKeyMut.error ?? $deleteKeyMut.error) instanceof Error
									? ($saveKeyMut.error ?? $deleteKeyMut.error)?.message
									: 'Operation failed — you may need to sign in.'}
							</p>
						{/if}
					{/if}
				</div>
			{:else if activeTab === 'Sessions & Security'}
				<div
					class="overflow-hidden rounded-xl border border-zinc-800 glass-panel"
					in:fly={{ y: 8, duration: 300 }}
				>
					<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
						<div>
							<h2 class="text-lg font-semibold text-zinc-200">Active Sessions</h2>
							<p class="text-sm text-zinc-500">Devices currently signed in to your account.</p>
						</div>
						{#if sessions.length > 1}
							<button
								onclick={revokeOthers}
								disabled={sessionsBusy}
								class="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-40"
							>
								<LogOut class="h-3.5 w-3.5" /> Sign out other sessions
							</button>
						{/if}
					</div>

					{#if sessionsLoading}
						<div class="space-y-3 p-6">
							{#each Array(2) as _, i (i)}
								<Skeleton class="h-14 rounded-lg" />
							{/each}
						</div>
					{:else if sessionsError}
						<div class="flex items-start gap-2 p-6 text-sm text-zinc-400">
							<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
							<div>
								Session management is unavailable: {sessionsError}
								<span class="block text-xs text-zinc-600">
									(On dev servers without auth configured this is expected.)
								</span>
							</div>
						</div>
					{:else if sessions.length === 0}
						<div class="p-6 text-sm text-zinc-500">No active sessions found.</div>
					{:else}
						<div class="divide-y divide-zinc-800/60">
							{#each sessions as s (s.id)}
								<div class="flex items-center justify-between gap-4 p-5" in:fade={{ duration: 150 }}>
									<div class="flex items-center gap-3">
										<MonitorSmartphone class="h-4 w-4 shrink-0 text-zinc-500" />
										<div>
											<p class="text-sm font-medium text-zinc-200">
												{deviceLabel(s.userAgent)}
												{#if s.token === currentToken}
													<span class="ml-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
														This device
													</span>
												{/if}
											</p>
											<p class="mt-0.5 text-xs text-zinc-500">
												{s.ipAddress || 'IP unknown'} · signed in {fmtDate(s.createdAt)} · expires
												{fmtDate(s.expiresAt)}
											</p>
										</div>
									</div>
									{#if s.token !== currentToken}
										<button
											onclick={() => revokeSession(s.token)}
											disabled={sessionsBusy}
											class="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-40"
										>
											Revoke
										</button>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{:else if activeTab === 'Notifications'}
				<div
					class="overflow-hidden rounded-xl border border-zinc-800 glass-panel"
					in:fly={{ y: 8, duration: 300 }}
				>
					<div class="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
						<h2 class="text-lg font-semibold text-zinc-200">Notifications</h2>
						<p class="text-sm text-zinc-500">
							Choose which events create in-app notifications, and whether to also receive email.
						</p>
					</div>
					{#if notifyLoading}
						<div class="space-y-3 p-6">
							{#each Array(4) as _, i (i)}
								<Skeleton class="h-12 rounded-lg" />
							{/each}
						</div>
					{:else}
						<div class="divide-y divide-zinc-800/60">
							{#each notifyRows as row (row.key)}
								<label class="flex cursor-pointer items-center justify-between gap-4 p-5">
									<div>
										<p class="text-sm font-medium text-zinc-200">{row.label}</p>
										<p class="mt-0.5 text-xs text-zinc-500">{row.description}</p>
									</div>
									<input
										type="checkbox"
										bind:checked={notify[row.key]}
										class="h-4 w-4 shrink-0 accent-indigo-500"
									/>
								</label>
							{/each}
						</div>
						<div class="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
							{#if notifyError}
								<span class="text-xs text-rose-400">{notifyError}</span>
							{/if}
							{#if notifySaved}
								<span class="flex items-center gap-1 text-xs text-emerald-400">
									<Check class="h-3.5 w-3.5" /> Saved
								</span>
							{/if}
							<button
								onclick={saveNotifyPrefs}
								disabled={notifySaving}
								class="flex items-center gap-1.5 rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
							>
								<Check class="h-4 w-4" /> Save preferences
							</button>
						</div>
					{/if}
				</div>
			{:else}
				<div
					class="overflow-hidden rounded-xl border border-zinc-800 glass-panel"
					in:fly={{ y: 8, duration: 300 }}
				>
					<div class="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
						<h2 class="text-lg font-semibold text-zinc-200">Workspace Settings</h2>
						<p class="text-sm text-zinc-500">
							Workspace-wide configuration (users, governance, AI routing, billing) is managed in
							the Admin console and requires an admin role.
						</p>
					</div>
					<div class="divide-y divide-zinc-800/60">
						{#each adminLinks as link (link.href)}
							<a
								href={link.href}
								class="flex items-center justify-between p-4 transition-colors hover:bg-zinc-900/50"
							>
								<div>
									<p class="text-sm font-medium text-zinc-200">{link.label}</p>
									<p class="mt-0.5 text-xs text-zinc-500">{link.description}</p>
								</div>
								<ExternalLink class="h-4 w-4 text-zinc-600" />
							</a>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	</div>
</main>
