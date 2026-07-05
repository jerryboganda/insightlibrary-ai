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
		Clock,
		ChevronLeft,
		ChevronRight,
		Loader2
	} from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { AuditLog } from '@insightlibrary/schemas';

	// ── Server-side filters + pagination (B32) ─────────────────────────────────
	// GET /api/audit pages and filters in SQL: newest-first, {items,total,limit,offset}.
	const PAGE_SIZE = 50;
	let offset = $state(0);
	let actionFilter = $state('');
	let severityFilter = $state<'' | 'info' | 'warning' | 'critical'>('');
	let fromDate = $state(''); // yyyy-mm-dd from <input type="date">
	let toDate = $state('');

	// Raw input value applied on change/Enter (avoids a query per keystroke).
	let actionInput = $state('');

	// Convert the date inputs to inclusive ISO bounds (local start/end of day).
	function fromIso(): string | undefined {
		if (!fromDate) return undefined;
		const d = new Date(`${fromDate}T00:00:00`);
		return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
	}
	function toIso(): string | undefined {
		if (!toDate) return undefined;
		const d = new Date(`${toDate}T23:59:59.999`);
		return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
	}

	function queryParams() {
		return {
			limit: PAGE_SIZE,
			offset,
			from: fromIso(),
			to: toIso(),
			action: actionFilter || undefined,
			severity: severityFilter || undefined
		};
	}

	const audit = $derived(
		createQuery({
			queryKey: ['audit', offset, actionFilter, severityFilter, fromDate, toDate],
			queryFn: () => api.listAuditPaged(queryParams())
		})
	);

	let selected = $state<AuditLog | null>(null);

	const logs = $derived($audit.data?.items ?? []);
	const total = $derived($audit.data?.total ?? 0);
	const pageStart = $derived(total === 0 ? 0 : offset + 1);
	const pageEnd = $derived(Math.min(offset + PAGE_SIZE, total));
	const hasPrev = $derived(offset > 0);
	const hasNext = $derived(offset + PAGE_SIZE < total);

	function applyActionFilter() {
		actionFilter = actionInput.trim();
		offset = 0;
	}
	function resetPage() {
		offset = 0;
	}

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

	// Runtime audit targets look like "POST /api/documents → 201" — parse them so
	// method/path/status render as structured chips instead of one opaque string.
	function parseTarget(target: string): { method: string; path: string; status: number } | null {
		const m = /^([A-Z]+)\s+(\S+)\s+→\s+(\d{3})$/.exec(target);
		if (!m) return null;
		return { method: m[1], path: m[2], status: Number(m[3]) };
	}

	function statusColor(status: number): string {
		if (status >= 500) return 'text-rose-400';
		if (status >= 400) return 'text-amber-400';
		return 'text-emerald-400';
	}

	// Build a CSV from array-of-rows and trigger a client-side download.
	function downloadCsv(name: string, rows: (string | number)[][]) {
		const csv = rows
			.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
			.join('\n');
		const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		URL.revokeObjectURL(url);
	}

	// Export ALL rows matching the current filters by paging through the API
	// (the endpoint caps at 500/page), not just the visible page.
	let exporting = $state(false);
	const EXPORT_CAP = 10_000;
	async function exportCsv() {
		if (exporting) return;
		exporting = true;
		try {
			const all: AuditLog[] = [];
			let cursor = 0;
			for (;;) {
				const page = await api.listAuditPaged({ ...queryParams(), limit: 500, offset: cursor });
				all.push(...page.items);
				cursor += page.items.length;
				if (page.items.length === 0 || cursor >= page.total || cursor >= EXPORT_CAP) break;
			}
			const header = ['Actor', 'Action', 'Target', 'Severity', 'Timestamp'];
			const body = all.map((l) => [l.actor, l.action, l.target, l.severity, l.timestamp]);
			downloadCsv('audit-logs.csv', [header, ...body]);
		} finally {
			exporting = false;
		}
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
					onclick={exportCsv}
					disabled={total === 0 || exporting}
					class="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{#if exporting}
						<Loader2 class="h-4 w-4 animate-spin" /> Exporting…
					{:else}
						<Download class="h-4 w-4" /> Export CSV
					{/if}
				</button>
			</div>
		</header>

		<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
			<!-- Filter bar: action substring, severity, and date range (all server-side) -->
			<div
				class="flex flex-col justify-between gap-4 border-b border-zinc-800 bg-zinc-900/50 px-6 py-4 lg:flex-row lg:items-center"
			>
				<div class="flex flex-wrap items-center gap-3">
					<form
						onsubmit={(e) => {
							e.preventDefault();
							applyActionFilter();
						}}
						class="relative"
					>
						<Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
						<input
							type="text"
							placeholder="Filter action (e.g. documents.create)…"
							bind:value={actionInput}
							onchange={applyActionFilter}
							class="w-64 rounded-md border border-zinc-800 bg-zinc-950 py-1.5 pr-3 pl-9 text-xs text-zinc-300 focus:border-indigo-500/50 focus:outline-none"
						/>
					</form>
					<select
						bind:value={severityFilter}
						onchange={resetPage}
						aria-label="Severity filter"
						class="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300 focus:border-indigo-500/50 focus:outline-none"
					>
						<option value="">All severities</option>
						<option value="info">Info</option>
						<option value="warning">Warning</option>
						<option value="critical">Critical</option>
					</select>
					<div class="flex items-center gap-1.5 text-xs text-zinc-500">
						<input
							type="date"
							bind:value={fromDate}
							onchange={resetPage}
							aria-label="From date"
							class="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300 focus:border-indigo-500/50 focus:outline-none [color-scheme:dark]"
						/>
						<span>–</span>
						<input
							type="date"
							bind:value={toDate}
							onchange={resetPage}
							aria-label="To date"
							class="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300 focus:border-indigo-500/50 focus:outline-none [color-scheme:dark]"
						/>
					</div>
					{#if actionFilter || severityFilter || fromDate || toDate}
						<button
							onclick={() => {
								actionInput = '';
								actionFilter = '';
								severityFilter = '';
								fromDate = '';
								toDate = '';
								offset = 0;
							}}
							class="text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
						>
							Clear filters
						</button>
					{/if}
				</div>
				{#if !$audit.isLoading}
					<div class="flex items-center gap-4 font-mono text-xs text-zinc-500">
						<span>{total.toLocaleString('en-US')} events</span>
						{#if critical > 0}
							<span class="flex items-center gap-1.5 text-rose-400">
								<span class="h-1.5 w-1.5 rounded-full bg-rose-500"></span>
								{critical} critical on page
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
			{:else if $audit.isError}
				<div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
					<AlertTriangle class="h-8 w-8 text-rose-400" />
					<p class="text-sm text-rose-300">Failed to load audit events. Please try again.</p>
				</div>
			{:else if logs.length === 0}
				<div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
					<ShieldCheck class="h-8 w-8 text-zinc-600" />
					<p class="text-sm text-zinc-400">
						{actionFilter || severityFilter || fromDate || toDate
							? 'No events match your filters.'
							: 'No audit events recorded yet.'}
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
							{#each logs as log, i (log.id)}
								{@const meta = severityMeta(log.severity)}
								{@const req = parseTarget(log.target)}
								<tr in:fade={{ delay: i * 15 }} class="transition-colors hover:bg-zinc-900/40">
									<td class="px-6 py-4 whitespace-nowrap text-zinc-500">{fmtTime(log.timestamp)}</td>
									<td class="px-6 py-4 font-sans text-zinc-200">{log.actor}</td>
									<td class="px-6 py-4">
										<span class={cn('rounded border px-2 py-0.5', meta.badge)}>{log.action}</span>
									</td>
									<td class="px-6 py-4 text-zinc-400">
										{#if req}
											<span class="flex items-center gap-1.5 whitespace-nowrap">
												<span
													class="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300"
												>
													{req.method}
												</span>
												<span class="max-w-[260px] truncate" title={req.path}>{req.path}</span>
												<span class={cn('font-semibold', statusColor(req.status))}>{req.status}</span>
											</span>
										{:else}
											{log.target}
										{/if}
									</td>
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

				<!-- Pager -->
				<div
					class="flex items-center justify-between border-t border-zinc-800 bg-zinc-900/30 px-6 py-3"
				>
					<span class="font-mono text-xs text-zinc-500">
						{pageStart.toLocaleString('en-US')}–{pageEnd.toLocaleString('en-US')} of
						{total.toLocaleString('en-US')}
					</span>
					<div class="flex items-center gap-2">
						<button
							onclick={() => (offset = Math.max(0, offset - PAGE_SIZE))}
							disabled={!hasPrev || $audit.isFetching}
							class="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
						>
							<ChevronLeft class="h-3.5 w-3.5" /> Prev
						</button>
						<button
							onclick={() => (offset = offset + PAGE_SIZE)}
							disabled={!hasNext || $audit.isFetching}
							class="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
						>
							Next <ChevronRight class="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
			{/if}
		</div>
	</div>

	<!-- Event detail slide-over -->
	{#if selected}
		{@const meta = severityMeta(selected.severity)}
		{@const req = parseTarget(selected.target)}
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
							{#if req}
								<div class="space-y-1.5 font-mono text-sm text-zinc-300">
									<div class="flex items-center gap-2">
										<span
											class="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300"
										>
											{req.method}
										</span>
										<span class={cn('text-xs font-semibold', statusColor(req.status))}>
											HTTP {req.status}
										</span>
									</div>
									<div class="break-all text-xs text-zinc-400">{req.path}</div>
								</div>
							{:else}
								<div class="font-mono text-sm text-zinc-300">{selected.target}</div>
							{/if}
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
