<script lang="ts">
	import { page } from '$app/state';
	import { createQuery } from '@tanstack/svelte-query';
	import {
		Bell,
		Command,
		ChevronRight,
		CheckCircle2,
		AlertTriangle,
		Sparkles,
		ArrowRightCircle
	} from '@lucide/svelte';
	import { api } from '$lib/api';

	/** Derive breadcrumbs from the current path (title-cased segments). */
	const crumbs = $derived.by(() => {
		const parts = page.url.pathname.split('/').filter(Boolean);
		const labels = parts.map((p) =>
			p.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
		);
		return ['InsightLibrary', ...labels];
	});

	let open = $state(false);

	const notifications = createQuery({
		queryKey: ['notifications'],
		queryFn: () => api.listNotifications()
	});

	const iconFor = (type: string) => {
		switch (type) {
			case 'ssot_merge':
				return { icon: CheckCircle2, class: 'text-emerald-400' };
			case 'conflict':
				return { icon: AlertTriangle, class: 'text-rose-400' };
			case 'novelty':
				return { icon: Sparkles, class: 'text-indigo-400' };
			default:
				return { icon: AlertTriangle, class: 'text-amber-400' };
		}
	};

	const unread = $derived($notifications.data?.filter((n) => !n.read).length ?? 0);
</script>

<svelte:window onclick={() => (open = false)} />

<header
	class="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-zinc-800/60 bg-zinc-950/80 px-4 backdrop-blur-md"
>
	<div class="ml-2 flex items-center gap-1 truncate text-sm font-medium text-zinc-400">
		{#each crumbs as crumb, i (crumb + i)}
			<span class={i === crumbs.length - 1 ? 'text-zinc-100' : ''}>{crumb}</span>
			{#if i < crumbs.length - 1}<ChevronRight class="h-4 w-4" />{/if}
		{/each}
	</div>

	<div class="flex items-center gap-4">
		<a
			href="/search"
			class="hidden items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200 md:flex"
		>
			<Command class="h-3.5 w-3.5" />
			<span>Search Graph or SSOT...</span>
			<span class="ml-4 rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px]">⌘ K</span>
		</a>

		<div class="relative">
			<button
				onclick={(e) => {
					e.stopPropagation();
					open = !open;
				}}
				class="relative rounded-full p-2 text-zinc-400 transition-colors hover:bg-zinc-800/50 hover:text-zinc-100"
				aria-label="Notifications"
			>
				<Bell class="h-4 w-4" />
				{#if unread > 0}
					<span class="absolute top-1.5 right-1.5 h-2 w-2 rounded-full border-2 border-zinc-950 bg-indigo-500"></span>
				{/if}
			</button>

			{#if open}
				<div
					class="absolute right-0 mt-2 w-80 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl md:w-96"
					role="dialog"
					tabindex="-1"
					onclick={(e) => e.stopPropagation()}
					onkeydown={() => {}}
				>
					<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/40 p-4">
						<div class="flex items-center gap-2">
							<h3 class="text-sm font-semibold text-zinc-100">Notifications</h3>
							{#if unread}
								<span class="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400">{unread} new</span>
							{/if}
						</div>
					</div>
					<div class="max-h-[400px] divide-y divide-zinc-800/60 overflow-y-auto">
						{#each $notifications.data ?? [] as n (n.id)}
							{@const meta = iconFor(n.type)}
							<div class="flex gap-3 p-4 transition-colors hover:bg-zinc-900/30 {!n.read ? 'bg-indigo-950/10' : ''}">
								<div class="mt-0.5 shrink-0 {meta.class}"><meta.icon class="h-4 w-4" /></div>
								<div class="min-w-0 flex-1">
									<div class="mb-1 flex items-start justify-between gap-2">
										<h4 class="truncate pr-2 text-sm {!n.read ? 'font-medium text-zinc-100' : 'text-zinc-300'}">{n.title}</h4>
										<span class="pt-0.5 text-[10px] whitespace-nowrap text-zinc-500">{n.time}</span>
									</div>
									<p class="line-clamp-2 text-xs leading-snug text-zinc-400">{n.description}</p>
									{#if n.action}
										<div class="mt-2 flex items-center gap-2 text-xs font-medium text-indigo-400">
											{n.action} <ArrowRightCircle class="h-3 w-3" />
										</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
					<div class="border-t border-zinc-800 bg-zinc-900/20 p-3">
						<a href="/notifications" class="flex w-full items-center justify-center gap-2 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200">
							View all notifications <ChevronRight class="h-3 w-3" />
						</a>
					</div>
				</div>
			{/if}
		</div>
	</div>
</header>
