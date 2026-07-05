<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import {
		Bell,
		CheckCircle2,
		Sparkles,
		AlertTriangle,
		MessageSquareWarning,
		Archive,
		Settings,
		Search,
		MoreVertical,
		X,
		Mail,
		Save,
		Loader2
	} from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import type { Component } from 'svelte';
	import type { Notification } from '@insightlibrary/schemas';
	import { api } from '$lib/api';
	import { goto } from '$app/navigation';
	import { cn } from '$lib/utils';

	const qc = useQueryClient();
	const notifications = createQuery({
		queryKey: ['notifications'],
		queryFn: () => api.listNotifications()
	});

	const markAll = createMutation({
		mutationFn: () => api.markAllNotificationsRead(),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] })
	});

	// Archive a single notification, then refresh the list.
	const archive = createMutation({
		mutationFn: (id: string) => api.archiveNotification(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] })
	});

	// Persist notification preferences (no dedicated endpoint — reuse /preferences).
	const savePrefs = createMutation({
		mutationFn: (p: Record<string, unknown>) => api.savePreferences(p),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['preferences'] });
			isSettingsOpen = false;
		}
	});

	// Per-item read state persists server-side via PATCH /api/notifications/[id]
	// (B29) — optimistic cache flip for instant feedback, rolled back on error,
	// so unread state survives reloads.
	const markRead = createMutation({
		mutationFn: ({ id, read }: { id: string; read: boolean }) =>
			api.updateNotification(id, { read }),
		onMutate: async ({ id, read }) => {
			await qc.cancelQueries({ queryKey: ['notifications'] });
			const prev = qc.getQueryData<Notification[]>(['notifications']);
			qc.setQueryData<Notification[]>(['notifications'], (list) =>
				(list ?? []).map((n) => (n.id === id ? { ...n, read } : n))
			);
			return { prev };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev) qc.setQueryData(['notifications'], ctx.prev);
		},
		onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] })
	});

	// The item action button: `action` is a label string. If it names a route
	// (starts with "/") navigate there; otherwise treat the click as "mark read".
	function handleAction(n: Notification) {
		if (n.action && n.action.startsWith('/')) {
			if (!n.read) $markRead.mutate({ id: n.id, read: true });
			goto(n.action);
		} else {
			$markRead.mutate({ id: n.id, read: true });
		}
	}

	// The schema carries only { type } — derive presentation (icon + source label) from it,
	// matching the prototype's per-type styling.
	const typeMeta: Record<
		Notification['type'],
		{ icon: Component; color: string; source: string }
	> = {
		ssot_merge: { icon: CheckCircle2, color: 'text-emerald-400', source: 'SSOT Builder Agent' },
		conflict: { icon: MessageSquareWarning, color: 'text-rose-400', source: 'Delta Extraction' },
		novelty: { icon: Sparkles, color: 'text-indigo-400', source: 'Knowledge Pipeline' },
		alert: { icon: AlertTriangle, color: 'text-amber-400', source: 'System' }
	};

	let search = $state('');
	let activeFilter = $state<'all' | 'unread' | 'ssot' | 'conflicts' | 'system'>('all');
	let activeMenuId = $state<string | null>(null);
	let isSettingsOpen = $state(false);

	const list = $derived($notifications.data ?? []);
	const unreadCount = $derived(list.filter((n) => !n.read).length);
	const conflictCount = $derived(list.filter((n) => n.type === 'conflict').length);

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return list.filter((n) => {
			if (activeFilter === 'unread' && n.read) return false;
			if (activeFilter === 'ssot' && n.type !== 'ssot_merge') return false;
			if (activeFilter === 'conflicts' && n.type !== 'conflict') return false;
			if (activeFilter === 'system' && n.type !== 'alert') return false;
			if (q && !(`${n.title} ${n.description}`.toLowerCase().includes(q))) return false;
			return true;
		});
	});

	// Notification-preference toggles (prototype-only, no endpoint) — local state.
	let emailDelivery = $state(true);
	const prefs = $state({
		ssotMerges: true,
		contradictions: true,
		novelties: true,
		docProcessing: true,
		quotaLimits: true,
		teamWorkspace: false
	});

	function closeMenu() {
		activeMenuId = null;
	}
</script>

<svelte:window onclick={() => activeMenuId !== null && closeMenu()} />

<main class="w-full overflow-y-auto">
	<div class="mx-auto max-w-4xl space-y-6">
		<header
			class="flex flex-col justify-between gap-4 border-b border-zinc-800 pb-6 sm:flex-row sm:items-end"
		>
			<div>
				<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
					<div
						class="flex h-10 w-10 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-500/10"
					>
						<Bell class="h-5 w-5 text-indigo-400" />
					</div>
					Notifications
				</h1>
				<p class="mt-2 ml-1 text-sm text-zinc-400">
					Manage alerts, SSOT updates, and system events.
				</p>
			</div>
			<div class="flex gap-3">
				<button
					onclick={() => $markAll.mutate()}
					disabled={$markAll.isPending || unreadCount === 0}
					class="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 focus:ring-1 focus:ring-zinc-700 focus:outline-none disabled:opacity-50"
				>
					{#if $markAll.isPending}
						<Loader2 class="h-4 w-4 animate-spin" />
					{:else}
						<CheckCircle2 class="h-4 w-4" />
					{/if}
					Mark all as read
				</button>
				<button
					onclick={() => (isSettingsOpen = true)}
					class="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/50 text-zinc-400 transition-colors hover:bg-zinc-800 focus:ring-1 focus:ring-zinc-700 focus:outline-none"
				>
					<Settings class="h-4 w-4" />
				</button>
			</div>
		</header>

		<div class="flex flex-col gap-6 md:flex-row">
			<!-- Filters Sidebar -->
			<div class="flex w-full shrink-0 flex-col gap-1 md:w-64">
				<div class="relative mb-4">
					<Search class="absolute top-2.5 left-3 h-4 w-4 text-zinc-500" />
					<input
						type="text"
						bind:value={search}
						placeholder="Search notifications..."
						class="w-full rounded-md border border-zinc-800 bg-zinc-900 py-2 pr-3 pl-9 text-sm text-zinc-200 placeholder:text-zinc-500 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none"
					/>
				</div>

				<h3 class="mb-2 px-2 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
					Filters
				</h3>

				<button
					onclick={() => (activeFilter = 'all')}
					class={cn(
						'flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors',
						activeFilter === 'all'
							? 'bg-indigo-500/10 text-indigo-400'
							: 'text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200'
					)}
				>
					<span>All Notifications</span>
					<span class="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px]">{list.length}</span>
				</button>
				<button
					onclick={() => (activeFilter = 'unread')}
					class={cn(
						'flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors',
						activeFilter === 'unread'
							? 'bg-indigo-500/10 font-medium text-indigo-400'
							: 'text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200'
					)}
				>
					<span>Unread</span>
					<span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">{unreadCount}</span>
				</button>
				<button
					onclick={() => (activeFilter = 'ssot')}
					class={cn(
						'flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors',
						activeFilter === 'ssot'
							? 'bg-indigo-500/10 font-medium text-indigo-400'
							: 'text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200'
					)}
				>
					<span>SSOT Updates</span>
				</button>
				<button
					onclick={() => (activeFilter = 'conflicts')}
					class={cn(
						'flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors',
						activeFilter === 'conflicts'
							? 'bg-indigo-500/10 font-medium text-indigo-400'
							: 'text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200'
					)}
				>
					<span>Conflicts &amp; Reviews</span>
					{#if conflictCount > 0}
						<span class="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] text-rose-400"
							>{conflictCount}</span
						>
					{/if}
				</button>
				<button
					onclick={() => (activeFilter = 'system')}
					class={cn(
						'flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors',
						activeFilter === 'system'
							? 'bg-indigo-500/10 font-medium text-indigo-400'
							: 'text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200'
					)}
				>
					<span>System Alerts</span>
				</button>
			</div>

			<!-- Notification List -->
			<div
				class="flex-1 divide-y divide-zinc-800/60 overflow-hidden rounded-xl border border-zinc-800 glass-panel"
			>
				{#if $notifications.isLoading}
					{#each Array(4) as _, i (i)}
						<div class="flex gap-4 p-5">
							<div class="mt-1 h-5 w-5 shrink-0 animate-pulse rounded-full bg-zinc-800"></div>
							<div class="flex-1 space-y-2">
								<div class="h-4 w-40 animate-pulse rounded bg-zinc-800"></div>
								<div class="h-3 w-64 animate-pulse rounded bg-zinc-800/70"></div>
							</div>
						</div>
					{/each}
				{:else if filtered.length === 0}
					<div class="p-12 text-center" in:fade={{ duration: 200 }}>
						<Bell class="mx-auto mb-3 h-10 w-10 text-zinc-700" />
						<p class="text-sm text-zinc-400">No notifications match this view.</p>
						<p class="mt-1 text-xs text-zinc-600">Try a different filter or clear your search.</p>
					</div>
				{:else}
					{#each filtered as notification, i (notification.id)}
						{@const meta = typeMeta[notification.type]}
						{@const Icon = meta.icon}
						<div
							class={cn(
								'group flex gap-4 p-5 transition-colors',
								!notification.read ? 'bg-indigo-950/10' : 'hover:bg-zinc-900/30'
							)}
							in:fly={{ y: 8, duration: 200, delay: i * 30 }}
						>
							<div class="mt-1 flex-shrink-0">
								<Icon class={cn('h-5 w-5', meta.color)} />
							</div>

							<div class="min-w-0 flex-1">
								<div class="mb-2 flex items-start justify-between gap-4">
									<div>
										<h4
											class={cn(
												'text-sm',
												!notification.read
													? 'font-semibold text-zinc-100'
													: 'font-medium text-zinc-300'
											)}
										>
											{notification.title}
										</h4>
										<div class="mt-1 flex items-center gap-2">
											<span
												class="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-zinc-500 uppercase"
											>
												{meta.source}
											</span>
											<span class="text-xs text-zinc-500">{notification.time}</span>
										</div>
									</div>

									<div
										class="relative flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100"
									>
										<button
											onclick={(e) => {
												e.stopPropagation();
												$archive.mutate(notification.id);
											}}
											disabled={$archive.isPending}
											class="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50"
											title="Archive"
										>
											<Archive class="h-4 w-4" />
										</button>
										<button
											class="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
											onclick={(e) => {
												e.stopPropagation();
												activeMenuId =
													activeMenuId === notification.id ? null : notification.id;
											}}
										>
											<MoreVertical class="h-4 w-4" />
										</button>

										{#if activeMenuId === notification.id}
											<div
												class="absolute top-full right-0 z-20 mt-1 w-48 rounded-lg border border-zinc-800 bg-zinc-900 py-1 shadow-xl"
												onclick={(e) => e.stopPropagation()}
												onkeydown={(e) => e.stopPropagation()}
												transition:fade={{ duration: 120 }}
												role="menu"
												tabindex="-1"
											>
												<button
													class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
													onclick={() => {
														$markRead.mutate({ id: notification.id, read: !notification.read });
														closeMenu();
													}}
												>
													<CheckCircle2 class="h-4 w-4" />
													{notification.read ? 'Mark as Unread' : 'Mark as Read'}
												</button>
												<button
													class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
													onclick={() => {
														closeMenu();
														isSettingsOpen = true;
													}}
												>
													<Settings class="h-4 w-4" /> Manage this type
												</button>
												<div class="mx-2 my-1 h-px bg-zinc-800"></div>
												<button
													class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-rose-400 transition-colors hover:bg-rose-950/30 hover:text-rose-300"
													onclick={() => {
														$archive.mutate(notification.id);
														closeMenu();
													}}
												>
													<Archive class="h-4 w-4" /> Delete
												</button>
											</div>
										{/if}
									</div>
								</div>

								<p class="text-sm text-zinc-400">{notification.description}</p>

								{#if notification.action}
									<div class="mt-4">
										<button
											onclick={() => handleAction(notification)}
											class="rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-indigo-500/50 hover:text-zinc-100"
										>
											{notification.action}
										</button>
									</div>
								{/if}
							</div>

							{#if !notification.read}
								<div
									class="mt-2 h-2 w-2 shrink-0 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]"
								></div>
							{/if}
						</div>
					{/each}

					<div class="p-6 text-center">
						<p class="text-sm text-zinc-500">No more notifications to show.</p>
					</div>
				{/if}
			</div>
		</div>
	</div>
</main>

<!-- Settings Panel Overlay -->
{#if isSettingsOpen}
	<div
		class="fixed inset-0 z-50 cursor-pointer bg-black/60 backdrop-blur-sm"
		onclick={() => (isSettingsOpen = false)}
		transition:fade={{ duration: 200 }}
		role="presentation"
	></div>
	<div
		class="fixed top-0 right-0 bottom-0 z-50 flex w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl"
		transition:fly={{ x: 400, duration: 300 }}
	>
		<div
			class="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6"
		>
			<h2 class="flex items-center gap-2 text-sm font-semibold text-zinc-100">
				<Settings class="h-4 w-4 text-zinc-400" /> Notification Preferences
			</h2>
			<button
				onclick={() => (isSettingsOpen = false)}
				class="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
			>
				<X class="h-4 w-4" />
			</button>
		</div>

		<div class="flex-1 space-y-8 overflow-y-auto p-6">
			<div>
				<p class="mb-6 text-sm text-zinc-400">
					Choose what events you want to be notified about and how you receive them.
				</p>

				<div
					class="mb-6 flex items-center justify-between rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4"
				>
					<div class="flex items-center gap-3">
						<Mail class="h-5 w-5 text-indigo-400" />
						<div>
							<h3 class="text-sm font-medium text-zinc-100">Global Email Delivery</h3>
							<p class="text-xs text-zinc-400">Receive summary emails for missed notifications</p>
						</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-label="Global Email Delivery" aria-checked={emailDelivery}
						onclick={() => (emailDelivery = !emailDelivery)}
						class={cn(
							'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
							emailDelivery ? 'border-indigo-500 bg-indigo-500' : 'border-zinc-700 bg-zinc-700'
						)}
					>
						<span
							class={cn(
								'absolute top-[2px] h-4 w-4 rounded-full bg-white transition-all',
								emailDelivery ? 'left-[18px]' : 'left-[2px]'
							)}
						></span>
					</button>
				</div>

				<div class="space-y-6">
					<div class="space-y-4">
						<h3 class="text-xs font-semibold tracking-wider text-zinc-500 uppercase">
							Knowledge &amp; SSOT
						</h3>
						{@render toggle(
							'SSOT Merges & Updates',
							'When new knowledge is successfully merged into an SSOT.',
							() => prefs.ssotMerges,
							() => (prefs.ssotMerges = !prefs.ssotMerges)
						)}
						{@render toggle(
							'Contradictions & Conflicts',
							'When sources disagree and require human review.',
							() => prefs.contradictions,
							() => (prefs.contradictions = !prefs.contradictions)
						)}
						{@render toggle(
							'Delta Extraction Novelties',
							'When new unique claims are found in uploaded batches.',
							() => prefs.novelties,
							() => (prefs.novelties = !prefs.novelties)
						)}
					</div>

					<hr class="border-zinc-800" />

					<div class="space-y-4">
						<h3 class="text-xs font-semibold tracking-wider text-zinc-500 uppercase">
							System &amp; Pipeline
						</h3>
						{@render toggle(
							'Document Processing',
							'Success or failure alerts for indexing and OCR jobs.',
							() => prefs.docProcessing,
							() => (prefs.docProcessing = !prefs.docProcessing)
						)}
						{@render toggle(
							'Usage & Quota Limits',
							'Warnings when approaching token or storage limits.',
							() => prefs.quotaLimits,
							() => (prefs.quotaLimits = !prefs.quotaLimits)
						)}
						{@render toggle(
							'Team & Workspace',
							'New members, role changes, and mentions.',
							() => prefs.teamWorkspace,
							() => (prefs.teamWorkspace = !prefs.teamWorkspace)
						)}
					</div>
				</div>
			</div>
		</div>

		<div
			class="flex shrink-0 justify-end gap-3 border-t border-zinc-800 bg-zinc-900/50 p-4"
		>
			<button
				onclick={() => (isSettingsOpen = false)}
				class="rounded-md px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
			>
				Cancel
			</button>
			<button
				onclick={() => $savePrefs.mutate({ emailDelivery, notifications: { ...prefs } })}
				disabled={$savePrefs.isPending}
				class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if $savePrefs.isPending}
					<Loader2 class="h-4 w-4 animate-spin" />
					Saving...
				{:else}
					<Save class="h-4 w-4" /> Save Preferences
				{/if}
			</button>
		</div>
	</div>
{/if}

{#snippet toggle(title: string, description: string, get: () => boolean, onToggle: () => void)}
	<div class="flex items-start justify-between gap-4">
		<div>
			<h4 class="text-sm font-medium text-zinc-200">{title}</h4>
			<p class="mt-0.5 text-xs leading-snug text-zinc-500">{description}</p>
		</div>
		<button
			type="button"
			role="switch"
			aria-label={title}
			aria-checked={get()}
			onclick={onToggle}
			class={cn(
				'relative mt-0.5 h-4 w-8 shrink-0 rounded-full border transition-colors',
				get() ? 'border-indigo-500 bg-indigo-500' : 'border-zinc-700 bg-zinc-800'
			)}
		>
			<span
				class={cn(
					'absolute top-[2px] h-3 w-3 rounded-full transition-all',
					get() ? 'left-[18px] bg-white' : 'left-[2px] bg-zinc-300'
				)}
			></span>
		</button>
	</div>
{/snippet}
