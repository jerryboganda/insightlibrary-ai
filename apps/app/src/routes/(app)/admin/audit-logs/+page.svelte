<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import {
		ShieldCheck,
		Search,
		Download,
		AlertTriangle,
		Info,
		ShieldAlert,
		Eye,
		X,
		Fingerprint,
		Clock
	} from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { AuditLog } from '@insightlibrary/schemas';

	// Live immutable audit stream from the real API. The schema carries
	// { actor, action, target, timestamp, severity } — severity (info/warning/critical)
	// drives the row badges in place of the prototype's success/failure flag.
	const audit = createQuery({ queryKey: ['audit'], queryFn: () => api.listAudit() });

	let searchQuery = $state('');
	let selected = $state<AuditLog | null>(null);

	const logs = $derived($audit.data ?? []);

	const filtered = $derived(
		logs.filter((log) => {
			const q = searchQuery.trim().toLowerCase();
			if (!q) return true;
			return (
				log.actor.toLowerCase().includes(q) ||
				log.action.toLowerCase().includes(q) ||
				log.target.toLowerCase().includes(q)
			);
		})
	);

	const critical = $derived(logs.filter((l) => l.severity === 'critical').length);

	// Severity → badge + icon styling (info neutral, warning amber, critical rose).
	function severityMeta(severity: AuditLog['severity']) {
		if (severity === 'critical')
			return {
				icon: ShieldAlert,
				badge: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
				dot: 'bg-rose-500',
				label: 'Critical'
			};
		if (severity === 'warning')
			return {
				icon: AlertTriangle,
				badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
				dot: 'bg-amber-500',
				label: 'Warning'
			};
		return {
			icon: Info,
			badge: 'bg-zinc-800 text-zinc-300 border-zinc-700',
			dot: 'bg-zinc-500',
			label: 'Info'
		};
	}

	// Format an ISO timestamp to a compact local time; passes through pre-formatted strings.
	function fmtTime(ts: string): string {
		const d = new Date(ts);
		if (Number.isNaN(d.getTime())) return ts;
		return d.toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
</script>

<main class="relative w-full overflow-y-auto">
	<div class="mx-auto max-w-6xl space-y-8">
		<header class="flex flex-col justify-between gap-4 md:flex-row md:items-center">
			<div>
				<h1 class="flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-100">
					<ShieldCheck class="h-6 w-6 text-indigo-400" />
					Compliance &amp; Audit Logs
				</h1>
				<p class="mt-1 text-sm text-zinc-400">
					Immutable SOC2-compliant logging for all system, AI, and user actions.
				</p>
			</div>
			<div class="flex items-center gap-3">
				<button
					class="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
				>
					<Download class="h-4 w-4" /> Export CSV
				</button>
			</div>
		</header>

		<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
			<div
				class="flex flex-col justify-between gap-4 border-b border-zinc-800 bg-zinc-900/50 px-6 py-4 sm:flex-row sm:items-center"
			>
				<div class="relative">
					<Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
					<input
						type="text"
						placeholder="Search events..."
						bind:value={searchQuery}
						class="w-64 rounded-md border border-zinc-800 bg-zinc-950 py-1.5 pr-3 pl-9 text-xs text-zinc-300 focus:border-indigo-500/50 focus:outline-none md:w-80"
					/>
				</div>
				{#if !$audit.isLoading}
					<div class="flex items-center gap-4 font-mono text-xs text-zinc-500">
						<span>{filtered.length} events</span>
						{#if critical > 0}
							<span class="flex items-center gap-1.5 text-rose-400">
								<span class="h-1.5 w-1.5 rounded-full bg-rose-500"></span>
								{critical} critical
							</span>
						{/if}
					</div>
				{/if}
			</div>

			{#if $audit.isLoading}
				<div class="space-y-3 p-6">
					{#each Array(5) as _, i (i)}
						<Skeleton class="h-11 rounded-md" />
					{/each}
				</div>
			{:else if filtered.length === 0}
				<div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
					<ShieldCheck class="h-8 w-8 text-zinc-600" />
					<p class="text-sm text-zinc-400">
						{searchQuery ? 'No events match your search.' : 'No audit events recorded yet.'}
					</p>
					<p class="text-xs text-zinc-600">
						System, AI, and user actions will appear here as they occur.
					</p>
				</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead
							class="border-b border-zinc-800/50 bg-zinc-950/80 text-xs font-medium tracking-wider text-zinc-500 uppercase"
						>
							<tr>
								<th class="px-6 py-4">Time</th>
								<th class="px-6 py-4">Actor</th>
								<th class="px-6 py-4">Action</th>
								<th class="px-6 py-4">Target</th>
								<th class="px-6 py-4">Severity</th>
								<th class="px-6 py-4 text-right">Details</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-zinc-800/50 font-mono text-xs text-zinc-300">
							{#each filtered as log, i (log.id)}
								{@const meta = severityMeta(log.severity)}
								<tr in:fade={{ delay: i * 25 }} class="transition-colors hover:bg-zinc-900/40">
									<td class="px-6 py-4 whitespace-nowrap text-zinc-500">{fmtTime(log.timestamp)}</td>
									<td class="px-6 py-4 font-sans text-zinc-200">{log.actor}</td>
									<td class="px-6 py-4">
										<span class={cn('rounded border px-2 py-0.5', meta.badge)}>{log.action}</span>
									</td>
									<td class="px-6 py-4 text-zinc-400">{log.target}</td>
									<td class="px-6 py-4">
										<span
											class={cn(
												'flex items-center gap-1.5 font-sans font-medium',
												log.severity === 'critical'
													? 'text-rose-400'
													: log.severity === 'warning'
														? 'text-amber-400'
														: 'text-zinc-400'
											)}
										>
											<meta.icon class="h-3.5 w-3.5" />
											{meta.label}
										</span>
									</td>
									<td class="px-6 py-4 text-right">
										<button
											onclick={() => (selected = log)}
											class="text-zinc-500 transition-colors hover:text-indigo-300"
											aria-label="View event details"
										>
											<Eye class="h-4 w-4" />
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</div>

	<!-- Event detail slide-over -->
	{#if selected}
		{@const meta = severityMeta(selected.severity)}
		<div
			transition:fly={{ x: 400, duration: 300, opacity: 1 }}
			class="fixed top-0 right-0 z-40 flex h-full w-full max-w-sm flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl"
		>
			<div
				class="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-4"
			>
				<h2 class="flex items-center gap-2 font-semibold text-zinc-100">
					<Fingerprint class="h-4 w-4 text-indigo-400" />
					Event Detail
				</h2>
				<button
					onclick={() => (selected = null)}
					class="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
				>
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="flex-1 space-y-6 overflow-y-auto p-6">
				<div class="flex items-center justify-between">
					<span
						class={cn('flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium', meta.badge)}
					>
						<meta.icon class="h-3.5 w-3.5" />
						{meta.label}
					</span>
					<span class="flex items-center gap-1.5 font-mono text-xs text-zinc-500">
						<Clock class="h-3.5 w-3.5" />
						{fmtTime(selected.timestamp)}
					</span>
				</div>

				<div class="space-y-4">
					<div class="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-4">
						<div class="mb-1 text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
							Action
						</div>
						<div class="font-mono text-sm text-zinc-200">{selected.action}</div>
					</div>

					<div class="grid grid-cols-1 gap-4">
						<div class="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-4">
							<div class="mb-1 text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
								Actor
							</div>
							<div class="text-sm text-zinc-300">{selected.actor}</div>
						</div>
						<div class="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-4">
							<div class="mb-1 text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
								Target Resource
							</div>
							<div class="font-mono text-sm text-zinc-300">{selected.target}</div>
						</div>
						<div class="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-4">
							<div class="mb-1 text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
								Event ID
							</div>
							<div class="font-mono text-sm text-zinc-500">{selected.id}</div>
						</div>
					</div>
				</div>

				<div
					class="flex gap-3 rounded-md border border-indigo-500/20 bg-indigo-500/5 p-3 text-xs leading-relaxed text-indigo-200/70"
				>
					<ShieldCheck class="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" />
					This record is part of an immutable, append-only ledger and cannot be edited or deleted,
					in line with SOC2 retention requirements.
				</div>
			</div>

			<div class="shrink-0 border-t border-zinc-800 bg-zinc-900/50 p-4">
				<button
					onclick={() => (selected = null)}
					class="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
				>
					Close
				</button>
			</div>
		</div>
	{/if}
</main>
